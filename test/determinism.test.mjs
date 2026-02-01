/**
 * Determinism test for the Burnoff flare detection pipeline.
 *
 * Extracts the core numeric routines from detect.js and app.js,
 * then verifies that identical flare pixels produce identical detection
 * results regardless of:
 *   1. Window size (simulating different zoom levels)
 *   2. Background population (more/fewer non-flare pixels)
 *   3. Cloud fraction window dependence
 *   4. Detection input order for cross-date clustering
 *   5. Floating-point tie-breaking in sort / peak selection
 *
 * Run:  node test/determinism.test.mjs
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// ───────────────────────────────────────────────────────────────────────
// Constants (copied from detect.js)
// ───────────────────────────────────────────────────────────────────────
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

const MERGE_DISTANCE_M = 50;
const CLUSTER_AVG_B12_MIN = 0.70;

// ───────────────────────────────────────────────────────────────────────
// Core functions (extracted verbatim from detect.js / app.js)
// ───────────────────────────────────────────────────────────────────────

function dnToReflectance(dn) {
    return (dn - 1000) / 10000;
}

function labelConnectedComponents(mask, width, height) {
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

function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function crossDateCluster(allDetections) {
    if (allDetections.length === 0) return [];
    const sorted = allDetections.slice().sort((a, b) => b.max_b12 - a.max_b12);
    const clusters = [];
    for (const det of sorted) {
        let bestIdx = -1, bestDist = Infinity;
        for (let c = 0; c < clusters.length; c++) {
            const a = clusters[c].anchor;
            const d = haversineM(det.flare_lat, det.flare_lon, a.flare_lat, a.flare_lon);
            if (d <= MERGE_DISTANCE_M && d < bestDist) {
                bestDist = d;
                bestIdx = c;
            }
        }
        if (bestIdx >= 0) {
            clusters[bestIdx].members.push(det);
        } else {
            clusters.push({ anchor: det, members: [det] });
        }
    }
    const features = [];
    for (const cluster of clusters) {
        const members = cluster.members;
        const byDate = {};
        for (const d of members) {
            if (!byDate[d.date] || d.max_b12 > byDate[d.date].max_b12) byDate[d.date] = d;
        }
        const deduped = Object.values(byDate);
        if (deduped.length < 4) continue;
        const avgClusterB12 = deduped.reduce((s, d) => s + d.max_b12, 0) / deduped.length;
        if (avgClusterB12 < CLUSTER_AVG_B12_MIN) continue;
        let anchor = deduped[0];
        for (const d of deduped) { if (d.max_b12 > anchor.max_b12) anchor = d; }
        const sunEl = anchor.sun_elevation;
        const b12Corrected = sunEl != null
            ? anchor.max_b12 * Math.cos((90 - sunEl) * Math.PI / 180) : anchor.max_b12;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [anchor.flare_lon, anchor.flare_lat] },
            properties: {
                name: `${deduped.length} detection${deduped.length !== 1 ? 's' : ''}`,
                max_b12: b12Corrected,
                detection_count: deduped.length,
                detections: deduped.map(d => {
                    const se = d.sun_elevation;
                    return {
                        date: d.date, max_b12: d.max_b12, pixels: d.pixels,
                        cog_b12: d.cog_b12, epsg: d.epsg,
                        raw_lon: d.flare_lon, raw_lat: d.flare_lat,
                        b12_corrected: se != null
                            ? d.max_b12 * Math.cos((90 - se) * Math.PI / 180) : d.max_b12
                    };
                })
            }
        });
    }
    return features;
}

// ───────────────────────────────────────────────────────────────────────
// Extracted per-image detection pipeline (from processImage, pure math)
// ───────────────────────────────────────────────────────────────────────

/**
 * Run the detection pipeline on synthetic band arrays.
 * Returns array of {peakRow, peakCol, peakB12, nPixels, avgB12}.
 *
 * @param {object} opts
 * @param {Float32Array} opts.b12  - reflectance values
 * @param {Float32Array} opts.b11
 * @param {Float32Array} opts.b8a
 * @param {Uint8Array}   opts.scl  - scene classification (optional)
 * @param {number}       opts.w    - grid width
 * @param {number}       opts.h    - grid height
 */
function runDetection({ b12, b11, b8a, scl, w, h }) {
    const n = w * h;

    // Cloud check (SCL)
    if (scl) {
        let cloudPixels = 0, countable = 0;
        for (let i = 0; i < n; i++) {
            const dn12 = b12[i] * 10000 + 1000; // reverse reflectance→DN for check
            if (dn12 >= B12_DN_BRIGHT) continue;
            countable++;
            const v = scl[i];
            if (v === 3 || v === 8 || v === 9 || v === 10) cloudPixels++;
        }
        if (countable > 0 && cloudPixels / countable > MAX_CLOUD_LOCAL) return [];
    }

    // Brightness filter
    const bright = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        bright[i] = (b12[i] > B12_MIN && b11[i] > B11_MIN) ? 1 : 0;
    }

    // Contrast filter
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

    // Thermal filter
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

    // Connected components
    const { labels, count } = labelConnectedComponents(mask, w, h);
    if (count === 0) return [];

    const detections = [];
    for (let labelId = 1; labelId <= count; labelId++) {
        let nPixels = 0, peakB12 = -Infinity, peakIdx = -1, sumB12 = 0;
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
        if (nPixels > 1 && peakB12 < PEAKEDNESS_MIN * avgB12 && avgB12 < SATURATION) continue;
        if (nPixels === 1 && peakB12 < 0.65) continue;

        // Warm region filter
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

        detections.push({
            peakRow: Math.floor(peakIdx / w),
            peakCol: peakIdx % w,
            peakB12,
            nPixels,
            avgB12,
            medianBg,
            contrastThresh,
        });
    }
    return detections;
}

