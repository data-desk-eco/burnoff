// VNF (VIIRS Nightfire) data module — queries a Parquet file (local or remote)
// via vendored DuckDB-WASM. Zero npm dependencies.

let db = null;
let conn = null;
let _initPromise = null;
let _ready = false;
let _parquetUrl = null;

export function isReady() { return _ready; }

/**
 * Initialize DuckDB-WASM and register the VNF parquet file.
 * @param {string} url - URL or local path to the parquet file
 */
export async function initVNF(url) {
    if (_initPromise) return _initPromise;
    _parquetUrl = url;
    _initPromise = _init(url);
    return _initPromise;
}

/** Reset state so initVNF can be called again with a different URL. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _parquetUrl = null;
    conn = null;
    db = null;
}

async function _init(url) {
    const duckdb = await import('./vendor/duckdb/duckdb-browser.mjs');

    // Use vendored EH (exception handling) bundle — all modern browsers support it.
    // Resolve to absolute URLs since the worker runs in a Blob context.
    const base = new URL('.', import.meta.url).href;
    const mainModule = base + 'vendor/duckdb/duckdb-eh.wasm';
    const mainWorker = base + 'vendor/duckdb/duckdb-browser-eh.worker.js';

    const workerBlob = new Blob([`importScripts("${mainWorker}");`], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(workerBlob));
    db = new duckdb.AsyncDuckDB({ log: () => {} }, worker);
    await db.instantiate(mainModule);

    conn = await db.connect();

    // For remote URLs, enable httpfs caching so row-group reads are efficient
    if (url.startsWith('https://')) {
        await conn.query(`SET enable_http_metadata_cache=true`);
        await conn.query(`SET enable_object_cache=true`);
    } else {
        // Local dev: fetch entire file and register as buffer
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        await db.registerFileBuffer(url, new Uint8Array(buf));
    }

    _ready = true;
}

/**
 * Query VNF sites within a bounding box and date range.
 * Returns a GeoJSON FeatureCollection with per-site aggregated data.
 */
export async function queryVNF(bbox, startDate, endDate) {
    if (!conn) throw new Error('VNF not initialized');

    const [west, south, east, north] = bbox;

    const result = await conn.query(`
        SELECT
            flare_id,
            FIRST(lat) AS lat,
            FIRST(lon) AS lon,
            COUNT(*) AS total_dates,
            COUNT(*) FILTER (WHERE clear) AS clear_dates,
            COUNT(*) FILTER (WHERE detected) AS detection_dates,
            AVG(rh_mw) FILTER (WHERE detected) AS avg_rh,
            MAX(rh_mw) FILTER (WHERE detected) AS max_rh,
            FIRST(type) FILTER (WHERE type != '') AS type,
            FIRST(category) FILTER (WHERE category != '') AS category,
            FIRST(country) FILTER (WHERE country != '') AS country,
            FIRST(facility_type) FILTER (WHERE facility_type != '') AS facility_type,
            FIRST(facility_name) FILTER (WHERE facility_name != '') AS facility_name,
            LIST(struct_pack(
                date := CAST(date AS VARCHAR),
                rh_mw := rh_mw,
                temp_k := temp_k
            ) ORDER BY date) FILTER (WHERE detected) AS detections
        FROM '${_parquetUrl}'
        WHERE lat BETWEEN ${south} AND ${north}
          AND lon BETWEEN ${west} AND ${east}
          AND date BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY flare_id
        HAVING COUNT(*) FILTER (WHERE detected) > 0
        ORDER BY max_rh DESC
    `);

    const features = [];
    for (let i = 0; i < result.numRows; i++) {
        const row = result.get(i);

        const detections = [];
        const rawDets = row.detections;
        if (rawDets) {
            for (let j = 0; j < rawDets.length; j++) {
                const d = typeof rawDets.get === 'function' ? rawDets.get(j) : rawDets[j];
                if (!d) continue;
                const obj = typeof d.toJSON === 'function' ? d.toJSON() : d;
                detections.push({
                    date: formatDuckDate(obj.date),
                    rh_mw: Number(obj.rh_mw) || 0,
                    temp_k: Number(obj.temp_k) || 0
                });
            }
        }

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(row.lon), Number(row.lat)] },
            properties: {
                flare_id: Number(row.flare_id),
                type: String(row.type || ''),
                category: String(row.category || ''),
                country: String(row.country || ''),
                facility_type: String(row.facility_type || ''),
                facility_name: String(row.facility_name || ''),
                total_dates: Number(row.total_dates) || 0,
                clear_dates: Number(row.clear_dates) || 0,
                detection_dates: Number(row.detection_dates) || 0,
                avg_rh: Number(row.avg_rh),
                max_rh: Number(row.max_rh),
                detections
            }
        });
    }

    return { type: 'FeatureCollection', features };
}

