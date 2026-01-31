/**
 * Web Worker: Sentinel-2 SWIR flare detection (client-side).
 *
 * Processing uses fixed-size pixel blocks (256x256) within each Sentinel-2
 * COG tile for deterministic results regardless of viewport/zoom level.
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
const B12_DN_BRIGHT = B12_MIN * 10000 + 1000;

// Block processing constants
const BLOCK_SIZE = 256;      // pixels (5.12 km at 20m)
const BLOCK_OVERLAP = 10;    // pixels (200m) per edge for flare-straddling

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

/** Read a windowed region from an already-opened GeoTIFF image. */
async function readWindow(image, windowArr) {
    const [x0, y0, x1, y1] = windowArr;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
    const rasters = await image.readRasters({ window: windowArr });
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

async function searchSTAC(bbox, maxCloud, startDate, endDate) {
    if (!startDate || !endDate) {
        const now = new Date();
        const sixMonthsAgo = new Date(now);
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        startDate = sixMonthsAgo.toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
    }

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
// Per-block detection pipeline
// ---------------------------------------------------------------------------

/**
 * Run detection on a single block window. Returns detections with
 * _peakImgRow/_peakImgCol for overlap dedup by the caller.
 */
async function processBlock(opts) {
    const {
        b12Image, b11Image, b8aImage, sclImage,
        windowArr, imgDate, sunElevation, itemEpsg,
        imgMinX, imgMaxY, resX, resY,
        blockId, b12Url
    } = opts;

    const [x0, y0, x1, y1] = windowArr;
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return [];

    // 1. Read B12, B11
    const b12Raw = await readWindow(b12Image, windowArr);
    if (!b12Raw) return [];
    const b11Raw = await readWindow(b11Image, windowArr);
    if (!b11Raw) return [];

    // 2. Cloud check via SCL, excluding bright SWIR pixels
    if (sclImage) {
        try {
            const sclData = await readWindow(sclImage, windowArr);
            if (sclData) {
                let cloudPixels = 0, countable = 0;
                for (let i = 0; i < sclData.data.length; i++) {
                    if (b12Raw.data[i] >= B12_DN_BRIGHT) continue;
                    countable++;
                    const v = sclData.data[i];
                    if (v === 3 || v === 8 || v === 9 || v === 10) cloudPixels++;
                }
                if (countable > 0 && cloudPixels / countable > MAX_CLOUD_LOCAL) return [];
            }
        } catch (e) { /* skip */ }
    }

    let b8aRaw = null;
    if (b8aImage) {
        try { b8aRaw = await readWindow(b8aImage, windowArr); } catch (e) { /* skip */ }
    }

    const n = w * h;

    // Pre-pass: convert B12 to reflectance and collect background for median
    const b12 = new Float32Array(n);
    const bgPixels = [];
    for (let i = 0; i < n; i++) {
        const v = (b12Raw.data[i] - 1000) / 10000;
        b12[i] = v;
        if (v < B12_MIN) bgPixels.push(v);
    }
    if (bgPixels.length < 10) return [];
    bgPixels.sort((a, b) => a - b);
    const medianBg = bgPixels[Math.floor(bgPixels.length / 2)];
    const contrastThresh = Math.max(medianBg, BACKGROUND_FLOOR) * CONTRAST_RATIO;

    // Fused pass: DN→reflectance for B11/B8A + brightness + contrast + thermal → mask
    const b11 = new Float32Array(n);
    const mask = new Uint8Array(n);
    let anyMask = false;
    const hasB8a = !!b8aRaw;
    for (let i = 0; i < n; i++) {
        const b11v = (b11Raw.data[i] - 1000) / 10000;
        b11[i] = b11v;
        const b12v = b12[i];
        // Brightness
        if (b12v <= B12_MIN || b11v <= B11_MIN) continue;
        // Contrast
        if (b12v <= contrastThresh) continue;
        // Thermal
        if (hasB8a) {
            const b8av = (b8aRaw.data[i] - 1000) / 10000;
            const denom = b11v + b8av;
            const nhiswnir = denom > 0.01 ? (b11v - b8av) / denom : 0;
            if (!(nhiswnir > 0 || b11v > SATURATION || b12v > SATURATION)) continue;
        } else {
            if (b11v <= SATURATION) continue;
        }
        mask[i] = 1;
        anyMask = true;
    }
    if (!anyMask) return [];

    // 6. Connected components
    const { labels, count } = labelConnectedComponents(mask, w, h);
    if (count === 0) return [];

    // UTM projection for coordinate conversion
    const projStr = utmProj(itemEpsg);
    const utmMinX = imgMinX + x0 * resX;
    const utmMinY = imgMaxY - y1 * resY;
    const utmMaxX = imgMinX + x1 * resX;
    const utmMaxY_w = imgMaxY - y0 * resY;

    const detections = [];
    for (let labelId = 1; labelId <= count; labelId++) {
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

        // Peakedness filter (bypass for saturated components)
        if (nPixels > 1 && peakB12 < PEAKEDNESS_MIN * avgB12 && avgB12 < SATURATION) continue;

        // Single pixel confidence
        if (nPixels === 1 && peakB12 < 0.65) continue;

        // Warm region (point source) filter — BFS from peak pixel over
        // b12 > warmThresh, counting reachable pixels without a full CC pass.
        const peakRow = Math.floor(peakIdx / w);
        const peakCol = peakIdx % w;
        const warmThresh = peakB12 * WARM_FRACTION;
        let warmSize = 0;
        if (b12[peakIdx] > warmThresh) {
            const visited = new Uint8Array(n);
            const q = [peakIdx];
            visited[peakIdx] = 1;
            let head = 0;
            while (head < q.length) {
                warmSize++;
                if (warmSize > WARM_MAX_PIXELS) break;
                const idx = q[head++];
                const r = Math.floor(idx / w), c = idx % w;
                if (r > 0 && !visited[idx - w] && b12[idx - w] > warmThresh) { visited[idx - w] = 1; q.push(idx - w); }
                if (r < h - 1 && !visited[idx + w] && b12[idx + w] > warmThresh) { visited[idx + w] = 1; q.push(idx + w); }
                if (c > 0 && !visited[idx - 1] && b12[idx - 1] > warmThresh) { visited[idx - 1] = 1; q.push(idx - 1); }
                if (c < w - 1 && !visited[idx + 1] && b12[idx + 1] > warmThresh) { visited[idx + 1] = 1; q.push(idx + 1); }
            }
        }
        if (warmSize > WARM_MAX_PIXELS) continue;

        // Convert pixel to WGS84
        const colFrac = (peakCol + 0.5) / w;
        const rowFrac = (peakRow + 0.5) / h;
        const utmX = utmMinX + colFrac * (utmMaxX - utmMinX);
        const utmY = utmMaxY_w - rowFrac * (utmMaxY_w - utmMinY);
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
            utm_bounds: [utmMinX, utmMinY, utmMaxX, utmMaxY_w],
            block_id: blockId,
            _peakImgRow: y0 + peakRow,
            _peakImgCol: x0 + peakCol
        });
    }

    return detections;
}