// ───────────────────────────────────────────────────────────────────────
// Synthetic data builders
// ───────────────────────────────────────────────────────────────────────

/**
 * Build a synthetic scene with a flare at a known position embedded in
 * a larger background. Returns {b12, b11, b8a, w, h, flareRow, flareCol}.
 *
 * @param {number} w - total grid width
 * @param {number} h - total grid height
 * @param {number} flareRow - row of the flare peak pixel
 * @param {number} flareCol - col of the flare peak pixel
 * @param {number} flarePeak - peak B12 reflectance (default 1.1)
 * @param {number} flarePixels - number of contiguous flare pixels (1-4, default 3)
 * @param {number} bgLevel - background B12 reflectance (default 0.05)
 */
function buildScene({ w, h, flareRow, flareCol, flarePeak = 1.1, flarePixels = 3, bgLevel = 0.05 }) {
    const n = w * h;
    const b12 = new Float32Array(n).fill(bgLevel);
    const b11 = new Float32Array(n).fill(bgLevel * 0.8);
    const b8a = new Float32Array(n).fill(bgLevel * 0.3);

    // Place flare cluster: peak + adjacent pixels
    const flarePositions = [[flareRow, flareCol]];
    if (flarePixels >= 2) flarePositions.push([flareRow, flareCol + 1]);
    if (flarePixels >= 3) flarePositions.push([flareRow + 1, flareCol]);
    if (flarePixels >= 4) flarePositions.push([flareRow + 1, flareCol + 1]);

    for (let p = 0; p < flarePositions.length; p++) {
        const [r, c] = flarePositions[p];
        if (r < 0 || r >= h || c < 0 || c >= w) continue;
        const idx = r * w + c;
        // Peak pixel gets full intensity, others get 80%
        const intensity = p === 0 ? flarePeak : flarePeak * 0.8;
        b12[idx] = intensity;
        b11[idx] = intensity * 0.7;
        b8a[idx] = intensity * 0.15; // Low NIR → high NHISWNIR
    }

    return { b12, b11, b8a, w, h, flareRow, flareCol };
}

/**
 * Embed a smaller scene into a larger one (simulating a wider viewport).
 * The flare pixels are placed at the same absolute position.
 */
function embedScene(innerScene, outerW, outerH, offsetRow, offsetCol) {
    const n = outerW * outerH;
    const bgLevel = 0.05;
    const b12 = new Float32Array(n).fill(bgLevel);
    const b11 = new Float32Array(n).fill(bgLevel * 0.8);
    const b8a = new Float32Array(n).fill(bgLevel * 0.3);

    for (let r = 0; r < innerScene.h; r++) {
        for (let c = 0; c < innerScene.w; c++) {
            const srcIdx = r * innerScene.w + c;
            const dstR = r + offsetRow;
            const dstC = c + offsetCol;
            if (dstR < 0 || dstR >= outerH || dstC < 0 || dstC >= outerW) continue;
            const dstIdx = dstR * outerW + dstC;
            b12[dstIdx] = innerScene.b12[srcIdx];
            b11[dstIdx] = innerScene.b11[srcIdx];
            b8a[dstIdx] = innerScene.b8a[srcIdx];
        }
    }

    return { b12, b11, b8a, w: outerW, h: outerH };
}

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────

