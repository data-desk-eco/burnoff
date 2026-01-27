/**
 * Web Worker: Sentinel-2 SWIR flare detection (client-side).
 *
 * Port of src/burnoff/detect.py using L2A COGs from Element84 STAC.
 * Reads bands via geotiff.js windowed reads, runs DAFI v2 detection,
 * then cross-date clusters detections within 41m using Union-Find.
 */

importScripts(
    'https://unpkg.com/geotiff@2.1.3/dist-browser/geotiff.js',
    'https://unpkg.com/proj4@2.9.2/dist/proj4.js'
);

// Detection thresholds (matches detect.py)
const B12_MIN = 0.3;
const B11_MIN = 0.2;
const PEAK_B12_MIN = 0.50;
const CONTRAST_RATIO = 3.0;
const BACKGROUND_FLOOR = 0.15;
const PEAKEDNESS_MIN = 1.15;
const SATURATION = 1.0;
const MAX_PIXELS = 80;
const LARGE_PIXELS = 30;
const LARGE_B12_MIN = 0.70;
const WARM_FRACTION = 0.5;
const WARM_MAX_PIXELS = 100;
const MAX_CLOUD_LOCAL = 0.3;

const STAC_API = 'https://earth-search.aws.element84.com/v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progress(stage, pct) {
    self.postMessage({ type: 'progress', stage, pct: Math.round(pct) });
}

/** DN to surface reflectance for L2A (with offset). */
function dnToReflectance(dn) {
    return (dn - 1000) / 10000;
}

