import { scoreCluster, glintSuspect, glintScoreFromElevation } from './score.js';

const DEG_TO_RAD = Math.PI / 180;
const R_EARTH = 6371000;

function clusterHash(lat, lon) {
    const s = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function fastDistM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD * Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
    return R_EARTH * Math.sqrt(dLat * dLat + dLon * dLon);
}

// Glint discriminator threshold.
//
// Real flares are thermal emitters at ~1500–2000 K. Wien's law puts their peak radiance
// well into the SWIR-2 band, so peak B12 (2200 nm) substantially exceeds peak B11
// (1600 nm) — typical median ratios 1.3–2.5.
//
// Sun glint off metal reflects the *solar* spectrum, where irradiance at 2200 nm is
// lower than at 1600 nm. Median ratios sit around 0.9–1.05.
//
// Median (not max) is used because saturating clusters can have rogue dates where one
// band edges over before the other, pushing the max spuriously high. The median across
// many detections is robust and makes glint vs thermal a clean separation.
//
// Empirical median-ratio distribution from gaslight Permian clusters:
//   glint cluster medians: 1.00, 1.09, 1.13, 1.19  (4 known suspect/confirmed glints)
//   real flare medians:    1.42, 1.80, 1.95         (3 confirmed Diamondback well pads)
// The 1.19 ↔ 1.42 gap is wide and bimodal, so a threshold of 1.25 separates them
// cleanly with safety margin on both sides.
const GLINT_B12_B11_RATIO = 1.25;     // median peak B12/B11 must exceed this to count as thermal

/**
 * Check whether all detections fall within April–August (months 3–7, 0-indexed).
 * @param {Array<{date: string}>} detections
 * @returns {boolean}
 */
export function isSeasonal(detections) {
    const sunny = new Set([3, 4, 5, 6, 7]); // Apr(3)–Aug(7) (JS months 0-indexed)
    const months = new Set(detections.map(d => new Date(d.date + 'T00:00').getUTCMonth()));
    for (const m of months) { if (!sunny.has(m)) return false; }
    return true;
}

/**
 * Spatially cluster cross-date detections into persistent flare sites.
 *
 * Each cluster carries TWO complementary glint signals:
 *   - the SPECTRAL discriminator (median_b12_b11_ratio / likely_glint, glintMetrics)
 *     — a robust median-ratio test, proven on gaslight clusters, has unit tests;
 *   - the vision-validated quality SCORE (ratio_score / persistence_score /
 *     glint_penalty / total_score, scoreCluster) — whose geometric min_glint keys
 *     off sun elevation. They measure glint different ways and are both attached.
 *
 * @param {Array<object>} detections - Per-date detection records. Coordinate fields
 *   may be `lon`/`lat` (s2-flares) or `flare_lon`/`flare_lat` (burnoff); both are
 *   handled. Required fields: lon/lat (or flare_lon/flare_lat), date, max_b12, pixels.
 * @param {object} [options]
 * @param {number} [options.mergeDistance=135] - Merge radius in metres.
 * @param {number} [options.minDates=4] - Minimum unique detection dates to keep a cluster.
 * @param {number} [options.minAvgB12=0.85] - Minimum mean B12 (per-date max) to keep a cluster.
 * @param {Map<string, {cloudFree: boolean}>|null} [options.observations=null] - Optional
 *   map from date strings to observation metadata. When provided, persistence is computed
 *   as detection_count / cloud_free_observations, and the cloud-free count is the
 *   denominator for persistence_score. When null, persistence (and persistence_score) is 0.
 * @param {number} [options.scoreThreshold=0] - quality-score gate. When > 0, clusters
 *   with total_score below this are dropped. 0 keeps everything (scores still attached).
 * @returns {Array<object>} Array of cluster objects, each carrying the spectral glint
 *   metrics (median_b12_b11_ratio, min_sun_elevation, likely_glint) and the quality-score
 *   components (ratio_score, persistence_score, glint_penalty, total_score, max_ratio,
 *   min_glint, glint_suspect).
 */