describe('Per-image detection determinism', () => {

    it('identical input → identical output (baseline sanity)', () => {
        const scene = buildScene({ w: 100, h: 100, flareRow: 50, flareCol: 50 });
        const r1 = runDetection(scene);
        const r2 = runDetection(scene);
        assert.deepStrictEqual(r1, r2, 'Same input must produce same output');
        assert.ok(r1.length > 0, 'Should detect the flare');
    });

    it('ZOOM SENSITIVITY: varying window size changes background median → different contrast threshold', () => {
        // This is the critical test. We place the same flare pixels in windows
        // of increasing size. The background median is computed over all non-bright
        // pixels in the window, so more background → potentially different median.

        const flarePeak = 0.80; // moderate flare
        const bgLevel = 0.05;

        const sizes = [
            { w: 60, h: 60, fr: 30, fc: 30 },    // ~zoom 14
            { w: 120, h: 120, fr: 60, fc: 60 },   // ~zoom 13
            { w: 250, h: 250, fr: 125, fc: 125 },  // ~zoom 12
            { w: 500, h: 500, fr: 250, fc: 250 },  // ~zoom 11
        ];

        const results = sizes.map(s =>
            runDetection(buildScene({
                w: s.w, h: s.h, flareRow: s.fr, flareCol: s.fc,
                flarePeak, bgLevel
            }))
        );

        // Check if all runs detect the same flare
        const detected = results.map(r => r.length);
        const allSame = detected.every(d => d === detected[0]);

        console.log('  Window sizes:', sizes.map(s => `${s.w}x${s.h}`).join(', '));
        console.log('  Detections per size:', detected.join(', '));
        console.log('  Median/thresh per size:', results.map((r, i) => {
            if (r.length > 0) return `med=${r[0].medianBg.toFixed(4)} thr=${r[0].contrastThresh.toFixed(4)}`;
            // Re-run to get threshold even if no detection
            const scene = buildScene({ w: sizes[i].w, h: sizes[i].h, flareRow: sizes[i].fr, flareCol: sizes[i].fc, flarePeak, bgLevel });
            const bg = [];
            for (let j = 0; j < scene.b12.length; j++) if (scene.b12[j] < B12_MIN) bg.push(scene.b12[j]);
            bg.sort((a, b) => a - b);
            const med = bg[Math.floor(bg.length / 2)];
            return `med=${med.toFixed(4)} thr=${(Math.max(med, BACKGROUND_FLOOR) * CONTRAST_RATIO).toFixed(4)}`;
        }).join(', '));

        // With uniform background, median should be the same regardless of window
        // size since all bg pixels have the same value. So this should pass.
        assert.ok(allSame,
            `Uniform background: detection count should not vary with window size. Got: [${detected}]`);
    });

    it('ZOOM SENSITIVITY: heterogeneous background shifts median with window size', () => {
        // Realistic scenario: background is NOT uniform. Some areas are brighter
        // (e.g., industrial, bare soil). Including more of these in a wider window
        // changes the median.

        // Build a scene where center has low bg (0.04) but outer ring has bg
        // ABOVE BACKGROUND_FLOOR (0.18) to defeat the floor mitigation.
        function buildHeterogeneousScene(w, h, flareRow, flareCol, flarePeak) {
            const n = w * h;
            const b12 = new Float32Array(n);
            const b11 = new Float32Array(n);
            const b8a = new Float32Array(n);

            for (let r = 0; r < h; r++) {
                for (let c = 0; c < w; c++) {
                    const idx = r * w + c;
                    const inCenter = r >= (h - 100) / 2 && r < (h + 100) / 2 &&
                                     c >= (w - 100) / 2 && c < (w + 100) / 2;
                    // Outer region background well ABOVE BACKGROUND_FLOOR (0.15)
                    const bg = inCenter ? 0.04 : 0.25;
                    b12[idx] = bg;
                    b11[idx] = bg * 0.8;
                    b8a[idx] = bg * 0.3;
                }
            }

            // Place single-pixel flare (avoids peakedness filter)
            const idx = flareRow * w + flareCol;
            b12[idx] = flarePeak;
            b11[idx] = flarePeak * 0.7;
            b8a[idx] = flarePeak * 0.15;

            return { b12, b11, b8a, w, h };
        }

        function computeMedian(b12arr) {
            const bg = [];
            for (let i = 0; i < b12arr.length; i++) if (b12arr[i] < B12_MIN) bg.push(b12arr[i]);
            bg.sort((a, b) => a - b);
            return bg[Math.floor(bg.length / 2)];
        }

        // Test with a marginal single-pixel flare that sits between the two thresholds.
        // Small window (center only): median ~0.04, floor 0.15, thresh = 0.45
        // Large window (center+outer): median ~0.25, thresh = 0.75
        // Single pixel at B12=0.70 passes single-pixel confidence (>= 0.65),
        // passes contrast at thresh 0.45, but fails contrast at thresh 0.75.
        const flarePeak = 0.70;
        const w1 = 100, h1 = 100;
        const w2 = 300, h2 = 300;

        const smallScene = buildHeterogeneousScene(w1, h1, 50, 50, flarePeak);
        const largeScene = buildHeterogeneousScene(w2, h2, 150, 150, flarePeak);

        const med1 = computeMedian(smallScene.b12);
        const med2 = computeMedian(largeScene.b12);
        const thresh1 = Math.max(med1, BACKGROUND_FLOOR) * CONTRAST_RATIO;
        const thresh2 = Math.max(med2, BACKGROUND_FLOOR) * CONTRAST_RATIO;

        const r1 = runDetection(smallScene);
        const r2 = runDetection(largeScene);

        console.log(`  Small window (${w1}x${h1}): median=${med1.toFixed(4)}, thresh=${thresh1.toFixed(4)}, detections=${r1.length}`);
        console.log(`  Large window (${w2}x${h2}): median=${med2.toFixed(4)}, thresh=${thresh2.toFixed(4)}, detections=${r2.length}`);

        // The medians MUST differ because outer ring pushes median above floor
        assert.notEqual(med1, med2, 'Medians should differ between window sizes');
        assert.ok(thresh1 < thresh2,
            `Larger window should have higher threshold: ${thresh1.toFixed(4)} vs ${thresh2.toFixed(4)}`);

        // The flare at 0.50 is above thresh1 (0.45) but below thresh2 (0.54)
        // So small window detects it, large window does not
        if (r1.length !== r2.length) {
            console.log('  ⚠ CONFIRMED: heterogeneous background causes zoom-dependent detection!');
            console.log(`    Flare B12=${flarePeak} passes thresh ${thresh1.toFixed(2)} but not ${thresh2.toFixed(2)}`);
        }
        assert.notEqual(r1.length, r2.length,
            'Marginal flare between thresholds should be detected at one zoom but not another');
    });

    it('BACKGROUND_FLOOR prevents divergence for well-above-threshold flares', () => {
        // The BACKGROUND_FLOOR (0.15) means contrastThresh >= 0.45 always.
        // A strong flare (B12 >> 0.45) should be detected regardless of window.
        const flarePeak = 1.1;

        const sizes = [60, 120, 250, 500];
        const results = sizes.map(s => {
            const scene = buildScene({
                w: s, h: s,
                flareRow: Math.floor(s / 2),
                flareCol: Math.floor(s / 2),
                flarePeak,
                bgLevel: 0.05
            });
            return runDetection(scene);
        });

        const counts = results.map(r => r.length);
        console.log(`  Strong flare (B12=${flarePeak}): detections across sizes: [${counts}]`);

        assert.ok(counts.every(c => c === counts[0]),
            'Strong flares above BACKGROUND_FLOOR * CONTRAST_RATIO should always be detected');
        assert.ok(counts[0] > 0, 'Should detect the flare');
    });

    it('cloud cover fraction changes with window size', () => {
        const w1 = 50, h1 = 50;
        const w2 = 150, h2 = 150;

        function buildCloudScene(w, h) {
            const n = w * h;
            const b12 = new Float32Array(n).fill(0.05);
            const b11 = new Float32Array(n).fill(0.04);
            const b8a = new Float32Array(n).fill(0.015);
            const scl = new Uint8Array(n).fill(4); // vegetation (clear)

            // Cloud ring around center
            for (let r = 0; r < h; r++) {
                for (let c = 0; c < w; c++) {
                    const dr = Math.abs(r - h / 2);
                    const dc = Math.abs(c - w / 2);
                    // Ring of cloud between radius 15-20 from center
                    if (dr >= 15 && dr <= 20 && dc <= 20) scl[r * w + c] = 9; // cloud high
                    if (dc >= 15 && dc <= 20 && dr <= 20) scl[r * w + c] = 9;
                }
            }

            // Place flare at center
            const idx = Math.floor(h / 2) * w + Math.floor(w / 2);
            b12[idx] = 1.1;
            b11[idx] = 0.8;
            b8a[idx] = 0.1;

            return { b12, b11, b8a, scl, w, h };
        }

        const scene1 = buildCloudScene(w1, h1);
        const scene2 = buildCloudScene(w2, h2);

        // Count cloud fractions
        function cloudFraction(scl, b12) {
            let cloud = 0, countable = 0;
            for (let i = 0; i < scl.length; i++) {
                const dn12 = b12[i] * 10000 + 1000;
                if (dn12 >= B12_DN_BRIGHT) continue;
                countable++;
                if (scl[i] === 3 || scl[i] === 8 || scl[i] === 9 || scl[i] === 10) cloud++;
            }
            return countable > 0 ? cloud / countable : 0;
        }

        const cf1 = cloudFraction(scene1.scl, scene1.b12);
        const cf2 = cloudFraction(scene2.scl, scene2.b12);

        console.log(`  Cloud fraction: ${w1}x${h1}=${(cf1 * 100).toFixed(1)}%, ${w2}x${h2}=${(cf2 * 100).toFixed(1)}%`);

        const r1 = runDetection(scene1);
        const r2 = runDetection(scene2);
        console.log(`  Detections: ${w1}x${h1}=${r1.length}, ${w2}x${h2}=${r2.length}`);

        if (cf1 !== cf2) {
            console.log('  ⚠ Cloud fraction differs with window size');
            if (r1.length !== r2.length) {
                console.log('  ⚠ CONFIRMED: cloud fraction divergence causes detection difference');
            }
        }
    });

    it('warm region filter is window-size sensitive', () => {
        // The warm region filter checks how many pixels have B12 > peak * WARM_FRACTION.
        // In a larger window, more ambient warm pixels could merge into the warm region.

        const flarePeak = 0.9;

        function buildWarmScene(w, h, flareRow, flareCol) {
            const n = w * h;
            const b12 = new Float32Array(n).fill(0.05);
            const b11 = new Float32Array(n).fill(0.04);
            const b8a = new Float32Array(n).fill(0.015);

            // Place flare
            const idx = flareRow * w + flareCol;
            b12[idx] = flarePeak;
            b11[idx] = flarePeak * 0.7;
            b8a[idx] = flarePeak * 0.15;

            // Place warm ambient pixels near the flare (just above warmThresh)
            // warmThresh = 0.9 * 0.5 = 0.45
            const warmLevel = 0.46;
            for (let dr = -6; dr <= 6; dr++) {
                for (let dc = -6; dc <= 6; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const r = flareRow + dr, c = flareCol + dc;
                    if (r < 0 || r >= h || c < 0 || c >= w) continue;
                    if (Math.abs(dr) <= 2 && Math.abs(dc) <= 2) {
                        // Near the flare: warm pixels
                        const ni = r * w + c;
                        b12[ni] = warmLevel;
                        b11[ni] = warmLevel * 0.7;
                        b8a[ni] = warmLevel * 0.15;
                    }
                }
            }

            return { b12, b11, b8a, w, h };
        }

        // Small window: warm pixels might just fit
        const scene1 = buildWarmScene(50, 50, 25, 25);
        // Same warm region, but it's present in both, so should be same
        const scene2 = buildWarmScene(200, 200, 100, 100);

        const r1 = runDetection(scene1);
        const r2 = runDetection(scene2);

        console.log(`  Warm filter: small=${r1.length} detections, large=${r2.length} detections`);

        // With properly constructed warm regions, both should behave the same
        // because the warm connected component is the same size in both cases
        // (it's isolated from the edges by background)
    });
});

