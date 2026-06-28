// Sentinel-2 SWIR flare detection — block-level core.
//
// Pure computation: typed arrays in, detections out. I/O lives in cog.js so this
// module runs unchanged in the browser, in a Web Worker, in the CLI, and in the
// Lambda. Two design points make it serve every consumer from one source:
//
//   1. Every threshold is tunable per call. detectBlock takes a resolved
//      thresholds object T (resolveThresholds merges overrides over DEFAULTS).
//      Omitting it reproduces the proven DEFAULTS exactly, so existing 5-arg
//      callers (burnoff's worker) are unaffected. Bulk collection passes LOOSE so
//      the detector is near-recall-complete and quality gating happens later.
//   2. Each detection carries the full discriminating metric set (intensity,
//      contrast, shape, glint) so any morphological gate can be reconstructed
//      downstream rather than baked in here.
//
// The SPECTRAL MASK is the physics and is always applied — B12/B11 SWIR-hot,
// background contrast, and the NHI-SWIR / saturation test. That is what makes
// this flare detection rather than bright-pixel detection. The MORPHOLOGICAL
// gates (peakedness, large-blob, warm-region, single-pixel, max-pixels) are the
// tunable part; LOOSE neutralises them.

import { utmToWgs84, utmParams } from './geo.js';

// Glint geometry lives in score.js (single source of truth, recomputable from
// sun_elevation); re-exported here for callers that annotate detections.
export { glintAngleNadir, glintScoreFromAngle } from './score.js';
import { glintAngleNadir, glintScoreFromAngle } from './score.js';

// Proven defaults — identical to the original s2-flares / openflaring constants.
// A no-override call reproduces those outputs exactly.
export const DEFAULTS = {
    b12Min: 0.30,          // SWIR @2.2µm reflectance floor for the mask
    b11Min: 0.20,          // SWIR @1.6µm reflectance floor for the mask
    peakB12Min: 0.50,      // a component's peak must exceed this
    contrastRatio: 3.0,    // peak must beat backgroundFloor/median by this factor
    backgroundFloor: 0.15, // floor under the local B12 background median
    peakednessMin: 1.15,   // peak/avg shape gate (1.0 disables it)
    saturation: 1.0,       // reflectance at/above this counts as saturated
    maxPixels: 80,         // drop components larger than this
    largePixels: 30,       // components above this size face the strict floor
    largeB12Min: 0.70,     // strict peak floor for large components
    warmFraction: 0.5,     // warm-region grows over peak * this
    warmMaxPixels: 100,    // drop if the warm halo exceeds this
    singlePixelMin: 0.65,  // lone-pixel components need this peak
    maxCloudLocal: 0.75,   // skip a block if SCL cloud fraction exceeds this
    cloudFreeThresh: 0.30, // flag block not-cloud-free above this fraction
};

// Loose preset for bulk collection: keep the spectral physics, lower its floors
// modestly, and neutralise the morphological gates. Emitted metrics let SQL
// re-impose any of these later. Exported so callers/tests can reference it.
export const LOOSE = {
    b12Min: 0.25,
    b11Min: 0.15,
    peakB12Min: 0.30,
    contrastRatio: 2.0,
    backgroundFloor: 0.10,
    peakednessMin: 1.0,        // disabled (peak >= avg always)
    saturation: 1.0,
    maxPixels: 100000,         // disabled
    largePixels: 100000,       // disabled
    largeB12Min: 0.0,          // disabled
    warmFraction: 0.5,
    warmMaxPixels: 100000,     // disabled
    singlePixelMin: 0.25,
    maxCloudLocal: 0.95,
    cloudFreeThresh: 0.30,
};

export function resolveThresholds(overrides = {}) {
    return { ...DEFAULTS, ...overrides };
}

export const BLOCK_SIZE = 256;
export const BLOCK_OVERLAP = 10;

export function dnToReflectance(dn) {
    return (dn - 1000) / 10000;
}

/**
 * Cloud fraction from SCL raw data.
 * @returns {{ skip: boolean, cloudFree: boolean }}
 */
export function screenClouds(sclRaw, maxCloudLocal, cloudFreeThresh) {
    const total = sclRaw.length;
    if (total === 0) return { skip: false, cloudFree: true };
    let cloudPixels = 0;
    for (let i = 0; i < total; i++) {
        const v = sclRaw[i];
        if (v === 3 || v === 8 || v === 9 || v === 10) cloudPixels++;
    }
    const cloudFrac = cloudPixels / total;
    if (cloudFrac > maxCloudLocal) return { skip: true, cloudFree: false };
    return { skip: false, cloudFree: cloudFrac <= cloudFreeThresh };
}