/**
 * Query a single VNF flare by ID (for deep links).
 * Returns a GeoJSON FeatureCollection with 0 or 1 features.
 */
export async function queryVNFFlare(flareId, startDate, endDate) {
    if (!conn) throw new Error('VNF not initialized');

    const result = await conn.query(`
        SELECT
            flare_id,
            FIRST(lat) AS lat,
            FIRST(lon) AS lon,
            COUNT(*) AS total_dates,
            COUNT(*) FILTER (WHERE clear) AS clear_dates,
            COUNT(*) FILTER (WHERE detected) AS detection_dates,
            AVG(rh_mw) FILTER (WHERE detected) AS avg_rh,
            MAX(rh_mw) FILTER (WHERE detected) AS max_rh,
            FIRST(type) FILTER (WHERE type != '') AS type,
            FIRST(category) FILTER (WHERE category != '') AS category,
            FIRST(country) FILTER (WHERE country != '') AS country,
            FIRST(facility_type) FILTER (WHERE facility_type != '') AS facility_type,
            FIRST(facility_name) FILTER (WHERE facility_name != '') AS facility_name,
            LIST(struct_pack(
                date := CAST(date AS VARCHAR),
                rh_mw := rh_mw,
                temp_k := temp_k
            ) ORDER BY date) FILTER (WHERE detected) AS detections
        FROM '${_parquetUrl}'
        WHERE flare_id = ${Number(flareId)}
          AND date BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY flare_id
    `);

    const features = [];
    for (let i = 0; i < result.numRows; i++) {
        const row = result.get(i);
        const detections = [];
        const rawDets = row.detections;
        if (rawDets) {
            for (let j = 0; j < rawDets.length; j++) {
                const d = typeof rawDets.get === 'function' ? rawDets.get(j) : rawDets[j];
                if (!d) continue;
                const obj = typeof d.toJSON === 'function' ? d.toJSON() : d;
                detections.push({
                    date: formatDuckDate(obj.date),
                    rh_mw: Number(obj.rh_mw) || 0,
                    temp_k: Number(obj.temp_k) || 0
                });
            }
        }
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(row.lon), Number(row.lat)] },
            properties: {
                flare_id: Number(row.flare_id),
                type: String(row.type || ''),
                category: String(row.category || ''),
                country: String(row.country || ''),
                facility_type: String(row.facility_type || ''),
                facility_name: String(row.facility_name || ''),
                total_dates: Number(row.total_dates) || 0,
                clear_dates: Number(row.clear_dates) || 0,
                detection_dates: Number(row.detection_dates) || 0,
                avg_rh: Number(row.avg_rh),
                max_rh: Number(row.max_rh),
                detections
            }
        });
    }
    return { type: 'FeatureCollection', features };
}

/** Format a DuckDB date value to YYYY-MM-DD string */
function formatDuckDate(d) {
    if (typeof d === 'string') return d.slice(0, 10);
    if (d instanceof Date) {
        return d.toISOString().slice(0, 10);
    }
    if (typeof d === 'number' || typeof d === 'bigint') {
        const ms = Number(d) * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