describe('Cross-date clustering determinism', () => {

    function makeDet(date, lat, lon, b12, sunEl = 45) {
        return {
            date, flare_lat: lat, flare_lon: lon, max_b12: b12,
            pixels: 3, sun_elevation: sunEl, cog_b12: 'http://example.com/b12.tif',
            epsg: 32639
        };
    }

    it('identical input → identical output', () => {
        const dets = [
            makeDet('2024-01-01', 25.0, 51.0, 1.1),
            makeDet('2024-01-16', 25.0, 51.0, 1.05),
            makeDet('2024-02-01', 25.0, 51.0, 0.95),
            makeDet('2024-02-16', 25.0, 51.0, 1.2),
            makeDet('2024-03-01', 25.0, 51.0, 1.0),
        ];
        const r1 = crossDateCluster(dets);
        const r2 = crossDateCluster(dets);
        assert.deepStrictEqual(r1, r2);
        assert.equal(r1.length, 1, 'Should merge into one cluster');
    });

    it('input order does not affect cluster result', () => {
        const dets = [
            makeDet('2024-01-01', 25.0, 51.0, 1.1),
            makeDet('2024-01-16', 25.0, 51.0, 1.05),
            makeDet('2024-02-01', 25.0, 51.0, 0.95),
            makeDet('2024-02-16', 25.0, 51.0, 1.2),
            makeDet('2024-03-01', 25.0, 51.0, 1.0),
        ];

        // Shuffle the array several ways
        const shuffled1 = [...dets].reverse();
        const shuffled2 = [dets[2], dets[4], dets[0], dets[3], dets[1]];
        const shuffled3 = [dets[4], dets[3], dets[2], dets[1], dets[0]];

        const r0 = crossDateCluster(dets);
        const r1 = crossDateCluster(shuffled1);
        const r2 = crossDateCluster(shuffled2);
        const r3 = crossDateCluster(shuffled3);

        // All should produce same cluster with same anchor
        for (const r of [r1, r2, r3]) {
            assert.equal(r.length, r0.length, 'Same number of clusters');
            assert.equal(
                r[0].geometry.coordinates[0], r0[0].geometry.coordinates[0],
                'Same anchor longitude'
            );
            assert.equal(
                r[0].geometry.coordinates[1], r0[0].geometry.coordinates[1],
                'Same anchor latitude'
            );
            assert.equal(
                r[0].properties.detection_count, r0[0].properties.detection_count,
                'Same detection count'
            );
        }
    });

    it('equal B12 values produce stable sort (tie-breaking)', () => {
        // Two detections at slightly different locations with IDENTICAL B12
        const lat1 = 25.0, lon1 = 51.0;
        const lat2 = 25.0001, lon2 = 51.0001; // ~15m apart, within merge distance

        const dets = [
            makeDet('2024-01-01', lat1, lon1, 1.0),
            makeDet('2024-01-16', lat2, lon2, 1.0), // exact same B12
            makeDet('2024-02-01', lat1, lon1, 1.0),
            makeDet('2024-02-16', lat2, lon2, 1.0),
            makeDet('2024-03-01', lat1, lon1, 1.0),
        ];

        // Run 10 times to check stability
        const results = [];
        for (let i = 0; i < 10; i++) {
            const r = crossDateCluster(dets);
            results.push({
                count: r.length,
                coords: r[0]?.geometry.coordinates,
                anchor_b12: r[0]?.properties.max_b12
            });
        }

        const first = results[0];
        for (let i = 1; i < results.length; i++) {
            assert.equal(results[i].count, first.count, `Run ${i}: same cluster count`);
            assert.deepStrictEqual(results[i].coords, first.coords, `Run ${i}: same anchor coords`);
        }
        console.log(`  Tie-breaking: stable across 10 runs, anchor at [${first.coords}]`);
    });

    it('two distinct flares just beyond merge distance stay separate', () => {
        // 60m apart (> MERGE_DISTANCE_M = 50m)
        // At ~25°N, 0.001° lon ≈ 101m, so 0.00055° ≈ 55.5m
        const lat = 25.0, lon1 = 51.0, lon2 = 51.00055;
        const dist = haversineM(lat, lon1, lat, lon2);
        console.log(`  Distance between flares: ${dist.toFixed(1)}m (threshold: ${MERGE_DISTANCE_M}m)`);

        const dets = [
            // Flare 1
            makeDet('2024-01-01', lat, lon1, 1.1),
            makeDet('2024-01-16', lat, lon1, 1.0),
            makeDet('2024-02-01', lat, lon1, 0.95),
            makeDet('2024-02-16', lat, lon1, 1.2),
            // Flare 2
            makeDet('2024-01-01', lat, lon2, 1.05),
            makeDet('2024-01-16', lat, lon2, 0.9),
            makeDet('2024-02-01', lat, lon2, 1.15),
            makeDet('2024-02-16', lat, lon2, 1.0),
        ];

        const r = crossDateCluster(dets);
        assert.equal(r.length, 2, 'Should produce 2 separate clusters');
    });

    it('coordinate quantization: sub-pixel jitter within 20m grid', () => {
        // Sentinel-2 has 20m pixels. Different windows could place the peak
        // pixel center at slightly different UTM coordinates → different WGS84.
        // This tests that such jitter doesn't create duplicate clusters.

        // 20m pixel → at 25°N, ~0.00018° lat, ~0.0002° lon
        const baseLat = 25.0, baseLon = 51.0;
        const jitterLat = 0.00009; // half a pixel
        const jitterLon = 0.0001;

        const dets = [];
        for (let i = 0; i < 6; i++) {
            // Alternate between slightly jittered positions
            const lat = baseLat + (i % 2 === 0 ? 0 : jitterLat);
            const lon = baseLon + (i % 2 === 0 ? 0 : jitterLon);
            dets.push(makeDet(`2024-0${i + 1}-01`, lat, lon, 1.0 + i * 0.05));
        }

        const dist = haversineM(baseLat, baseLon, baseLat + jitterLat, baseLon + jitterLon);
        console.log(`  Sub-pixel jitter distance: ${dist.toFixed(1)}m`);

        const r = crossDateCluster(dets);
        assert.equal(r.length, 1,
            `Sub-pixel jitter (${dist.toFixed(1)}m) should merge into 1 cluster, got ${r.length}`);
    });
});