export function clusterDetections(detections, options = {}) {
    const {
        mergeDistance = 135,
        minDates = 4,
        minAvgB12 = 0.85,
        observations = null,
        scoreThreshold = 0,
    } = options;

    if (detections.length === 0) return [];

    // Cloud-free observation budget: a single global denominator for the
    // persistence_score component (the n_clear_obs denominator).
    let cloudFreeCount = 0;
    if (observations !== null) {
        for (const meta of observations.values()) if (meta.cloudFree) cloudFreeCount++;
    }

    // Build the quality score + its aggregates for one cluster's deduped detections.
    const scoreOf = (deduped, peakB12) => {
        let minGlint = null, maxRatio = null;
        for (const d of deduped) {
            // Glint from sun_elevation (the single source of truth) so peer-synced
            // detections — which carry sun_elevation but not a stored glint_score —
            // still get a signal; fall back to the stored score if elevation is absent.
            const gs = glintScoreFromElevation(d.sun_elevation) ?? d.glint_score ?? null;
            if (gs != null && !isNaN(gs)) {
                minGlint = minGlint == null ? gs : Math.min(minGlint, gs);
            }
            // Ratio from the precomputed field, else from max_b12/peak_b11 (main's name).
            const r = (d.b12_b11_ratio != null && isFinite(d.b12_b11_ratio)) ? d.b12_b11_ratio
                : (d.peak_b11 > 0 && d.max_b12 != null) ? d.max_b12 / d.peak_b11 : null;
            if (r != null && isFinite(r)) {
                maxRatio = maxRatio == null ? r : Math.max(maxRatio, r);
            }
        }
        const nDates = deduped.length;
        const sc = scoreCluster({ peakB12, maxRatio, nDates, nObs: cloudFreeCount, minGlint });
        return {
            ...sc,
            max_ratio: maxRatio,
            min_glint: minGlint,
            glint_suspect: glintSuspect({ minGlint, maxRatio, nDates }),
        };
    };

    if (mergeDistance === 0) {
        const clusters = [];
        for (const det of detections) {
            if (det.max_b12 < minAvgB12) continue;
            const lon = det.lon ?? det.flare_lon;
            const lat = det.lat ?? det.flare_lat;
            const detOut = {
                date: det.date,
                max_b12: det.max_b12,
                peak_b11: det.peak_b11 ?? null,
                pixels: det.pixels,
                sun_elevation: det.sun_elevation ?? null,
                sun_azimuth: det.sun_azimuth ?? null,
                lon,
                lat,
            };
            const score = scoreOf([det], det.max_b12);
            if (scoreThreshold > 0 && score.total_score < scoreThreshold) continue;
            clusters.push({
                id: clusterHash(lat, lon),
                lon,
                lat,
                max_b12: det.max_b12,
                avg_b12: det.max_b12,
                detection_count: 1,
                date_count: 1,
                first_date: det.date,
                last_date: det.date,
                persistence: cloudFreeCount > 0 ? 1 / cloudFreeCount : null,
                seasonal: isSeasonal([det]),
                ...glintMetrics([detOut]),
                ...score,
                detections: [detOut],
            });
        }
        return clusters;
    }

    // Sort by max_b12 descending so highest-intensity detections become anchors.
    const sorted = detections.slice().sort((a, b) => b.max_b12 - a.max_b12);

    const CELL_DEG = mergeDistance / 111320;
    const grid = new Map();
    const clusterList = [];
    const KEY_SHIFT = 0x100000;

    for (const det of sorted) {
        const lon = det.lon ?? det.flare_lon;
        const lat = det.lat ?? det.flare_lat;
        const gRow = Math.floor(lat / CELL_DEG);
        const gCol = Math.floor(lon / CELL_DEG);
        let bestIdx = -1, bestDist = Infinity;

        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const key = (gRow + dr) * KEY_SHIFT + (gCol + dc);
                const bucket = grid.get(key);
                if (!bucket) continue;
                for (const ci of bucket) {
                    const a = clusterList[ci].anchor;
                    const aLon = a.lon ?? a.flare_lon;
                    const aLat = a.lat ?? a.flare_lat;
                    const d = fastDistM(lat, lon, aLat, aLon);
                    if (d <= mergeDistance && d < bestDist) {
                        bestDist = d;
                        bestIdx = ci;
                    }
                }
            }
        }

        if (bestIdx >= 0) {
            clusterList[bestIdx].members.push(det);
        } else {
            const ci = clusterList.length;
            clusterList.push({ anchor: det, members: [det] });
            const key = gRow * KEY_SHIFT + gCol;
            const bucket = grid.get(key);
            if (bucket) bucket.push(ci);
            else grid.set(key, [ci]);
        }
    }

    const result = [];
    for (const cluster of clusterList) {
        const members = cluster.members;

        // Deduplicate: keep best detection per date.
        const byDate = {};
        for (const d of members) {
            if (!byDate[d.date] || d.max_b12 > byDate[d.date].max_b12) byDate[d.date] = d;
        }
        const deduped = Object.values(byDate);

        if (deduped.length < minDates) continue;

        const avgB12 = deduped.reduce((s, d) => s + d.max_b12, 0) / deduped.length;
        if (avgB12 < minAvgB12) continue;

        // Anchor = highest B12 detection.
        let anchor = deduped[0];
        for (const d of deduped) { if (d.max_b12 > anchor.max_b12) anchor = d; }

        const anchorLon = anchor.lon ?? anchor.flare_lon;
        const anchorLat = anchor.lat ?? anchor.flare_lat;

        const dates = deduped.map(d => d.date).sort();
        const firstDate = dates[0];
        const lastDate = dates[dates.length - 1];

        const seasonal = isSeasonal(deduped);

        // Persistence calculation (real cloud-free denominator).
        let persistence = null;
        if (observations !== null) {
            persistence = cloudFreeCount > 0 ? deduped.length / cloudFreeCount : null;
        }

        // vision-validated quality score (scored on the full deduped records).
        const score = scoreOf(deduped, anchor.max_b12);
        if (scoreThreshold > 0 && score.total_score < scoreThreshold) continue;

        const dedupedOut = deduped.map(d => ({
            date: d.date,
            max_b12: d.max_b12,
            peak_b11: d.peak_b11 ?? null,
            pixels: d.pixels,
            sun_elevation: d.sun_elevation ?? null,
            sun_azimuth: d.sun_azimuth ?? null,
            lon: d.lon ?? d.flare_lon,
            lat: d.lat ?? d.flare_lat,
        }));

        result.push({
            id: clusterHash(anchorLat, anchorLon),
            lon: anchorLon,
            lat: anchorLat,
            max_b12: anchor.max_b12,
            avg_b12: avgB12,
            detection_count: deduped.length,
            date_count: deduped.length,
            first_date: firstDate,
            last_date: lastDate,
            persistence,
            seasonal,
            ...glintMetrics(dedupedOut),
            ...score,
            detections: dedupedOut,
        });
    }

    return result;
}

