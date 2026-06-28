// Cluster scoring — the SWIR flare-quality methodology, vision-validated on the
// permian-flaring bulk run (~/Research/permian-flaring, sql/30_score.sql).
//
// A cluster's quality is one number:
//
//     total_score = 0.50·ratio_score
//                 + 0.40·persistence_score·(0.1 + 0.9·ratio_score)
//                 − 0.40·min_glint_score
//
// Every term is detection-intrinsic — derived from signals the SWIR detector
// already produces (B12/B11 ratio, clear-sky persistence, sun geometry). There
// is no anchor/identity arm and no pattern-specific rule; downstream code gates
// on a single threshold.
//
// This supersedes the earlier openflaring step-function score (a brightness×ratio
// staircase plus a flat additive persistence term). An unbiased 2,826-site aerial
// study (Sonnet land-use labels over a representative random draw) reframed it:
//   • the B12/B11 ratio is the strongest precision signal — oil_gas share climbs
//     27 % (ratio < 1.3) → 75 % (1.7–2.5) — so it earns a smooth ramp, not a step;
//   • peak B12 brightness is FLAT in-range (~31 % at every level): a recall floor,
//     not a ranking term, so it is dropped from the score entirely;
//   • clear-sky persistence discriminates at every ratio level, but its weight
//     ramps with the ratio (a small 0.1 floor keeps dim-but-real pads ordered);
//   • the cluster-MINIMUM glint score penalises near-nadir specular geometry.
//
// permian-flaring fronts this score with three hard gates (far-from-facility,
// on-building, on-road). Those need OGIM / building-footprint / road ground
// layers that aren't available client-side, so they don't port here — the host
// app keeps its own recall floor (burnoff's avg-B12 gate) and this score stays
// display-only / an optional threshold. Note the binary sync codec does not carry
// b12_b11_ratio, so peer-synced/legacy detections have a null ratio and score on
// persistence·0.1 − glint alone (a documented limitation until the codec adds it).

// ─── Spectral ratio (the strongest precision signal) ─────────────────────────
// Real flames are blackbody-hot: a hot flare that does not saturate B11 shows an
// elevated B12/B11 ratio. Sun glint off flat surfaces is spectrally flat (≈ 1).
// ratio_score ramps 0→1 over [RATIO_FLOOR, RATIO_FLOOR + RATIO_SPAN] (= 1.1→1.7).
export const RATIO_FLOOR = 1.1;
export const RATIO_SPAN = 0.6;

// ─── Term weights (permian-flaring sql/30_score.sql, 2026-06-09 rebuild) ──────
export const W_RATIO = 0.50;
export const W_PERSIST = 0.40;
export const PERSIST_FLOOR = 0.10;   // persistence still scores when ratio_score ≈ 0
export const W_GLINT = 0.40;

// ─── Per-detection glint-suspect rule ────────────────────────────────────────
// Parity with openflaring's glint_suspect: high glint geometry, flat spectral
// ratio, and seen only once.
export const GLINT_SCORE_SUSPECT = 0.6;
export const GLINT_RATIO_SUSPECT = 1.3;

// ─── Glint geometry ──────────────────────────────────────────────────────────
// glint_score is a pure function of sun elevation, so it never needs to be
// stored or synced — recompute it from the (already-persisted) sun_elevation
// wherever it's needed. This is the single source of truth (detect.js re-exports
// these so callers can annotate detections at detection time).

// Angle between the specularly-reflected sun direction and a nadir view. For S2
// the view zenith is small (≤ 10°), so treating the view as nadir makes this just
// the sun zenith (90 − elevation).
export function glintAngleNadir(sunElevationDeg) {
    return 90.0 - Number(sunElevationDeg);
}

// Map a glint angle to a 0–1 score (1 = high glint risk). Specular cones are
// tight for water but broaden for rough metal roofs / tilted panels: 1.0 below
// 25°, fading linearly to 0 at 65°.
export function glintScoreFromAngle(glintAngleDeg) {
    const a = Number(glintAngleDeg);
    if (a <= 25.0) return 1.0;
    if (a >= 65.0) return 0.0;
    return (65.0 - a) / 40.0;
}

// glint_score straight from sun elevation (null when elevation is unknown,
// e.g. legacy detections from before the glint annotation existed).
export function glintScoreFromElevation(sunElevationDeg) {
    if (sunElevationDeg == null || isNaN(sunElevationDeg)) return null;
    return glintScoreFromAngle(glintAngleNadir(sunElevationDeg));
}

/** Ratio score in [0, 1]: a smooth ramp on the cluster's max B12/B11 ratio. */
export function ratioScore(maxRatio) {
    if (maxRatio == null || isNaN(maxRatio)) return 0;
    return Math.min(1.0, Math.max(0.0, (maxRatio - RATIO_FLOOR) / RATIO_SPAN));
}

/** Persistence score in [0, 1]: the clear-sky share lit, nDates / nObs. */
export function persistenceScore(nDates, nObs) {
    if (!nObs || nObs <= 0) return 0;
    return Math.min(1.0, nDates / nObs);
}

/**
 * Geometric glint penalty in [−W_GLINT, 0], linear in the cluster's **minimum**
 * per-detection glint_score.
 *
 * A real flare fires across many sun geometries over a long window, so its
 * min_glint drops low; geometric glint only lands when the sun-pixel geometry is
 * right, so its min_glint stays high. Cluster-max glint approaches 1.0 for most
 * things in winter sun and is a poor discriminator.
 */
export function glintPenalty(minGlint) {
    if (minGlint == null || isNaN(minGlint)) return 0;
    return -W_GLINT * Math.min(1.0, Math.max(0.0, Number(minGlint))) || 0;
}

/** Per-detection glint-suspect flag (high glint, flat ratio, single look). */
export function glintSuspect({ minGlint, maxRatio, nDates }) {
    if (minGlint == null || isNaN(minGlint)) return false;
    return minGlint >= GLINT_SCORE_SUSPECT
        && (maxRatio != null && !isNaN(maxRatio) && maxRatio < GLINT_RATIO_SUSPECT)
        && nDates <= 1;
}

/**
 * Score one cluster. Returns the two reward terms, the glint penalty, and the
 * weighted total. Brightness (peak B12) is intentionally not a term — it is the
 * recall floor (the host app's avg-B12 gate), not a ranking signal.
 *
 * @param {object} a
 * @param {number} a.maxRatio - max B12/B11 ratio across detections (null if unknown)
 * @param {number} a.nDates   - distinct detection dates
 * @param {number} a.nObs     - cloud-free observation budget (denominator)
 * @param {number} a.minGlint - min per-detection glint_score (null if unknown)
 */
export function scoreCluster({ maxRatio, nDates, nObs, minGlint }) {
    const ratio_score = ratioScore(maxRatio);
    const persistence_score = persistenceScore(nDates, nObs);
    const glint_penalty = glintPenalty(minGlint);
    const total_score =
        W_RATIO * ratio_score
        + W_PERSIST * persistence_score * (PERSIST_FLOOR + (1 - PERSIST_FLOOR) * ratio_score)
        + glint_penalty;
    return { ratio_score, persistence_score, glint_penalty, total_score };
}