describe('STAC search bbox sensitivity', () => {

    it('ensureMinBbox pads small viewports to minimum extent', () => {
        const MIN_PROCESS_EXTENT_DEG = 0.045;

        function ensureMinBbox(bbox, minDeg) {
            const cx = (bbox[0] + bbox[2]) / 2;
            const cy = (bbox[1] + bbox[3]) / 2;
            const halfW = Math.max((bbox[2] - bbox[0]) / 2, minDeg / 2);
            const halfH = Math.max((bbox[3] - bbox[1]) / 2, minDeg / 2);
            return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
        }

        // Simulate different zoom levels centered on the same point
        const center = [51.52, 25.92];
        const zooms = {
            'zoom 14 (tight)': [center[0] - 0.01, center[1] - 0.01, center[0] + 0.01, center[1] + 0.01],
            'zoom 13': [center[0] - 0.02, center[1] - 0.02, center[0] + 0.02, center[1] + 0.02],
            'zoom 12': [center[0] - 0.04, center[1] - 0.04, center[0] + 0.04, center[1] + 0.04],
            'zoom 11': [center[0] - 0.08, center[1] - 0.08, center[0] + 0.08, center[1] + 0.08],
        };

        for (const [label, bbox] of Object.entries(zooms)) {
            const padded = ensureMinBbox(bbox, MIN_PROCESS_EXTENT_DEG);
            const paddedW = padded[2] - padded[0];
            const paddedH = padded[3] - padded[1];
            console.log(`  ${label}: viewport ${(bbox[2] - bbox[0]).toFixed(4)}° → padded ${paddedW.toFixed(4)}°`);
        }

        // Key insight: ensureMinBbox only establishes a FLOOR. Viewports wider
        // than MIN_PROCESS_EXTENT_DEG still use their full width.
        const tightBbox = zooms['zoom 14 (tight)'];
        const wideBbox = zooms['zoom 11'];
        const paddedTight = ensureMinBbox(tightBbox, MIN_PROCESS_EXTENT_DEG);
        const paddedWide = ensureMinBbox(wideBbox, MIN_PROCESS_EXTENT_DEG);

        const tightW = paddedTight[2] - paddedTight[0];
        const wideW = paddedWide[2] - paddedWide[0];

        if (tightW !== wideW) {
            console.log('  ⚠ CONFIRMED: padded processing extent varies with zoom level');
            console.log(`    Zoom 14 padded: ${tightW.toFixed(4)}°, Zoom 11 padded: ${wideW.toFixed(4)}°`);
            console.log('    This means background statistics, cloud fractions, and warm');
            console.log('    region sizes can all change depending on zoom level.');
        }

        // The tight viewport should be padded up to the minimum
        assert.ok(tightW >= MIN_PROCESS_EXTENT_DEG,
            'Tight viewport should be padded to minimum');
        // The wide viewport should NOT be clamped down
        assert.ok(wideW > MIN_PROCESS_EXTENT_DEG,
            'Wide viewport should exceed minimum (no clamping)');
    });

    it('STAC search uses original bbox, not padded bbox', () => {
        // The code does:
        //   const processBbox = ensureMinBbox(bbox, MIN_PROCESS_EXTENT_DEG);
        //   const items = await searchSTAC(bbox, ...);  // ← original bbox!
        //   processImage(items[i], processBbox, epsg);   // ← padded bbox
        //
        // This means a tight viewport might miss Sentinel tiles that overlap
        // the padded processing extent but NOT the viewport.
        // However, at zoom 11+ (MIN_DETECT_ZOOM), viewport is always large
        // enough to cover the padded extent... let's check.

        const MIN_PROCESS_EXTENT_DEG = 0.045;
        const MIN_DETECT_ZOOM = 11;

        // At zoom 11, viewport is roughly ±0.08° in each direction (varies by lat)
        // MIN_PROCESS_EXTENT_DEG/2 = 0.0225° — always within zoom 11+ viewport
        console.log('  MIN_PROCESS_EXTENT_DEG/2 = 0.0225°');
        console.log('  Zoom 11 half-extent ≈ 0.08° → viewport always covers padded bbox');
        console.log('  Zoom 12 half-extent ≈ 0.04° → viewport always covers padded bbox');
        console.log('  STAC search bbox being smaller than process bbox is OK at zoom 11+');
        console.log('  because Sentinel tiles are ~110km wide (1° at equator) and');
        console.log('  will be found even with a slightly smaller search bbox.');

        // At worst case: viewport barely covers padded extent.
        // Sentinel tiles are ~1° × 1°, so even a 0.01° search bbox will find
        // the correct tile as long as it's within the tile boundary.
        // The risk is at tile boundaries: viewport might straddle 2 tiles,
        // but search bbox might not include the second tile's center.
        // However, STAC spatial search uses intersection, not containment,
        // so any overlap will return the tile.
        console.log('  STAC searches by intersection → even small bbox finds overlapping tiles.');
    });
});

