import { GeoTIFF } from './vendor/geotiff-esm.js';
import { wgs84ToUtm, utmParams } from './geo.js';
import { detectBlock, BLOCK_SIZE, BLOCK_OVERLAP, resolveThresholds } from './detect.js';

// B12 mask floor as a raw DN value (before reflectance conversion), per thresholds.
const b12DnMin = (T) => T.b12Min * 10000 + 1000;

// How much to downsample for overview screening (8× = 160m for 20m bands)
const OVERVIEW_FACTOR = 8;

// Open a COG and return image handle + metadata
export async function openCOG(url) {
    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false });
    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    return {
        image,
        bbox: [minX, minY, maxX, maxY],
        width: image.getWidth(),
        height: image.getHeight(),
        resX: (maxX - minX) / image.getWidth(),
        resY: (maxY - minY) / image.getHeight(),
    };
}

// Read a window from a COG image, returns typed array
export async function readWindow(image, windowArr) {
    const [x0, y0, x1, y1] = windowArr;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
    const rasters = await image.readRasters({ window: windowArr });
    return rasters[0];
}

// Enumerate blocks overlapping a bbox (in image pixel coordinates)
export function enumerateBlocks(imgMeta, bbox, epsg) {
    const { width: imgWidth, height: imgHeight, bbox: imgBbox, resX, resY } = imgMeta;
    const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;

    const { zone, isNorth } = utmParams(epsg);
    const sw = wgs84ToUtm(bbox[0], bbox[1], zone, isNorth);
    const ne = wgs84ToUtm(bbox[2], bbox[3], zone, isNorth);

    const px0 = Math.max(0, Math.floor((Math.max(sw[0], imgMinX) - imgMinX) / resX));
    const py0 = Math.max(0, Math.floor((imgMaxY - Math.min(ne[1], imgMaxY)) / resY));
    const px1 = Math.min(imgWidth, Math.ceil((Math.min(ne[0], imgMaxX) - imgMinX) / resX));
    const py1 = Math.min(imgHeight, Math.ceil((imgMaxY - Math.max(sw[1], imgMinY)) / resY));

    if (px1 <= px0 || py1 <= py0) return [];

    const blockRow0 = Math.floor(py0 / BLOCK_SIZE);
    const blockRow1 = Math.ceil(py1 / BLOCK_SIZE);
    const blockCol0 = Math.floor(px0 / BLOCK_SIZE);
    const blockCol1 = Math.ceil(px1 / BLOCK_SIZE);

    const blocks = [];
    for (let br = blockRow0; br < blockRow1; br++) {
        for (let bc = blockCol0; bc < blockCol1; bc++) {
            const x0 = Math.max(0, bc * BLOCK_SIZE - BLOCK_OVERLAP);
            const y0 = Math.max(0, br * BLOCK_SIZE - BLOCK_OVERLAP);
            const x1 = Math.min(imgWidth, (bc + 1) * BLOCK_SIZE + BLOCK_OVERLAP);
            const y1 = Math.min(imgHeight, (br + 1) * BLOCK_SIZE + BLOCK_OVERLAP);
            blocks.push({ br, bc, window: [x0, y0, x1, y1] });
        }
    }
    return blocks;
}

// --- Overview screening functions ---

// Screen B12 at overview resolution for the query bbox.
// Returns true if any pixel has DN >= the mask floor (potential flare), false if safe to skip.
// Uses tiff.readRasters() which auto-selects the best overview level.
async function screenB12Overview(b12Tiff, utmBbox, resX, resY, T) {
    try {
        const rasters = await b12Tiff.readRasters({
            bbox: utmBbox,
            resX: resX * OVERVIEW_FACTOR,
            resY: resY * OVERVIEW_FACTOR,
        });
        const data = rasters[0];
        const floor = b12DnMin(T);
        for (let i = 0; i < data.length; i++) {
            if (data[i] >= floor) return true;
        }
        return false;
    } catch (e) {
        // If overview reading fails, don't skip — proceed with full-res
        return true;
    }
}