/** Compute UTM proj string from EPSG code. */
function utmProj(epsg) {
    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    return `+proj=utm +zone=${zone} ${isNorth ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
}

/** Convert WGS84 bbox [west, south, east, north] to UTM pixel window. */
function bboxToWindow(bbox, image, epsg) {
    const proj = utmProj(epsg);
    const sw = proj4('EPSG:4326', proj, [bbox[0], bbox[1]]);
    const ne = proj4('EPSG:4326', proj, [bbox[2], bbox[3]]);
    const utmBounds = [sw[0], sw[1], ne[0], ne[1]];

    const imgBbox = image.getBoundingBox();
    const width = image.getWidth();
    const height = image.getHeight();
    const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;
    const resX = (imgMaxX - imgMinX) / width;
    const resY = (imgMaxY - imgMinY) / height;

    const clippedMinX = Math.max(utmBounds[0], imgMinX);
    const clippedMinY = Math.max(utmBounds[1], imgMinY);
    const clippedMaxX = Math.min(utmBounds[2], imgMaxX);
    const clippedMaxY = Math.min(utmBounds[3], imgMaxY);

    const x0 = Math.max(0, Math.floor((clippedMinX - imgMinX) / resX));
    const y0 = Math.max(0, Math.floor((imgMaxY - clippedMaxY) / resY));
    const x1 = Math.min(width, Math.ceil((clippedMaxX - imgMinX) / resX));
    const y1 = Math.min(height, Math.ceil((imgMaxY - clippedMinY) / resY));

    return {
        window: [x0, y0, x1, y1],
        actualUtmBounds: [
            imgMinX + x0 * resX,
            imgMaxY - y1 * resY,
            imgMinX + x1 * resX,
            imgMaxY - y0 * resY
        ],
        w: x1 - x0,
        h: y1 - y0
    };
}

/** Read a single band from a COG URL within a pixel window. Returns Float32Array. */
async function readBand(url, windowArr) {
    const [x0, y0, x1, y1] = windowArr;
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false });
    const image = await tiff.getImage();
    const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
    return { data: rasters[0], width: rasters.width, height: rasters.height };
}

// ---------------------------------------------------------------------------
// Connected components (BFS, 4-connectivity)
// ---------------------------------------------------------------------------

function labelConnectedComponents(mask, width, height) {
    const labels = new Int32Array(width * height);
    let nextLabel = 1;

    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || labels[i]) continue;
        // BFS
        const queue = [i];
        labels[i] = nextLabel;
        let head = 0;
        while (head < queue.length) {
            const idx = queue[head++];
            const r = Math.floor(idx / width);
            const c = idx % width;
            const neighbors = [];
            if (r > 0) neighbors.push(idx - width);
            if (r < height - 1) neighbors.push(idx + width);
            if (c > 0) neighbors.push(idx - 1);
            if (c < width - 1) neighbors.push(idx + 1);
            for (const n of neighbors) {
                if (mask[n] && !labels[n]) {
                    labels[n] = nextLabel;
                    queue.push(n);
                }
            }
        }
        nextLabel++;
    }
    return { labels, count: nextLabel - 1 };
}

// ---------------------------------------------------------------------------
// STAC search
// ---------------------------------------------------------------------------

async function searchSTAC(bbox, maxCloud) {
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const startDate = sixMonthsAgo.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    const payload = {
        collections: ['sentinel-2-l2a'],
        bbox,
        datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
        limit: 100,
        query: { 'eo:cloud_cover': { lt: maxCloud } }
    };

    let items = [];
    let url = `${STAC_API}/search`;
    let body = payload;

    while (url) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error(`STAC search failed: ${resp.status}`);
        const data = await resp.json();
        items = items.concat(data.features || []);

        const nextLink = (data.links || []).find(l => l.rel === 'next');
        if (nextLink && nextLink.body) {
            url = nextLink.href;
            body = nextLink.body;
        } else {
            url = null;
        }
    }

    // Deduplicate by MGRS tile + date: keep lowest cloud cover per tile per date.
    // Different tiles cover different areas, so deduplicating across tiles
    // can discard the tile that actually covers the target location.
    const byTileDate = {};
    for (const item of items) {
        const dt = item.properties.datetime.slice(0, 10);
        const cloud = item.properties['eo:cloud_cover'] ?? 100;
        const tile = item.properties['grid:code'] || item.properties['s2:mgrs_tile'] || item.id;
        const key = `${tile}_${dt}`;
        if (!byTileDate[key] || cloud < byTileDate[key].cloud) {
            byTileDate[key] = { item, cloud };
        }
    }

    return Object.values(byTileDate).map(e => e.item);
}

// ---------------------------------------------------------------------------
// Per-image processing (port of _process_image)
// ---------------------------------------------------------------------------

async function processImage(item, bbox, epsg) {
    const assets = item.assets;
    const b12Url = assets.swir22?.href;
    const b11Url = assets.swir16?.href;
    const b8aUrl = assets.nir08?.href;
    const sclUrl = assets.scl?.href;
    if (!b12Url || !b11Url) return [];

    const imgDate = item.properties.datetime.slice(0, 10);
    const sunElevation = item.properties['view:sun_elevation'] ?? null;
    const itemEpsg = item.properties['proj:epsg'] || epsg;

    // Open B12 to get image geometry for windowing
    const b12Tiff = await GeoTIFF.fromUrl(b12Url, { allowFullFile: false });
    const b12Image = await b12Tiff.getImage();
    const winInfo = bboxToWindow(bbox, b12Image, itemEpsg);
    if (winInfo.w <= 0 || winInfo.h <= 0) return [];

    // 1. Read B12 (needed for cloud check and detection)
    const b12Raw = await readBand(b12Url, winInfo.window);
    if (!b12Raw) return [];
    const b11Raw = await readBand(b11Url, winInfo.window);
    if (!b11Raw) return [];

    // 2. Check cloud cover via SCL, excluding bright SWIR pixels.
    //    SCL often misclassifies flare pixels as cloud/cirrus. With a small
    //    window (zoomed in) those pixels dominate the cloud fraction and cause
    //    the image to be skipped. Exclude pixels where B12 DN is high enough
    //    to be a candidate flare — they should not count as cloud.
    const B12_DN_BRIGHT = B12_MIN * 10000 + 1000; // DN equivalent of B12_MIN
    if (sclUrl) {
        try {
            const sclData = await readBand(sclUrl, winInfo.window);
            if (sclData) {
                let cloudPixels = 0;
                let countable = 0;
                for (let i = 0; i < sclData.data.length; i++) {
                    // Skip bright SWIR pixels — likely flare, not cloud
                    if (b12Raw.data[i] >= B12_DN_BRIGHT) continue;
                    countable++;
                    const v = sclData.data[i];
                    if (v === 3 || v === 8 || v === 9 || v === 10) cloudPixels++;
                }
                if (countable > 0 && cloudPixels / countable > MAX_CLOUD_LOCAL) return [];
            }
        } catch (e) {
            // If SCL fails, continue without cloud mask
        }
    }

    let b8aRaw = null;
    if (b8aUrl) {
        try { b8aRaw = await readBand(b8aUrl, winInfo.window); } catch (e) { /* skip */ }
    }

    const w = b12Raw.width, h = b12Raw.height;
    const n = w * h;

    // Convert to reflectance
    const b12 = new Float32Array(n);
    const b11 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        b12[i] = dnToReflectance(b12Raw.data[i]);
        b11[i] = dnToReflectance(b11Raw.data[i]);
    }
    let b8a = null;
    if (b8aRaw) {
        b8a = new Float32Array(n);
        for (let i = 0; i < n; i++) b8a[i] = dnToReflectance(b8aRaw.data[i]);
    }

    // 3. Brightness filter
    const bright = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        bright[i] = (b12[i] > B12_MIN && b11[i] > B11_MIN) ? 1 : 0;
    }

    // 4. Contrast filter: B12 > median(background) * CONTRAST_RATIO
    const bgPixels = [];
    for (let i = 0; i < n; i++) {
        if (b12[i] < B12_MIN) bgPixels.push(b12[i]);
    }
    if (bgPixels.length < 10) return [];
    bgPixels.sort((a, b) => a - b);
    const medianBg = bgPixels[Math.floor(bgPixels.length / 2)];
    const bgBaseline = Math.max(medianBg, BACKGROUND_FLOOR);
    const contrastThresh = bgBaseline * CONTRAST_RATIO;

    const contrast = new Uint8Array(n);
    for (let i = 0; i < n; i++) contrast[i] = b12[i] > contrastThresh ? 1 : 0;

    // 5. Thermal filter: NHISWNIR > 0 or saturation
    const thermal = new Uint8Array(n);
    if (b8a) {
        for (let i = 0; i < n; i++) {
            const denom = b11[i] + b8a[i];
            const nhiswnir = denom > 0.01 ? (b11[i] - b8a[i]) / denom : 0;
            thermal[i] = (nhiswnir > 0 || b11[i] > SATURATION || b12[i] > SATURATION) ? 1 : 0;
        }
    } else {
        for (let i = 0; i < n; i++) thermal[i] = b11[i] > SATURATION ? 1 : 0;
    }

    // Combined mask
    const mask = new Uint8Array(n);
    let anyMask = false;
    for (let i = 0; i < n; i++) {
        mask[i] = bright[i] & contrast[i] & thermal[i];
        if (mask[i]) anyMask = true;
    }
    if (!anyMask) return [];

    // 6. Connected components
    const { labels, count } = labelConnectedComponents(mask, w, h);
    if (count === 0) return [];

    // UTM projection for coordinate conversion
    const projStr = utmProj(itemEpsg);
    const [utmMinX, utmMinY, utmMaxX, utmMaxY] = winInfo.actualUtmBounds;

    const detections = [];
    for (let labelId = 1; labelId <= count; labelId++) {
        // Collect cluster pixels
        let nPixels = 0;
        let peakB12 = -Infinity;
        let peakIdx = -1;
        let sumB12 = 0;

        for (let i = 0; i < n; i++) {
            if (labels[i] !== labelId) continue;
            nPixels++;
            sumB12 += b12[i];
            if (b12[i] > peakB12) { peakB12 = b12[i]; peakIdx = i; }
        }

        if (nPixels > MAX_PIXELS) continue;
        if (peakB12 < PEAK_B12_MIN) continue;
        if (nPixels > LARGE_PIXELS && peakB12 < LARGE_B12_MIN) continue;

        const avgB12 = sumB12 / nPixels;

        // Peakedness filter
        if (nPixels > 1 && peakB12 < PEAKEDNESS_MIN * avgB12) continue;

        // Single pixel confidence
        if (nPixels === 1 && peakB12 < 0.65) continue;

        // Warm region (point source) filter
        const peakRow = Math.floor(peakIdx / w);
        const peakCol = peakIdx % w;
        const warmThresh = peakB12 * WARM_FRACTION;
        const warmMask = new Uint8Array(n);
        for (let i = 0; i < n; i++) warmMask[i] = b12[i] > warmThresh ? 1 : 0;
        const warmLabels = labelConnectedComponents(warmMask, w, h);
        const warmLabel = warmLabels.labels[peakIdx];
        let warmSize = 0;
        for (let i = 0; i < n; i++) {
            if (warmLabels.labels[i] === warmLabel) warmSize++;
        }
        if (warmSize > WARM_MAX_PIXELS) continue;

        // Convert pixel to WGS84
        const colFrac = (peakCol + 0.5) / w;
        const rowFrac = (peakRow + 0.5) / h;
        const utmX = utmMinX + colFrac * (utmMaxX - utmMinX);
        const utmY = utmMaxY - rowFrac * (utmMaxY - utmMinY);
        const [flareLon, flareLat] = proj4(projStr, 'EPSG:4326', [utmX, utmY]);

        detections.push({
            date: imgDate,
            max_b12: peakB12,
            pixels: nPixels,
            flare_lon: flareLon,
            flare_lat: flareLat,
            avg_b12: avgB12,
            epsg: itemEpsg,
            cog_b12: b12Url,
            sun_elevation: sunElevation,
            utm_bounds: winInfo.actualUtmBounds
        });
    }

    return detections;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Pad a bbox to a minimum extent in degrees for stable background statistics.
 *  The detection algorithm computes background median over the window — too
 *  small a window (zoomed in) shifts the median and changes results. */
function ensureMinBbox(bbox, minDeg) {
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const halfW = Math.max((bbox[2] - bbox[0]) / 2, minDeg / 2);
    const halfH = Math.max((bbox[3] - bbox[1]) / 2, minDeg / 2);
    return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

// Minimum processing extent (~2.5 km each way) so background stats are stable
const MIN_PROCESS_EXTENT_DEG = 0.045;

self.onmessage = async function(e) {
    const { bbox, epsg } = e.data;

    // Use viewport bbox for STAC search (find relevant images),
    // but a padded bbox for per-image processing (stable background stats).
    const processBbox = ensureMinBbox(bbox, MIN_PROCESS_EXTENT_DEG);

    try {
        progress('Searching STAC catalog...', 0);
        const items = await searchSTAC(bbox, 30);

        if (items.length === 0) {
            self.postMessage({ type: 'done', stats: { images: 0, rawDetections: 0 } });
            return;
        }

        progress(`Found ${items.length} images`, 5);

        let totalDetections = 0;
        for (let i = 0; i < items.length; i++) {
            const pct = 5 + (i / items.length) * 90;
            const dt = items[i].properties.datetime.slice(0, 10);
            progress(`Processing ${dt}`, pct);

            try {
                const dets = await processImage(items[i], processBbox, epsg);
                if (dets.length > 0) {
                    totalDetections += dets.length;
                    self.postMessage({ type: 'detections', detections: dets });
                }
            } catch (err) {
                console.warn(`Failed to process image ${dt}:`, err);
            }
        }

        self.postMessage({
            type: 'done',
            stats: { images: items.length, rawDetections: totalDetections }
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