// ---------------------------------------------------------------------------
// Block-based image processing
// ---------------------------------------------------------------------------

async function processImageBlocks(item, viewportBbox, epsg, cachedBlockDates, onEnumerated, onBlockDone) {
    const assets = item.assets;
    const b12Url = assets.swir22?.href;
    const b11Url = assets.swir16?.href;
    const b8aUrl = assets.nir08?.href;
    const sclUrl = assets.scl?.href;
    if (!b12Url || !b11Url) return [];

    const imgDate = item.properties.datetime.slice(0, 10);
    const sunElevation = item.properties['view:sun_elevation'] ?? null;
    const itemEpsg = item.properties['proj:epsg'] || epsg;
    const mgrs = (item.properties['grid:code'] || '').replace('MGRS-', '')
              || item.properties['s2:mgrs_tile']
              || item.id;

    // Open B12 for image geometry
    const b12Tiff = await GeoTIFF.fromUrl(b12Url, { allowFullFile: false });
    const b12Image = await b12Tiff.getImage();

    const imgBbox = b12Image.getBoundingBox();
    const imgWidth = b12Image.getWidth();
    const imgHeight = b12Image.getHeight();
    const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;
    const resX = (imgMaxX - imgMinX) / imgWidth;
    const resY = (imgMaxY - imgMinY) / imgHeight;

    // Convert viewport bbox to pixel range
    const proj = utmProj(itemEpsg);
    const sw = proj4('EPSG:4326', proj, [viewportBbox[0], viewportBbox[1]]);
    const ne = proj4('EPSG:4326', proj, [viewportBbox[2], viewportBbox[3]]);

    const px0 = Math.max(0, Math.floor((Math.max(sw[0], imgMinX) - imgMinX) / resX));
    const py0 = Math.max(0, Math.floor((imgMaxY - Math.min(ne[1], imgMaxY)) / resY));
    const px1 = Math.min(imgWidth, Math.ceil((Math.min(ne[0], imgMaxX) - imgMinX) / resX));
    const py1 = Math.min(imgHeight, Math.ceil((imgMaxY - Math.max(sw[1], imgMinY)) / resY));

    if (px1 <= px0 || py1 <= py0) return [];

    // Compute block range overlapping viewport
    const blockRow0 = Math.floor(py0 / BLOCK_SIZE);
    const blockRow1 = Math.ceil(py1 / BLOCK_SIZE);
    const blockCol0 = Math.floor(px0 / BLOCK_SIZE);
    const blockCol1 = Math.ceil(px1 / BLOCK_SIZE);

    const totalBlocksThisImage = (blockRow1 - blockRow0) * (blockCol1 - blockCol0);
    onEnumerated(totalBlocksThisImage);

    // Open other bands lazily (only if we have uncached blocks)
    let b11Image = null, b8aImage = null, sclImage = null;
    let bandsOpened = false;

    async function ensureBandsOpen() {
        if (bandsOpened) return;
        bandsOpened = true;
        const promises = [];
        // B11 (required)
        promises.push(
            GeoTIFF.fromUrl(b11Url, { allowFullFile: false })
                .then(tiff => tiff.getImage())
                .then(img => { b11Image = img; })
        );
        // B8A (optional)
        if (b8aUrl) {
            promises.push(
                GeoTIFF.fromUrl(b8aUrl, { allowFullFile: false })
                    .then(tiff => tiff.getImage())
                    .then(img => { b8aImage = img; })
                    .catch(() => { /* skip */ })
            );
        }
        // SCL (optional)
        if (sclUrl) {
            promises.push(
                GeoTIFF.fromUrl(sclUrl, { allowFullFile: false })
                    .then(tiff => tiff.getImage())
                    .then(img => { sclImage = img; })
                    .catch(() => { /* skip */ })
            );
        }
        await Promise.all(promises);
    }

    const allDetections = [];

    // Collect blocks that need processing
    const blocksToProcess = [];
    for (let br = blockRow0; br < blockRow1; br++) {
        for (let bc = blockCol0; bc < blockCol1; bc++) {
            const blockId = `${mgrs}_${br}_${bc}`;
            const cacheKey = `${blockId}:${imgDate}`;

            // Skip cached blocks
            if (cachedBlockDates.has(cacheKey)) {
                self.postMessage({ type: 'cachedBlock', blockId, date: imgDate });
                onBlockDone(imgDate, br, bc, true);
                continue;
            }

            blocksToProcess.push({ br, bc, blockId, cacheKey });
        }
    }

    if (blocksToProcess.length === 0) return allDetections;

    await ensureBandsOpen();

    // Process blocks with concurrency to overlap network I/O
    const CONCURRENCY = 6;
    let idx = 0;

    async function processNext() {
        while (idx < blocksToProcess.length) {
            const { br, bc, blockId, cacheKey } = blocksToProcess[idx++];

            // Check live peer partition — skip blocks not owned by this peer
            if (_livePeerCount > 1) {
                let h = 0;
                for (let ci = 0; ci < cacheKey.length; ci++) {
                    h = ((h << 5) - h + cacheKey.charCodeAt(ci)) | 0;
                }
                if (((h >>> 0) % _livePeerCount) !== _livePeerIndex) {
                    onBlockDone(imgDate, br, bc, true);
                    continue;
                }
            }

            const x0 = Math.max(0, bc * BLOCK_SIZE - BLOCK_OVERLAP);
            const y0 = Math.max(0, br * BLOCK_SIZE - BLOCK_OVERLAP);
            const x1 = Math.min(imgWidth, (bc + 1) * BLOCK_SIZE + BLOCK_OVERLAP);
            const y1 = Math.min(imgHeight, (br + 1) * BLOCK_SIZE + BLOCK_OVERLAP);

            // Block center in UTM → WGS84
            const cx = imgMinX + (bc + 0.5) * BLOCK_SIZE * resX;
            const cy = imgMaxY - (br + 0.5) * BLOCK_SIZE * resY;
            const [bLng, bLat] = proj4(utmProj(itemEpsg), 'EPSG:4326', [cx, cy]);

            try {
                const dets = await processBlock({
                    b12Image, b11Image, b8aImage, sclImage,
                    windowArr: [x0, y0, x1, y1],
                    imgDate, sunElevation, itemEpsg,
                    imgMinX, imgMaxY, resX, resY,
                    blockId, b12Url
                });

                // Overlap dedup: only keep detections whose peak pixel
                // falls in this block's canonical area
                const kept = [];
                for (const det of dets) {
                    const canonRow = Math.floor(det._peakImgRow / BLOCK_SIZE);
                    const canonCol = Math.floor(det._peakImgCol / BLOCK_SIZE);
                    if (canonRow === br && canonCol === bc) {
                        delete det._peakImgRow;
                        delete det._peakImgCol;
                        kept.push(det);
                    }
                }

                allDetections.push(...kept);
                self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: kept, lat: bLat, lng: bLng });
            } catch (err) {
                console.warn(`Block ${blockId} ${imgDate}: ${err.message}`);
                self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: [], lat: bLat, lng: bLng });
            }

            onBlockDone(imgDate, br, bc, false);
        }
    }

    // Launch concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, blocksToProcess.length); i++) {
        workers.push(processNext());
    }
    await Promise.all(workers);

    return allDetections;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