export function labelConnectedComponents(mask, width, height) {
    const labels = new Int32Array(width * height);
    let nextLabel = 1;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || labels[i]) continue;
        const queue = [i];
        labels[i] = nextLabel;
        let head = 0;
        while (head < queue.length) {
            const idx = queue[head++];
            const r = Math.floor(idx / width);
            const c = idx % width;
            if (r > 0 && mask[idx - width] && !labels[idx - width]) { labels[idx - width] = nextLabel; queue.push(idx - width); }
            if (r < height - 1 && mask[idx + width] && !labels[idx + width]) { labels[idx + width] = nextLabel; queue.push(idx + width); }
            if (c > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = nextLabel; queue.push(idx - 1); }
            if (c < width - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = nextLabel; queue.push(idx + 1); }
        }
        nextLabel++;
    }
    return { labels, count: nextLabel - 1 };
}

// Grow the contiguous region above `warmThresh` from the peak, capped at cap.
function warmRegionSize(b12, peakIdx, warmThresh, w, h, cap) {
    if (b12[peakIdx] <= warmThresh) return 0;
    const visited = new Uint8Array(b12.length);
    const q = [peakIdx];
    visited[peakIdx] = 1;
    let head = 0, size = 0;
    while (head < q.length) {
        size++;
        if (size > cap) return size;
        const idx = q[head++];
        const r = Math.floor(idx / w), c = idx % w;
        if (r > 0 && !visited[idx - w] && b12[idx - w] > warmThresh) { visited[idx - w] = 1; q.push(idx - w); }
        if (r < h - 1 && !visited[idx + w] && b12[idx + w] > warmThresh) { visited[idx + w] = 1; q.push(idx + w); }
        if (c > 0 && !visited[idx - 1] && b12[idx - 1] > warmThresh) { visited[idx - 1] = 1; q.push(idx - 1); }
        if (c < w - 1 && !visited[idx + 1] && b12[idx + 1] > warmThresh) { visited[idx + 1] = 1; q.push(idx + 1); }
    }
    return size;
}

/**
 * Run SWIR flare detection on one block.
 *
 * @param {Uint16Array} b12Raw  raw B12 DN (w*h)
 * @param {Uint16Array} b11Raw  raw B11 DN (w*h)
 * @param {Uint16Array|null} b8aRaw  raw B8A DN, or null
 * @param {Uint16Array|null} sclRaw  raw SCL, or null
 * @param {object} meta  geometry + scene context (see fields below)
 * @param {object} [T]   resolved thresholds (resolveThresholds output); DEFAULTS if omitted
 * @returns {{ detections: object[], cloudFree: boolean }}
 */