// Screen SCL at overview resolution for the query bbox.
// Returns { skip, cloudFree } — skip=true means too cloudy, safe to skip entire scene.
async function screenSCLOverview(sclUrl, utmBbox, resX, resY, T) {
    try {
        const tiff = await GeoTIFF.fromUrl(sclUrl, { allowFullFile: false });
        const rasters = await tiff.readRasters({
            bbox: utmBbox,
            resX: resX * OVERVIEW_FACTOR,
            resY: resY * OVERVIEW_FACTOR,
        });
        const data = rasters[0];
        if (!data || data.length === 0) return { skip: false, cloudFree: true };
        let cloudPixels = 0;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v === 3 || v === 8 || v === 9 || v === 10) cloudPixels++;
        }
        const cloudFrac = cloudPixels / data.length;
        if (cloudFrac > T.maxCloudLocal) return { skip: true, cloudFree: false };
        return { skip: false, cloudFree: cloudFrac <= T.cloudFreeThresh };
    } catch (e) {
        // If overview reading fails, don't skip
        return { skip: false, cloudFree: true };
    }
}

// Quick scan: does a raw B12 block have any pixel above the DN threshold?
// Single pass with early exit — avoids reading B11/B8A/SCL for cold blocks.
function blockHasHotPixels(b12Raw, floor) {
    for (let i = 0; i < b12Raw.length; i++) {
        if (b12Raw[i] >= floor) return true;
    }
    return false;
}

