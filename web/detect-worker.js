/**
 * Web Worker (module): Sentinel-2 SWIR flare detection.
 *
 * Two engines behind one message protocol:
 *   - detectViaApi  (default, when job.apiUrl is set) — the s2-flares web API does
 *     search + detection + the per-tile S3 cache; this worker only reads each
 *     scene's COG *header* (no pixel download) to rebuild the identical block grid
 *     and re-emits the API's raw detections as the same per-block messages.
 *   - detectLocally (fallback, or when no apiUrl) — the original client-side path:
 *     download COG windows + run detectBlock in-browser. Used when the API is
 *     unavailable (offline, over the area cap, any non-200).
 *
 * Both produce byte-identical blockDetections (same block_id = mgrs_row_col, same
 * utm_bounds), so the CRDT/IndexedDB cache, P2P partitioning, and persistence
 * denominator are consistent across modes. Everything downstream is unchanged.
 */

import { searchSTAC } from './vendor/s2-flares/lib/stac.js';
import { openCOG, readWindow, enumerateBlocks } from './vendor/s2-flares/lib/cog.js';
import { detectBlock, BLOCK_SIZE, BLOCK_OVERLAP } from './vendor/s2-flares/lib/detect.js';
import { utmToWgs84, wgs84ToUtm, utmParams } from './vendor/s2-flares/lib/geo.js';

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
    const { bands, date: imgDate, epsg: itemEpsg, mgrs,
            sunElevation = null, sunAzimuth = null } = item;
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
                    sunElevation, sunAzimuth,
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
                                // s2-flares glint/spectral annotations
                                peak_b11: det.peak_b11,
                                b12_b11_ratio: det.b12_b11_ratio,
                                sun_elevation: det.sun_elevation,
                                sun_azimuth: det.sun_azimuth,
                                glint_angle: det.glint_angle,
                                glint_score: det.glint_score,
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
// API mode — the Lambda detects + caches; we only rebuild the block grid
// ---------------------------------------------------------------------------

// Whether this detection should partition by peer (skip blocks owned by others).
function ownsBlock(cacheKey) {
    if (_livePeerCount <= 1) return true;
    let h = 0;
    for (let ci = 0; ci < cacheKey.length; ci++) h = ((h << 5) - h + cacheKey.charCodeAt(ci)) | 0;
    return ((h >>> 0) % _livePeerCount) === _livePeerIndex;
}

// Turn one raw `scene` event from the API into per-block messages, mirroring the
// local path exactly. Reads only the B12 COG header (cheap, cached per tile) to
// recover the tile geometry, so block_id / utm_bounds match local detection.
async function emitApiScene(ev, viewportBbox, cachedBlockDates, geomCache) {
    const { date, mgrs, epsg, cog_b12, cloudFree, detections = [] } = ev;
    if (!cog_b12 || epsg == null) return 0;

    let geom = geomCache.get(mgrs);
    if (!geom) {
        const meta = await openCOG(cog_b12);
        const [imgMinX, , , imgMaxY] = meta.bbox;
        const { zone, isNorth } = utmParams(epsg);
        geom = { meta, imgMinX, imgMaxY, resX: meta.resX, resY: meta.resY, zone, isNorth };
        geomCache.set(mgrs, geom);
    }
    const { meta, imgMinX, imgMaxY, resX, resY, zone, isNorth } = geom;

    const blocks = enumerateBlocks(meta, viewportBbox, epsg);
    if (blocks.length === 0) return 0;

    // Bucket detections into their canonical block by pixel position.
    const byBlock = new Map();
    for (const d of detections) {
        const [ux, uy] = wgs84ToUtm(d.lon, d.lat, zone, isNorth);
        const br = Math.floor(Math.floor((imgMaxY - uy) / resY) / BLOCK_SIZE);
        const bc = Math.floor(Math.floor((ux - imgMinX) / resX) / BLOCK_SIZE);
        const k = `${br}_${bc}`;
        (byBlock.get(k) ?? byBlock.set(k, []).get(k)).push(d);
    }

    let emitted = 0;
    for (const { br, bc, window: [x0, y0, x1, y1] } of blocks) {
        const blockId = `${mgrs}_${br}_${bc}`;
        const cacheKey = `${blockId}:${date}`;
        if (cachedBlockDates.has(cacheKey)) { self.postMessage({ type: 'cachedBlock', blockId, date }); continue; }
        if (!ownsBlock(cacheKey)) continue;

        const cx = imgMinX + (bc + 0.5) * BLOCK_SIZE * resX;
        const cy = imgMaxY - (br + 0.5) * BLOCK_SIZE * resY;
        const [bLng, bLat] = utmToWgs84(cx, cy, zone, isNorth);
        const utm_bounds = [imgMinX + x0 * resX, imgMaxY - y1 * resY, imgMinX + x1 * resX, imgMaxY - y0 * resY];

        const dets = (byBlock.get(`${br}_${bc}`) || []).map(d => ({
            date, max_b12: d.max_b12, pixels: d.pixels, flare_lon: d.lon, flare_lat: d.lat,
            avg_b12: d.avg_b12, peak_b11: d.peak_b11, b12_b11_ratio: d.b12_b11_ratio,
            sun_elevation: d.sun_elevation, sun_azimuth: d.sun_azimuth,
            glint_angle: d.glint_angle, glint_score: d.glint_score,
            epsg, cog_b12, utm_bounds, block_id: blockId, mgrs, block_row: br, block_col: bc,
        }));
        emitted += dets.length;
        self.postMessage({ type: 'blockDetections', blockId, date, detections: dets, lat: bLat, lng: bLng, cloudFree });
    }
    return emitted;
}

