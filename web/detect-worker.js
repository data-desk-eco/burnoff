/**
 * Web Worker (module): Sentinel-2 SWIR flare detection.
 *
 * Thin wrapper around s2-flares library functions, adding burnoff-specific
 * concerns: cached-block skipping, P2P peer partitioning, and per-block
 * message posting.
 */

import { searchSTAC } from './vendor/s2-flares/lib/stac.js';
import { openCOG, readWindow, enumerateBlocks } from './vendor/s2-flares/lib/cog.js';
import { detectBlock, BLOCK_SIZE, BLOCK_OVERLAP } from './vendor/s2-flares/lib/detect.js';
import { utmToWgs84, utmParams } from './vendor/s2-flares/lib/geo.js';

// Concurrency limits
const IMG_CONCURRENCY = 2;
const CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progress(stage, pct) {
    self.postMessage({ type: 'progress', stage, pct: Math.round(pct) });
}

// ---------------------------------------------------------------------------
// Per-image block processing (burnoff-specific orchestration)
// ---------------------------------------------------------------------------

async function processImageBlocks(item, viewportBbox, cachedBlockDates) {
    const { bands, date: imgDate, epsg: itemEpsg, mgrs } = item;
    const { b12: b12Url, b11: b11Url, b8a: b8aUrl, scl: sclUrl } = bands;

    if (!b12Url || !b11Url) return [];

    // Open B12 for image geometry
    const b12Meta = await openCOG(b12Url);
    const blocks = enumerateBlocks(b12Meta, viewportBbox, itemEpsg);

    if (blocks.length === 0) return [];

    const { image: b12Image, bbox: imgBbox, width: imgWidth, height: imgHeight, resX, resY } = b12Meta;
    const [imgMinX, , , imgMaxY] = imgBbox;
    const { zone, isNorth } = utmParams(itemEpsg);

    // Separate blocks into cached vs to-process
    const blocksToProcess = [];
    for (const block of blocks) {
        const blockId = `${mgrs}_${block.br}_${block.bc}`;
        const cacheKey = `${blockId}:${imgDate}`;

        if (cachedBlockDates.has(cacheKey)) {
            self.postMessage({ type: 'cachedBlock', blockId, date: imgDate });
            continue;
        }

        blocksToProcess.push({ ...block, blockId, cacheKey });
    }

    if (blocksToProcess.length === 0) return [];

    // Open auxiliary bands
    let b11Image = null, b8aImage = null, sclImage = null;
    const promises = [];
    const { GeoTIFF } = await import('./vendor/s2-flares/lib/vendor/geotiff-esm.js');
    promises.push(
        GeoTIFF.fromUrl(b11Url, { allowFullFile: false })
            .then(tiff => tiff.getImage())
            .then(img => { b11Image = img; })
    );
    if (b8aUrl) {
        promises.push(
            GeoTIFF.fromUrl(b8aUrl, { allowFullFile: false })
                .then(tiff => tiff.getImage())
                .then(img => { b8aImage = img; })
                .catch(() => {})
        );
    }
    if (sclUrl) {
        promises.push(
            GeoTIFF.fromUrl(sclUrl, { allowFullFile: false })
                .then(tiff => tiff.getImage())
                .then(img => { sclImage = img; })
                .catch(() => {})
        );
    }
    await Promise.all(promises);

    const allDetections = [];
    let idx = 0;

    async function processNext() {
        while (idx < blocksToProcess.length) {
            const { br, bc, window: windowArr, blockId, cacheKey } = blocksToProcess[idx++];

            // P2P peer partitioning — skip blocks not owned by this peer
            if (_livePeerCount > 1) {
                let h = 0;
                for (let ci = 0; ci < cacheKey.length; ci++) {
                    h = ((h << 5) - h + cacheKey.charCodeAt(ci)) | 0;
                }
                if (((h >>> 0) % _livePeerCount) !== _livePeerIndex) {
                    continue;
                }
            }

            // Block center in UTM -> WGS84
            const cx = imgMinX + (bc + 0.5) * BLOCK_SIZE * resX;
            const cy = imgMaxY - (br + 0.5) * BLOCK_SIZE * resY;
            const [bLng, bLat] = utmToWgs84(cx, cy, zone, isNorth);

            try {
                const [x0, y0, x1, y1] = windowArr;
                const w = x1 - x0, h = y1 - y0;

                // Read band windows as typed arrays
                const b12Raw = await readWindow(b12Image, windowArr);
                if (!b12Raw) {
                    self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: [], lat: bLat, lng: bLng, cloudFree: false });
                    continue;
                }
                const b11Raw = await readWindow(b11Image, windowArr);
                if (!b11Raw) {
                    self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: [], lat: bLat, lng: bLng, cloudFree: false });
                    continue;
                }

                let b8aRaw = null;
                if (b8aImage) {
                    try { b8aRaw = await readWindow(b8aImage, windowArr); } catch (e) { /* skip */ }
                }
                let sclRaw = null;
                if (sclImage) {
                    try { sclRaw = await readWindow(sclImage, windowArr); } catch (e) { /* skip */ }
                }

                const result = detectBlock(b12Raw, b11Raw, b8aRaw, sclRaw, {
                    date: imgDate,
                    epsg: itemEpsg,
                    imgMinX, imgMaxY, resX, resY,
                    blockOffsetX: x0,
                    blockOffsetY: y0,
                    width: w,
                    height: h,
                });

                if (result.detections.length === 0 && result.cloudFree === false) {
                    // Cloud-skipped block
                    self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: [], lat: bLat, lng: bLng, skipped: true });
                } else {
                    // Overlap dedup: only keep detections whose peak pixel falls in this block's canonical area
                    const kept = [];
                    for (const det of result.detections) {
                        const canonRow = Math.floor(det._peakImgRow / BLOCK_SIZE);
                        const canonCol = Math.floor(det._peakImgCol / BLOCK_SIZE);
                        if (canonRow === br && canonCol === bc) {
                            // Map s2-flares field names to burnoff's expected names
                            kept.push({
                                date: det.date,
                                max_b12: det.max_b12,
                                pixels: det.pixels,
                                flare_lon: det.lon,
                                flare_lat: det.lat,
                                avg_b12: det.avg_b12,
                                epsg: itemEpsg,
                                cog_b12: b12Url,
                                utm_bounds: [
                                    imgMinX + x0 * resX,
                                    imgMaxY - y1 * resY,
                                    imgMinX + x1 * resX,
                                    imgMaxY - y0 * resY,
                                ],
                                block_id: blockId,
                                mgrs,
                                block_row: br,
                                block_col: bc,
                            });
                        }
                    }

                    allDetections.push(...kept);
                    self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: kept, lat: bLat, lng: bLng, cloudFree: result.cloudFree });
                }
            } catch (err) {
                console.warn(`Block ${blockId} ${imgDate}: ${err.message}`);
                self.postMessage({ type: 'blockDetections', blockId, date: imgDate, detections: [], lat: bLat, lng: bLng, cloudFree: false });
            }
        }
    }

    // Launch concurrent block processors
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

self.postMessage({ type: 'ready' });

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

        // Collect all STAC items (async generator → array for progress tracking)
        const items = [];
        for await (const item of searchSTAC(bbox, startDate, endDate)) {
            items.push(item);
        }

        if (items.length === 0) {
            self.postMessage({ type: 'done', stats: { images: 0, rawDetections: 0 } });
            return;
        }

        progress(`Found ${items.length} images`, 5);

        let totalDetections = 0;
        let imagesCompleted = 0;

        // Process images with limited concurrency
        let imgIdx = 0;

        async function processNextImage() {
            while (imgIdx < items.length) {
                const i = imgIdx++;
                const dt = items[i].date;
                progress(`Processing ${dt}`, 5 + (i / items.length) * 90);

                try {
                    const dets = await processImageBlocks(items[i], bbox, cachedBlockDates);
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