// Process a full S2 image: open bands, enumerate blocks, run detection, dedup.
// item: normalized STAC item (from stac.js) with .bands.b12/.b11/.b8a/.scl, .date, .epsg, .mgrs, .id
// bbox: [west, south, east, north] WGS84
// opts.thresholds: resolved/override thresholds (DEFAULTS if omitted); pass LOOSE for bulk recall
// opts.screenOverview: skip cold/cloudy scenes via overview reads first (default true)
// Returns { detections, cloudFree, blocksProcessed, skippedOverview }
export async function detectImage(item, bbox, { signal, thresholds, screenOverview = true } = {}) {
    const T = thresholds ?? resolveThresholds();
    const { bands, date, epsg, mgrs, id: scene } = item;
    // Accept the STAC view-extension sun angles under either naming so the lib
    // serves both camelCase collectors (lib/stac.js) and snake_case ones.
    const sunElevation = item.sunElevation ?? item.sun_elevation ?? null;
    const sunAzimuth = item.sunAzimuth ?? item.sun_azimuth ?? null;
    const { b12: b12Url, b11: b11Url, b8a: b8aUrl, scl: sclUrl } = bands;

    if (!b12Url || !b11Url) return { detections: [], cloudFree: true, blocksProcessed: 0 };

    // Open B12 COG — keep tiff handle for overview reads
    const b12Tiff = await GeoTIFF.fromUrl(b12Url, { allowFullFile: false });
    const b12Image = await b12Tiff.getImage();
    const [imgMinX, imgMinY, imgMaxX, imgMaxY] = b12Image.getBoundingBox();
    const imgWidth = b12Image.getWidth();
    const imgHeight = b12Image.getHeight();
    const resX = (imgMaxX - imgMinX) / imgWidth;
    const resY = (imgMaxY - imgMinY) / imgHeight;

    // Compute UTM bbox for the query region (clipped to image extent)
    const { zone, isNorth } = utmParams(epsg);
    const sw = wgs84ToUtm(bbox[0], bbox[1], zone, isNorth);
    const ne = wgs84ToUtm(bbox[2], bbox[3], zone, isNorth);
    const utmBbox = [
        Math.max(sw[0], imgMinX), Math.max(sw[1], imgMinY),
        Math.min(ne[0], imgMaxX), Math.min(ne[1], imgMaxY),
    ];

    // --- Overview screening (reads ~1-2% of full-res data) ---
    let overviewCloudFree = true;
    if (screenOverview) {
        // Screen 1: SCL overview — skip fully cloudy scenes before reading spectral data
        if (sclUrl) {
            const cloudResult = await screenSCLOverview(sclUrl, utmBbox, resX, resY, T);
            if (cloudResult.skip) {
                return { detections: [], cloudFree: false, blocksProcessed: 0, skippedOverview: true };
            }
            overviewCloudFree = cloudResult.cloudFree;
        }
        // Screen 2: B12 overview — skip scenes with no hot pixels anywhere in the bbox
        const hasHot = await screenB12Overview(b12Tiff, utmBbox, resX, resY, T);
        if (!hasHot) {
            return { detections: [], cloudFree: overviewCloudFree, blocksProcessed: 0, skippedOverview: true };
        }
    }

    // --- Full-res block processing ---

    const imgMeta = {
        image: b12Image, bbox: [imgMinX, imgMinY, imgMaxX, imgMaxY],
        width: imgWidth, height: imgHeight, resX, resY,
    };
    const blocks = enumerateBlocks(imgMeta, bbox, epsg);

    if (blocks.length === 0) return { detections: [], cloudFree: overviewCloudFree, blocksProcessed: 0 };

    // Open auxiliary bands lazily — only opened if a block has hot B12 pixels
    let b11Image = null, b8aImage = null, sclImage = null;
    let bandsPromise = null;

    async function ensureBandsOpen() {
        if (!bandsPromise) {
            bandsPromise = (async () => {
                const promises = [];
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
            })();
        }
        await bandsPromise;
    }

    const allDetections = [];
    let allCloudFree = overviewCloudFree;
    let blocksProcessed = 0;

    const CONCURRENCY = 6;
    let idx = 0;
    const floor = b12DnMin(T);

    async function processNext() {
        while (idx < blocks.length) {
            if (signal?.aborted) break;
            const { br, bc, window: windowArr } = blocks[idx++];
            const [x0, y0, x1, y1] = windowArr;
            const w = x1 - x0, h = y1 - y0;

            try {
                // Read B12 first — quick-reject blocks with no hot pixels
                const b12Raw = await readWindow(b12Image, windowArr);
                if (!b12Raw) continue;

                if (!blockHasHotPixels(b12Raw, floor)) {
                    blocksProcessed++;
                    continue; // Skip B11/B8A/SCL reads entirely
                }

                // Block has candidates — now open auxiliary bands and read them
                await ensureBandsOpen();

                const b11Raw = await readWindow(b11Image, windowArr);
                if (!b11Raw) continue;

                let b8aRaw = null;
                if (b8aImage) {
                    try { b8aRaw = await readWindow(b8aImage, windowArr); } catch (e) { /* skip */ }
                }
                let sclRaw = null;
                if (sclImage) {
                    try { sclRaw = await readWindow(sclImage, windowArr); } catch (e) { /* skip */ }
                }

                const result = detectBlock(b12Raw, b11Raw, b8aRaw, sclRaw, {
                    date, epsg, mgrs, scene,
                    imgMinX, imgMaxY, resX, resY,
                    blockOffsetX: x0,
                    blockOffsetY: y0,
                    width: w,
                    height: h,
                    sunElevation, sunAzimuth,
                }, T);

                blocksProcessed++;

                if (result.cloudFree === false) allCloudFree = false;
                for (const det of result.detections) {
                    const canonRow = Math.floor(det._peakImgRow / BLOCK_SIZE);
                    const canonCol = Math.floor(det._peakImgCol / BLOCK_SIZE);
                    if (canonRow === br && canonCol === bc) {
                        delete det._peakImgRow;
                        delete det._peakImgCol;
                        allDetections.push(det);
                    }
                }
            } catch (err) {
                console.warn(`Block error [${mgrs}_${br}_${bc}]: ${err.message}`);
            }
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, blocks.length); i++) {
        workers.push(processNext());
    }
    await Promise.all(workers);

    return { detections: allDetections, cloudFree: allCloudFree, blocksProcessed };
}