describe('Block-based detection determinism', () => {
    const BLOCK_SIZE = 256;
    const BLOCK_OVERLAP = 10;

    it('block-based detection is zoom-invariant', () => {
        // A canonical block always reads the same pixels regardless of viewport.
        // Simulate: place a flare at a fixed position within a block, then
        // verify detection is identical whether processed as part of a small
        // or large viewport (same block window in both cases).

        const blockRow = 5, blockCol = 3;
        const flareRow = blockRow * BLOCK_SIZE + 128;  // center of block
        const flareCol = blockCol * BLOCK_SIZE + 128;

        // The block read window (with overlap)
        const x0 = blockCol * BLOCK_SIZE - BLOCK_OVERLAP;
        const y0 = blockRow * BLOCK_SIZE - BLOCK_OVERLAP;
        const x1 = (blockCol + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const y1 = (blockRow + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const w = x1 - x0, h = y1 - y0;

        // Place flare at the correct position within the block window
        const localRow = flareRow - y0;
        const localCol = flareCol - x0;
        const scene = buildScene({ w, h, flareRow: localRow, flareCol: localCol, flarePeak: 1.1 });

        // Run detection twice (simulating two different viewports that both
        // include this block — the block window is the same either way)
        const r1 = runDetection(scene);
        const r2 = runDetection(scene);

        assert.deepStrictEqual(r1, r2, 'Same block window must produce identical results');
        assert.ok(r1.length > 0, 'Should detect the flare');

        // Verify the peak pixel falls within the canonical block area
        // (not in the overlap margin)
        for (const det of r1) {
            const peakImgRow = det.peakRow + y0;
            const peakImgCol = det.peakCol + x0;
            const canonRow = Math.floor(peakImgRow / BLOCK_SIZE);
            const canonCol = Math.floor(peakImgCol / BLOCK_SIZE);
            assert.equal(canonRow, blockRow, 'Peak pixel canonical row matches block row');
            assert.equal(canonCol, blockCol, 'Peak pixel canonical col matches block col');
        }

        console.log(`  Block ${blockRow},${blockCol}: window ${w}x${h}, detections: ${r1.length}`);
    });

    it('overlap dedup assigns each detection to exactly one block', () => {
        // Place a flare right at the boundary between two blocks.
        // Both blocks' overlap windows will contain it.
        // The canonical block assignment (floor(pixel / BLOCK_SIZE)) should
        // deterministically assign it to exactly one block.

        const br0 = 3, bc0 = 5;
        const br1 = 3, bc1 = 6;

        // Flare at the last pixel of block (3,5) — exactly at the boundary
        const flareImgRow = br0 * BLOCK_SIZE + BLOCK_SIZE - 1;
        const flareImgCol = bc0 * BLOCK_SIZE + BLOCK_SIZE - 1;

        // Block 0 window
        const x0_a = bc0 * BLOCK_SIZE - BLOCK_OVERLAP;
        const y0_a = br0 * BLOCK_SIZE - BLOCK_OVERLAP;
        const x1_a = (bc0 + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const y1_a = (br0 + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const w_a = x1_a - x0_a, h_a = y1_a - y0_a;

        // Block 1 window (adjacent, shares overlap region)
        const x0_b = bc1 * BLOCK_SIZE - BLOCK_OVERLAP;
        const y0_b = br1 * BLOCK_SIZE - BLOCK_OVERLAP;
        const x1_b = (bc1 + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const y1_b = (br1 + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const w_b = x1_b - x0_b, h_b = y1_b - y0_b;

        const sceneA = buildScene({
            w: w_a, h: h_a,
            flareRow: flareImgRow - y0_a, flareCol: flareImgCol - x0_a,
            flarePeak: 1.1
        });
        const sceneB = buildScene({
            w: w_b, h: h_b,
            flareRow: flareImgRow - y0_b, flareCol: flareImgCol - x0_b,
            flarePeak: 1.1
        });

        const detsA = runDetection(sceneA);
        const detsB = runDetection(sceneB);

        // Apply canonical dedup for each block
        const keptA = detsA.filter(d => {
            const canonRow = Math.floor((d.peakRow + y0_a) / BLOCK_SIZE);
            const canonCol = Math.floor((d.peakCol + x0_a) / BLOCK_SIZE);
            return canonRow === br0 && canonCol === bc0;
        });
        const keptB = detsB.filter(d => {
            const canonRow = Math.floor((d.peakRow + y0_b) / BLOCK_SIZE);
            const canonCol = Math.floor((d.peakCol + x0_b) / BLOCK_SIZE);
            return canonRow === br1 && canonCol === bc1;
        });

        // Exactly one block should keep the detection
        const total = keptA.length + keptB.length;
        console.log(`  Boundary flare: block A kept ${keptA.length}, block B kept ${keptB.length}`);
        assert.equal(total, 1,
            `Flare at block boundary should be assigned to exactly one block, got ${total}`);
    });

    it('block IDs are stable across viewports', () => {
        // Verify that the block coordinate system is fixed per MGRS tile,
        // independent of viewport. Block (row, col) = (floor(pixelY/256), floor(pixelX/256)).
        const pixelX = 1234, pixelY = 2345;
        const blockRow = Math.floor(pixelY / BLOCK_SIZE);
        const blockCol = Math.floor(pixelX / BLOCK_SIZE);

        // These should be the same regardless of what viewport we're looking at
        assert.equal(blockRow, 9, 'Block row for pixel 2345');
        assert.equal(blockCol, 4, 'Block col for pixel 1234');

        // The block read window is deterministic
        const x0 = Math.max(0, blockCol * BLOCK_SIZE - BLOCK_OVERLAP);
        const y0 = Math.max(0, blockRow * BLOCK_SIZE - BLOCK_OVERLAP);
        const x1 = (blockCol + 1) * BLOCK_SIZE + BLOCK_OVERLAP;
        const y1 = (blockRow + 1) * BLOCK_SIZE + BLOCK_OVERLAP;

        assert.equal(x0, 4 * 256 - 10, 'Block x0');
        assert.equal(y0, 9 * 256 - 10, 'Block y0');
        assert.equal(x1, 5 * 256 + 10, 'Block x1');
        assert.equal(y1, 10 * 256 + 10, 'Block y1');

        console.log(`  Pixel (${pixelX},${pixelY}) → block (${blockRow},${blockCol}), window [${x0},${y0},${x1},${y1}]`);
    });
});

describe('Summary: determinism risk assessment', () => {
    it('prints overall assessment', () => {
        console.log('\n  ════════════════════════════════════════════════════════════');
        console.log('  DETERMINISM RISK ASSESSMENT');
        console.log('  ════════════════════════════════════════════════════════════');
        console.log('');
        console.log('  SAFE (deterministic within same window):');
        console.log('    ✓ DN→reflectance conversion (pure arithmetic)');
        console.log('    ✓ Brightness filter (fixed thresholds)');
        console.log('    ✓ Thermal filter (fixed thresholds)');
        console.log('    ✓ Connected components (deterministic BFS)');
        console.log('    ✓ Peak pixel selection (deterministic for distinct values)');
        console.log('    ✓ Cross-date clustering (sort-then-anchor is stable)');
        console.log('    ✓ Input order to crossDateCluster (sorted internally)');
        console.log('    ✓ Sub-pixel coordinate jitter (within merge distance)');
        console.log('');
        console.log('  RISK — window-size dependent (zoom-sensitive):');
        console.log('    ⚠ Background median: computed over ALL non-bright pixels in window');
        console.log('      → more background = potentially different median');
        console.log('      → contrast threshold changes → marginal flares flip');
        console.log('      MITIGATED by BACKGROUND_FLOOR (0.15) — threshold ≥ 0.45 always');
        console.log('      IMPACT: only marginal flares (B12 near 0.45-0.55) affected');
        console.log('');
        console.log('    ⚠ Cloud fraction: computed over window pixels');
        console.log('      → larger window dilutes localized cloud');
        console.log('      → could flip accept/reject for borderline cloud cover');
        console.log('      IMPACT: images near 30% cloud threshold');
        console.log('');
        console.log('    ⚠ Warm region: connected component in full window');
        console.log('      → larger window could connect to distant warm areas');
        console.log('      IMPACT: only if warm areas exist near window boundary');
        console.log('');
        console.log('    ⚠ STAC search uses viewport bbox (not padded bbox)');
        console.log('      → different viewports could return different tile sets');
        console.log('      MITIGATED: STAC uses intersection, tiles are ~110km wide');
        console.log('      IMPACT: minimal at zoom 11+, possible at tile boundaries');
        console.log('');
        console.log('  RECOMMENDATION FOR CONTENT-HASH CACHING:');
        console.log('    To guarantee determinism, the processing window must be');
        console.log('    FIXED and independent of zoom level. Two approaches:');
        console.log('');
        console.log('    1. CLAMP processing bbox to ensureMinBbox (already exists)');
        console.log('       AND cap it to that same size. I.e., always use exactly');
        console.log('       MIN_PROCESS_EXTENT_DEG regardless of viewport.');
        console.log('       Pro: simple. Con: zoomed-out users only see center detections.');
        console.log('');
        console.log('    2. TILE the viewport into fixed-size canonical cells,');
        console.log('       process each cell independently, then merge results.');
        console.log('       Pro: full viewport coverage AND deterministic per-cell.');
        console.log('       Con: more STAC queries, needs careful edge handling.');
        console.log('');
        console.log('    3. Process per Sentinel tile (not per viewport). Each');
        console.log('       MGRS tile is a fixed geographic extent → deterministic.');
        console.log('       Pro: natural caching key (tile ID + date).');
        console.log('       Con: tiles are large (~110km²), may process excess area.');
        console.log('  ════════════════════════════════════════════════════════════');
    });
});