/**
 * Compute glint-discriminator fields from a cluster's detections.
 *
 *   median_b12_b11_ratio — median of peak_b12/peak_b11 across all detections that have
 *                          a valid B11 reading. Robust to one-off outliers from staggered
 *                          band saturation. > GLINT_B12_B11_RATIO ⇒ thermal source.
 *   min_sun_elevation    — lowest sun elevation seen across detections. Display only;
 *                          tank-rim glint occurs at any sun angle, so this is context,
 *                          not a logic input.
 *   likely_glint         — true when the median spectral ratio falls below the thermal
 *                          threshold. Returns null when no detections carry B11 data
 *                          (legacy detections, missing band reads, etc.).
 */
function glintMetrics(detections) {
    const ratios = [];
    let minSunElev = Infinity, haveSun = false;
    for (const d of detections) {
        if (d.peak_b11 != null && d.peak_b11 > 0 && d.max_b12 != null) {
            ratios.push(d.max_b12 / d.peak_b11);
        }
        if (d.sun_elevation != null) {
            if (d.sun_elevation < minSunElev) minSunElev = d.sun_elevation;
            haveSun = true;
        }
    }

    let median_b12_b11_ratio = null;
    if (ratios.length > 0) {
        ratios.sort((a, b) => a - b);
        const mid = Math.floor(ratios.length / 2);
        median_b12_b11_ratio = ratios.length % 2 === 0
            ? (ratios[mid - 1] + ratios[mid]) / 2
            : ratios[mid];
    }

    const min_sun_elevation = haveSun ? minSunElev : null;
    const likely_glint = median_b12_b11_ratio == null
        ? null
        : median_b12_b11_ratio < GLINT_B12_B11_RATIO;

    return { median_b12_b11_ratio, min_sun_elevation, likely_glint };
}