// Stream the web API's raw NDJSON; throws only on a connection/non-200 failure so
// the caller can fall back to local detection. Mid-stream scene errors are skipped.
async function detectViaApi(job, cachedBlockDates) {
    const url = new URL(job.apiUrl);
    url.searchParams.set('bbox', job.bbox.join(','));
    if (job.startDate) url.searchParams.set('start', job.startDate);
    if (job.endDate) url.searchParams.set('end', job.endDate);
    url.searchParams.set('raw', '1');
    url.searchParams.set('stream', '1');

    progress('SEARCHING CATALOGUE', 0);
    let res;
    try { res = await fetch(url, { headers: { accept: 'application/x-ndjson' } }); }
    catch (e) { throw new Error(`api unreachable: ${e.message}`); }
    if (!res.ok || !res.body) throw new Error(`api HTTP ${res.status}`);

    const geomCache = new Map();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', total = 0, completed = 0, totalDets = 0;

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === 'start') { total = ev.scenes; progress(`Found ${total} images`, 5); }
            else if (ev.type === 'scene') {
                try { totalDets += await emitApiScene(ev, job.bbox, cachedBlockDates, geomCache); }
                catch (err) { console.warn(`API scene ${ev.date}: ${err.message}`); }
                completed++;
                progress(`Processed ${completed}/${total || '?'}`, total ? 5 + (completed / total) * 90 : 50);
            } else if (ev.type === 'scene-error') completed++;
        }
    }
    self.postMessage({ type: 'done', stats: { images: total, rawDetections: totalDets } });
}

// ---------------------------------------------------------------------------
// Local mode — original client-side download + detectBlock (fallback)
// ---------------------------------------------------------------------------

async function detectLocally(job, cachedBlockDates) {
    const { bbox, startDate, endDate } = job;
    progress('SEARCHING CATALOGUE', 0);

    // Collect all STAC items (async generator → array for progress tracking)
    const items = [];
    for await (const item of searchSTAC(bbox, startDate, endDate)) items.push(item);

    if (items.length === 0) {
        self.postMessage({ type: 'done', stats: { images: 0, rawDetections: 0 } });
        return;
    }
    progress(`Found ${items.length} images`, 5);

    let totalDetections = 0, imagesCompleted = 0, imgIdx = 0;
    async function processNextImage() {
        while (imgIdx < items.length) {
            const i = imgIdx++;
            progress(`Processing ${items[i].date}`, 5 + (i / items.length) * 90);
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
    for (let i = 0; i < Math.min(IMG_CONCURRENCY, items.length); i++) imgWorkers.push(processNextImage());
    await Promise.all(imgWorkers);

    self.postMessage({ type: 'done', stats: { images: items.length, rawDetections: totalDetections } });
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

    const job = e.data;
    const cachedBlockDates = new Set(job.cachedBlockDates || []);
    _livePeerIndex = job.peerIndex ?? 0;
    _livePeerCount = job.peerCount ?? 1;

    try {
        // Default to the Lambda; fall back to local detection if it's unreachable.
        if (job.apiUrl) {
            try { await detectViaApi(job, cachedBlockDates); return; }
            catch (err) { progress('API unavailable — detecting locally', 0); }
        }
        await detectLocally(job, cachedBlockDates);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