// Live peer partition — updated via 'updatePeers' messages without restarting
let _livePeerIndex = 0;
let _livePeerCount = 1;

self.onmessage = async function(e) {
    if (e.data.type === 'updatePeers') {
        _livePeerIndex = e.data.peerIndex || 0;
        _livePeerCount = e.data.peerCount || 1;
        return;
    }

    const { bbox, epsg, startDate, endDate, cachedBlockDates: cachedArr,
            peerIndex: pi, peerCount: pc } = e.data;
    const cachedBlockDates = new Set(cachedArr || []);
    _livePeerIndex = pi ?? 0;
    _livePeerCount = pc ?? 1;

    try {
        progress('SEARCHING CATALOGUE', 0);
        const items = await searchSTAC(bbox, 30, startDate, endDate);

        if (items.length === 0) {
            self.postMessage({ type: 'done', stats: { images: 0, rawDetections: 0 } });
            return;
        }

        progress(`Found ${items.length} images`, 5);

        let totalDetections = 0;
        let imagesCompleted = 0;

        // Process images with limited concurrency (each image has its own
        // block-level concurrency, so keep image parallelism modest)
        const IMG_CONCURRENCY = 2;
        let imgIdx = 0;

        async function processNextImage() {
            while (imgIdx < items.length) {
                const i = imgIdx++;
                const dt = items[i].properties.datetime.slice(0, 10);
                progress(`Processing ${dt}`, 5 + (i / items.length) * 90);

                try {
                    const dets = await processImageBlocks(
                        items[i], bbox, epsg, cachedBlockDates,
                        () => {},
                        () => {}
                    );
                    totalDetections += dets.length;
                } catch (err) {
                    console.warn(`Failed to process image:`, err);
                }
                imagesCompleted++;
                progress(`Processed ${imagesCompleted}/${items.length}`, 5 + (imagesCompleted / items.length) * 90);
            }
        }

        const imgWorkers = [];
        for (let i = 0; i < Math.min(IMG_CONCURRENCY, items.length); i++) {
            imgWorkers.push(processNextImage());
        }
        await Promise.all(imgWorkers);

        self.postMessage({
            type: 'done',
            stats: { images: items.length, rawDetections: totalDetections }
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
