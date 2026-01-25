/**
 * Burnoff Detection Cache API
 *
 * Cloudflare Worker + D1 for storing and serving client-detected flares.
 *
 * Endpoints:
 *   POST /scan-complete  - Submit scan results (tile + detections)
 *   GET  /detections     - Query cached detections by bbox/tile
 *   GET  /tiles          - Query which tiles have been scanned
 *   GET  /health         - Health check
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Check rate limit for client IP.
 * Returns { allowed: boolean, remaining: number }
 */
async function checkRateLimit(db, clientIp, windowSeconds = 60, maxRequests = 30) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  // Get current count
  const result = await db.prepare(`
    SELECT count, window_start FROM rate_limits WHERE client_ip = ?
  `).bind(clientIp).first();

  if (!result || result.window_start < windowStart) {
    // New window or expired - reset
    await db.prepare(`
      INSERT INTO rate_limits (client_ip, window_start, count)
      VALUES (?, ?, 1)
      ON CONFLICT(client_ip) DO UPDATE SET window_start = ?, count = 1
    `).bind(clientIp, now.toISOString(), now.toISOString()).run();
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (result.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  // Increment count
  await db.prepare(`
    UPDATE rate_limits SET count = count + 1 WHERE client_ip = ?
  `).bind(clientIp).run();

  return { allowed: true, remaining: maxRequests - result.count - 1 };
}

/**
 * POST /scan-complete
 *
 * Submit scan results for a tile+date.
 * Body: {
 *   tile_id: string,      // S2 MGRS tile
 *   date: string,         // ISO date
 *   image_hash: string,   // SHA-256 of B12 raster (proof of fetch)
 *   epsg: number,         // UTM zone
 *   cog_url: string,      // B12 COG URL
 *   detections: [{ lon, lat, max_b12, pixels }]
 * }
 */
async function handleScanComplete(request, env) {
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Rate limit
  const rateLimit = await checkRateLimit(
    env.DB,
    clientIp,
    parseInt(env.RATE_LIMIT_WINDOW_SECONDS || '60'),
    parseInt(env.RATE_LIMIT_MAX_REQUESTS || '30')
  );

  if (!rateLimit.allowed) {
    return errorResponse('Rate limit exceeded', 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON');
  }

  const { tile_id, date, image_hash, detections, epsg, cog_url } = body;

  // Validate required fields
  if (!tile_id || !date || !image_hash) {
    return errorResponse('Missing required fields: tile_id, date, image_hash');
  }

  if (!Array.isArray(detections)) {
    return errorResponse('detections must be an array');
  }

  // Validate image_hash format (should be 64-char hex)
  if (!/^[a-f0-9]{64}$/i.test(image_hash)) {
    return errorResponse('Invalid image_hash format');
  }

  // Check if this exact scan was already submitted
  const existingScan = await env.DB.prepare(`
    SELECT id FROM scanned_tiles WHERE tile_id = ? AND date = ? AND image_hash = ?
  `).bind(tile_id, date, image_hash).first();

  if (existingScan) {
    // Same image hash = same client or same imagery, increment consensus on detections
    for (const det of detections) {
      await env.DB.prepare(`
        UPDATE detections
        SET consensus = consensus + 1, last_confirmed = datetime('now')
        WHERE tile_id = ? AND date = ?
          AND ABS(lon - ?) < 0.0005 AND ABS(lat - ?) < 0.0005
      `).bind(tile_id, date, det.lon, det.lat).run();
    }

    return jsonResponse({ status: 'consensus_updated', tile_id, date });
  }

  // Insert scanned tile record
  await env.DB.prepare(`
    INSERT INTO scanned_tiles (tile_id, date, image_hash, client_ip)
    VALUES (?, ?, ?, ?)
  `).bind(tile_id, date, image_hash, clientIp).run();

  // Insert or update detections
  let inserted = 0;
  let updated = 0;

  for (const det of detections) {
    if (typeof det.lon !== 'number' || typeof det.lat !== 'number' ||
        typeof det.max_b12 !== 'number' || typeof det.pixels !== 'number') {
      continue; // Skip invalid detections
    }

    // Check for existing detection at similar location
    const existing = await env.DB.prepare(`
      SELECT id FROM detections
      WHERE tile_id = ? AND date = ?
        AND ABS(lon - ?) < 0.0005 AND ABS(lat - ?) < 0.0005
    `).bind(tile_id, date, det.lon, det.lat).first();

    if (existing) {
      // Update consensus
      await env.DB.prepare(`
        UPDATE detections
        SET consensus = consensus + 1,
            last_confirmed = datetime('now'),
            max_b12 = MAX(max_b12, ?)
        WHERE id = ?
      `).bind(det.max_b12, existing.id).run();
      updated++;
    } else {
      // Insert new detection
      await env.DB.prepare(`
        INSERT INTO detections (tile_id, date, lon, lat, max_b12, pixels, image_hash, cog_url, epsg)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(tile_id, date, det.lon, det.lat, det.max_b12, det.pixels, image_hash, cog_url || null, epsg || null).run();
      inserted++;
    }
  }

  return jsonResponse({
    status: 'ok',
    tile_id,
    date,
    inserted,
    updated,
    remaining_requests: rateLimit.remaining,
  });
}

/**
 * GET /detections
 *
 * Query detections by bounding box or tile.
 * Params:
 *   bbox: minLon,minLat,maxLon,maxLat
 *   tile_id: S2 MGRS tile
 *   after: ISO date (only detections after this date)
 *   min_consensus: minimum consensus count (default 1)
 *   limit: max results (default 1000)
 */
async function handleGetDetections(request, env) {
  const url = new URL(request.url);
  const bbox = url.searchParams.get('bbox');
  const tileId = url.searchParams.get('tile_id');
  const after = url.searchParams.get('after');
  const minConsensus = parseInt(url.searchParams.get('min_consensus') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000'), 5000);

  let query = 'SELECT * FROM detections WHERE consensus >= ?';
  const params = [minConsensus];

  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(parseFloat);
    if ([minLon, minLat, maxLon, maxLat].some(isNaN)) {
      return errorResponse('Invalid bbox format');
    }
    query += ' AND lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?';
    params.push(minLon, maxLon, minLat, maxLat);
  }

  if (tileId) {
    query += ' AND tile_id = ?';
    params.push(tileId);
  }

  if (after) {
    query += ' AND date > ?';
    params.push(after);
  }

  query += ' ORDER BY date DESC LIMIT ?';
  params.push(limit);

  const stmt = env.DB.prepare(query);
  const results = await stmt.bind(...params).all();

  return jsonResponse({
    count: results.results.length,
    detections: results.results,
  });
}

/**
 * GET /tiles
 *
 * Query which tiles have been scanned.
 * Params:
 *   bbox: minLon,minLat,maxLon,maxLat (approximate, uses tile center)
 *   after: ISO date
 */
async function handleGetTiles(request, env) {
  const url = new URL(request.url);
  const after = url.searchParams.get('after');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 2000);

  let query = 'SELECT DISTINCT tile_id, date FROM scanned_tiles';
  const params = [];

  if (after) {
    query += ' WHERE date > ?';
    params.push(after);
  }

  query += ' ORDER BY date DESC LIMIT ?';
  params.push(limit);

  const stmt = env.DB.prepare(query);
  const results = await stmt.bind(...params).all();

  // Group by tile_id
  const tiles = {};
  for (const row of results.results) {
    if (!tiles[row.tile_id]) {
      tiles[row.tile_id] = [];
    }
    tiles[row.tile_id].push(row.date);
  }

  return jsonResponse({
    count: Object.keys(tiles).length,
    tiles,
  });
}

/**
 * Main request handler
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/scan-complete' && request.method === 'POST') {
        return await handleScanComplete(request, env);
      }

      if (path === '/detections' && request.method === 'GET') {
        return await handleGetDetections(request, env);
      }

      if (path === '/tiles' && request.method === 'GET') {
        return await handleGetTiles(request, env);
      }

      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Internal server error', 500);
    }
  },
};