export function detectBlock(b12Raw, b11Raw, b8aRaw, sclRaw, meta, T = resolveThresholds()) {
    const {
        date, epsg, imgMinX, imgMaxY, resX, resY,
        blockOffsetX, blockOffsetY, width: w, height: h,
        mgrs, scene, sunElevation = null, sunAzimuth = null,
    } = meta;

    if (w <= 0 || h <= 0) return { detections: [], cloudFree: false };

    let blockCloudFree = true;
    if (sclRaw) {
        const { skip, cloudFree } = screenClouds(sclRaw, T.maxCloudLocal, T.cloudFreeThresh);
        if (skip) return { detections: [], cloudFree: false };
        blockCloudFree = cloudFree;
    }

    const n = w * h;
    const b12 = new Float32Array(n);
    const bgPixels = [];
    for (let i = 0; i < n; i++) {
        const v = (b12Raw[i] - 1000) / 10000;
        b12[i] = v;
        if (v < T.b12Min) bgPixels.push(v);
    }
    if (bgPixels.length < 10) return { detections: [], cloudFree: blockCloudFree };
    bgPixels.sort((a, b) => a - b);
    const medianBg = bgPixels[Math.floor(bgPixels.length / 2)];
    const contrastThresh = Math.max(medianBg, T.backgroundFloor) * T.contrastRatio;

    const b11 = new Float32Array(n);
    const mask = new Uint8Array(n);
    let anyMask = false;
    const hasB8a = !!b8aRaw;
    for (let i = 0; i < n; i++) {
        const b11v = (b11Raw[i] - 1000) / 10000;
        b11[i] = b11v;
        const b12v = b12[i];
        if (b12v <= T.b12Min || b11v <= T.b11Min) continue;
        if (b12v <= contrastThresh) continue;
        if (hasB8a) {
            const b8av = (b8aRaw[i] - 1000) / 10000;
            const denom = b11v + b8av;
            const nhiswnir = denom > 0.01 ? (b11v - b8av) / denom : 0;
            if (!(nhiswnir > 0 || b11v > T.saturation || b12v > T.saturation)) continue;
        } else {
            if (b11v <= T.saturation) continue;
        }
        mask[i] = 1;
        anyMask = true;
    }
    if (!anyMask) return { detections: [], cloudFree: blockCloudFree };

    const { labels, count } = labelConnectedComponents(mask, w, h);
    if (count === 0) return { detections: [], cloudFree: blockCloudFree };

    const x0 = blockOffsetX, y0 = blockOffsetY;
    const x1 = x0 + w, y1 = y0 + h;
    const utmMinX = imgMinX + x0 * resX;
    const utmMinY = imgMaxY - y1 * resY;
    const utmMaxX = imgMinX + x1 * resX;
    const utmMaxYw = imgMaxY - y0 * resY;
    const { zone, isNorth } = utmParams(epsg);

    // Glint is scene-level (one sun geometry per pass), so compute once.
    let glintAngle = null, glintScore = null;
    if (sunElevation !== null && sunElevation !== undefined) {
        glintAngle = glintAngleNadir(sunElevation);
        glintScore = glintScoreFromAngle(glintAngle);
    }

    const detections = [];
    for (let labelId = 1; labelId <= count; labelId++) {
        let nPixels = 0, peakB12 = -Infinity, peakIdx = -1, sumB12 = 0;
        for (let i = 0; i < n; i++) {
            if (labels[i] !== labelId) continue;
            nPixels++;
            sumB12 += b12[i];
            if (b12[i] > peakB12) { peakB12 = b12[i]; peakIdx = i; }
        }

        // --- tunable morphological gates (LOOSE neutralises all of these) ---
        if (nPixels > T.maxPixels) continue;
        if (peakB12 < T.peakB12Min) continue;
        if (nPixels > T.largePixels && peakB12 < T.largeB12Min) continue;
        const avgB12 = sumB12 / nPixels;
        if (nPixels > 1 && peakB12 < T.peakednessMin * avgB12 && avgB12 < T.saturation) continue;
        if (nPixels === 1 && peakB12 < T.singlePixelMin) continue;

        const peakRow = Math.floor(peakIdx / w);
        const peakCol = peakIdx % w;
        const warmThresh = peakB12 * T.warmFraction;
        const warmSize = warmRegionSize(b12, peakIdx, warmThresh, w, h, T.warmMaxPixels);
        if (warmSize > T.warmMaxPixels) continue;

        const colFrac = (peakCol + 0.5) / w;
        const rowFrac = (peakRow + 0.5) / h;
        const utmX = utmMinX + colFrac * (utmMaxX - utmMinX);
        const utmY = utmMaxYw - rowFrac * (utmMaxYw - utmMinY);
        const [lon, lat] = utmToWgs84(utmX, utmY, zone, isNorth);

        const peakB11 = b11[peakIdx];
        // Non-finite ratios JSON-serialise to null automatically.
        const ratio = peakB11 > 1e-6 ? peakB12 / peakB11 : Infinity;

        detections.push({
            lon, lat, date, mgrs, scene,
            max_b12: peakB12,
            avg_b12: avgB12,
            // main's field name — glintMetrics()/the tests key off peak_b11.
            peak_b11: peakB11,
            b12_b11_ratio: ratio,
            peakedness: peakB12 / avgB12,
            pixels: nPixels,
            warm_size: warmSize,
            saturated: peakB12 >= T.saturation ? 1 : 0,
            sun_elevation: sunElevation ?? null,
            sun_azimuth: sunAzimuth ?? null,
            glint_angle: glintAngle,
            glint_score: glintScore,
            _peakImgRow: y0 + peakRow,
            _peakImgCol: x0 + peakCol,
        });
    }
    return { detections, cloudFree: blockCloudFree };
}
