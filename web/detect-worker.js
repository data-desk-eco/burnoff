/**
 * Burnoff Detection Web Worker
 *
 * Runs flare detection algorithm in a background thread.
 * Uses geotiff.js to load COG imagery and computes connected components.
 *
 * Messages:
 *   { type: 'detect', cogUrl, bounds, epsg, tileId, date }
 *   -> { type: 'result', detections, imageHash, tileId, date, cogUrl }
 *   -> { type: 'error', message, tileId, date }
 */

importScripts('https://unpkg.com/geotiff@2.1.3/dist-browser/geotiff.js');

// Detection thresholds (from Python detect.py)
const CONNECTIVITY_B12 = 0.75;  // Bright region threshold
const MIN_PEAK_B12 = 0.50;      // Minimum peak for valid detection

/**
 * Connected component labeling using flood fill.
 * Returns Int32Array of labels (0 = background, 1+ = component IDs)
 */
function labelConnectedComponents(binary, width, height) {
  const labels = new Int32Array(binary.length);
  let nextLabel = 1;

  const stack = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (binary[i] && !labels[i]) {
        // Flood fill from this pixel
        stack.push(x, y);
        while (stack.length > 0) {
          const cy = stack.pop();
          const cx = stack.pop();
          if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
          const ci = cy * width + cx;
          if (!binary[ci] || labels[ci]) continue;
          labels[ci] = nextLabel;
          stack.push(cx + 1, cy);
          stack.push(cx - 1, cy);
          stack.push(cx, cy + 1);
          stack.push(cx, cy - 1);
        }
        nextLabel++;
      }
    }
  }

  return { labels, numComponents: nextLabel - 1 };
}

/**
 * Compute SHA-256 hash of array buffer.
 */
async function computeHash(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert pixel coordinates to lon/lat.
 */
function pixelToLonLat(col, row, imageBounds, width, height, toWgs84) {
  const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imageBounds;
  const x = imgMinX + (col + 0.5) / width * (imgMaxX - imgMinX);
  const y = imgMaxY - (row + 0.5) / height * (imgMaxY - imgMinY);
  return toWgs84(x, y);
}

/**
 * Simple UTM to WGS84 conversion (approximate, good enough for display).
 * For proper transforms, we'd use proj4 but it's heavy for a worker.
 */
function createUtmToWgs84(epsg) {
  const zone = epsg % 100;
  const isNorth = epsg < 32700;

  // UTM parameters
  const k0 = 0.9996;
  const a = 6378137; // WGS84 semi-major axis
  const e2 = 0.00669438; // WGS84 eccentricity squared
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const ep2 = e2 / (1 - e2);

  const lon0 = (zone - 1) * 6 - 180 + 3; // Central meridian

  return function(x, y) {
    const x0 = x - 500000;
    const y0 = isNorth ? y : y - 10000000;

    const M = y0 / k0;
    const mu = M / (a * (1 - e2/4 - 3*e4/64 - 5*e6/256));

    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const phi1 = mu + (3*e1/2 - 27*e1*e1*e1/32) * Math.sin(2*mu)
                    + (21*e1*e1/16 - 55*e1*e1*e1*e1/32) * Math.sin(4*mu)
                    + (151*e1*e1*e1/96) * Math.sin(6*mu);

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = sinPhi1 / cosPhi1;
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const T1 = tanPhi1 * tanPhi1;
    const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D = x0 / (N1 * k0);

    const lat = phi1 - (N1 * tanPhi1 / R1) * (D*D/2 - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * D*D*D*D/24
                + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D*D*D*D*D*D/720);

    const lon = lon0 + (D - (1 + 2*T1 + C1) * D*D*D/6
                + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * D*D*D*D*D/120) / cosPhi1;

    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
  };
}

/**
 * Main detection function.
 */
async function detect(cogUrl, windowBounds, epsg, tileId, date) {
  // Load COG
  const tiff = await GeoTIFF.fromUrl(cogUrl, { allowFullFile: false });
  const image = await tiff.getImage();

  const imgBbox = image.getBoundingBox();
  const imgWidth = image.getWidth();
  const imgHeight = image.getHeight();
  const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;
  const resX = (imgMaxX - imgMinX) / imgWidth;
  const resY = (imgMaxY - imgMinY) / imgHeight;

  // Calculate window in image coordinates
  const [minX, minY, maxX, maxY] = windowBounds;
  const x0 = Math.max(0, Math.floor((minX - imgMinX) / resX));
  const y0 = Math.max(0, Math.floor((imgMaxY - maxY) / resY));
  const x1 = Math.min(imgWidth, Math.ceil((maxX - imgMinX) / resX));
  const y1 = Math.min(imgHeight, Math.ceil((imgMaxY - minY) / resY));

  const windowWidth = x1 - x0;
  const windowHeight = y1 - y0;

  if (windowWidth <= 0 || windowHeight <= 0) {
    return { detections: [], imageHash: null };
  }

  // Read raster data
  const rasters = await image.readRasters({
    window: [x0, y0, x1, y1],
  });

  const data = rasters[0];
  const width = rasters.width;
  const height = rasters.height;

  // Compute image hash for proof-of-work
  const imageHash = await computeHash(data.buffer);

  // Actual bounds of the window we read
  const actualBounds = [
    imgMinX + x0 * resX,
    imgMaxY - y1 * resY,
    imgMinX + x1 * resX,
    imgMaxY - y0 * resY,
  ];

  // Convert to reflectance (L2A COG stores as DN * 10000)
  const reflectance = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    reflectance[i] = data[i] * 0.0001;
  }

  // Find bright pixels
  const bright = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bright[i] = reflectance[i] >= CONNECTIVITY_B12 ? 1 : 0;
  }

  // Check if any bright pixels
  let hasBright = false;
  for (let i = 0; i < bright.length; i++) {
    if (bright[i]) { hasBright = true; break; }
  }

  if (!hasBright) {
    return { detections: [], imageHash };
  }

  // Connected components
  const { labels, numComponents } = labelConnectedComponents(bright, width, height);

  // Coordinate transformer
  const toWgs84 = createUtmToWgs84(epsg);

  // Extract component stats
  const detections = [];

  for (let label = 1; label <= numComponents; label++) {
    let sumX = 0, sumY = 0, count = 0;
    let maxB12 = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (labels[i] === label) {
          sumX += x;
          sumY += y;
          count++;
          if (reflectance[i] > maxB12) {
            maxB12 = reflectance[i];
          }
        }
      }
    }

    if (count === 0 || maxB12 < MIN_PEAK_B12) continue;

    // Centroid
    const centroidX = sumX / count;
    const centroidY = sumY / count;

    // Convert to lon/lat
    const [lon, lat] = pixelToLonLat(centroidX, centroidY, actualBounds, width, height, toWgs84);

    detections.push({
      lon,
      lat,
      max_b12: maxB12,
      pixels: count,
    });
  }

  return { detections, imageHash };
}

// Message handler
self.onmessage = async function(e) {
  const { type, cogUrl, bounds, epsg, tileId, date } = e.data;

  if (type === 'detect') {
    try {
      const result = await detect(cogUrl, bounds, epsg, tileId, date);
      self.postMessage({
        type: 'result',
        ...result,
        tileId,
        date,
        cogUrl,
        epsg,
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: err.message,
        tileId,
        date,
      });
    }
  }
};
