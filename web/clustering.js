// Terminal grid + the pure feature-builders shared across modes: the S2 archive
// view (archiveFeature), VNF (enrichVNFFeatures), and naming for the cross-date
// clusterer (findNearestTerminal). Terminal features come from terminals.geojson
// via setTerminals(). No app/CRDT state — crossDateCluster lives in detect.js
// since it reads the processedMap.

import { dateInQuarters } from './vendor/cartograph/util.js';

export const DEG_TO_RAD = Math.PI / 180;
const R_EARTH = 6371000;
const TERMINAL_MATCH_M = 7500;
// the denominator is ours now: a night counts as read when a satellite flew and
// we sampled the sky at the site's overpass hours, so a low share means one
// platform was grounded over this site — not eog's silence, and no longer the
// calendar running past the cloud series, which now ends where it does. it is a
// per-site gate: whole quarters average 0.86–1.00 read, and what falls below is
// the sites under an outage. below it, persistence is not a number we have.
const COVERAGE_MIN = 0.8;
// s2: the same floor the archive applies to the whole-window count. a quarter
// selection can thin the looks the same way a sparse tile does, and a rate off
// three looks is noise — report the count and no rate.
const MIN_LOOKS = 10;

// Fast equirectangular distance — accurate to <0.1% under 1 km and below ~70° lat.
function fastDistM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD * Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
    return R_EARTH * Math.sqrt(dLat * dLat + dLon * dLon);
}

// Pre-built grid index for terminal features, rebuilt when terminals load.
let _terminals = [];
let _terminalGrid = null;
let _terminalGridCell = 0;

export function setTerminals(features) {
    _terminals = features || [];
    const cell = TERMINAL_MATCH_M / 111320;       // degrees per grid cell
    _terminalGridCell = cell;
    const g = new Map();
    for (const f of _terminals) {
        const [lon, lat] = f.geometry.coordinates;
        const r = Math.floor(lat / cell), c = Math.floor(lon / cell);
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const key = (r + dr) * 0x100000 + (c + dc);
                const bucket = g.get(key);
                if (bucket) bucket.push(f);
                else g.set(key, [f]);
            }
        }
    }
    _terminalGrid = g;
}

export function findNearestTerminal(lat, lon) {
    if (!_terminalGrid || _terminals.length === 0) return null;
    const cell = _terminalGridCell;
    const r = Math.floor(lat / cell), c = Math.floor(lon / cell);
    const key = r * 0x100000 + c;
    const bucket = _terminalGrid.get(key);
    if (!bucket) return null;
    let best = null, bestDist = Infinity;
    for (const f of bucket) {
        const [tLon, tLat] = f.geometry.coordinates;
        const d = fastDistM(lat, lon, tLat, tLon);
        if (d < bestDist) { bestDist = d; best = f; }
    }
    return best && bestDist <= TERMINAL_MATCH_M ? { name: best.properties.name, distance: bestDist } : null;
}

// Both flares tables publish one `quarters` struct, so both modes window it the
// same way. `clear` is the cloud-free day count a rate divides by; the wider
// `observations` is every day an instrument looked, and `detections_clear` is
// the only numerator that pairs with `clear`. Keeping the three in one reducer
// is what stops a caller redefining persistence without changing how it reads.
// `n` is the number of quarters kept — 0 means the window measured nothing,
// which is not the same as measuring zero.
//
// mind the grain: days/observations/clear count days, detections and
// detections_clear count ROWS. only eog writes one row per site-day, so a
// data-desk rate off these can exceed 1 and its caller has to clamp.
//
// a field comes back null unless EVERY quarter in the window carried it. a
// producer states what it did not measure by writing null, and summing that as
// zero turns "we never counted the passes" into "no pass was ever made" — which
// a caller then reads as a measurement. that is what a whole map of null
// persistences looks like. an empty window keeps the zeroes; `n` says so.
const SUMS = ['days', 'observations', 'clear', 'detections', 'detections_clear', 'rh_sum'];
export function sumQuarters(quarters, keep) {
    const t = { n: 0, rh_max: 0 }, seen = {};
    for (const k of SUMS) { t[k] = 0; seen[k] = 0; }
    for (const q of quarters ?? []) {
        if (!keep(q.quarter)) continue;
        t.n++;
        for (const k of SUMS) if (q[k] != null) { t[k] += Number(q[k]); seen[k]++; }
        t.rh_max = Math.max(t.rh_max, Number(q.rh_max ?? 0));
    }
    for (const k of SUMS) if (seen[k] < t.n) t[k] = null;
    return t;
}

// Map an archive flares row (data-desk/flares/data.parquet) to the same Feature
// shape crossDateCluster emits, so rendering/detail/CSV are unchanged. The table
// is pre-clustered server-side, so the avg-B12 slider gates these rows
// client-side and the merge-distance/score controls don't re-run.
//
// the table publishes the looks persistence divides by, split by calendar
// quarter, so a selection sums the quarters it shows and divides the detections
// in them by exactly those looks. that keeps numerator and denominator over the
// same looks, which neither the old back-calculation (detections ÷ a rounded
// ratio) nor the old proration did. the per-date series is no longer nested on
// the row — the card fetches it from data-desk/detections when it opens.
export function archiveFeature(c, qKeys = new Set()) {
    const terminal = findNearestTerminal(c.lat, c.lon);
    // the quarter key is a date in its own quarter, so the same predicate windows
    // both sides. no quarters published (the rescore measured nothing) → no rate.
    const t = sumQuarters(c.quarters, q => dateInQuarters(q, qKeys));
    // a producer with no clear-sky pair gets every pass as its denominator: wider,
    // and a rate that reads a shade low, not no rate at all. `observations` stays
    // null there so the card says cloud-free is unknown rather than claiming it.
    // sentinel-2 takes the first branch — what it cannot say is how many passes
    // there were, not which of them were clear.
    const clear = t.clear != null;
    const detection_count = clear ? t.detections_clear : t.detections;
    const looks = t.n ? (clear ? t.clear : t.observations) : null;
    const observations = clear ? t.clear : null;
    // clamped because the numerator counts detection rows and s2 can write
    // several blobs for one site on one day, while the denominator counts days
    const persistence = looks >= MIN_LOOKS
        ? Math.min(1, detection_count / looks) : null;
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
            name: terminal ? terminal.name : `${detection_count} detection${detection_count !== 1 ? 's' : ''}`,
            terminal: terminal?.name || null,
            lat: c.lat, lon: c.lon,   // exact coords for detail/highlight
            id: c.id, cell: c.cell, country: c.country || '', detail: c.detail || '',
            // a data-desk extension column, not part of the shared flares
            // schema — the ramp and the intensity gate both fail soft if the
            // producer stops writing it. see render.js and config.js
            max_b12: c.max_b12,
            detection_count, persistence, passes: t.n ? t.observations : null, observations,
            // what the persistence gate ranks on. the median quarter carries
            // four looks, so narrowing to one puts 90% of sites under MIN_LOOKS
            // and a slider that empties the map when you pick a quarter is not a
            // filter. the site's published whole-history rate stands in, and the
            // card still shows '—' for a window it could not rate. a site the
            // archive never rated at all has neither, and scores 0.
            rank: persistence ?? c.persistence ?? 0,
        },
    };
}

// Filter + name VNF flare features; minRh is the avg-RH slider gate.
export function enrichVNFFeatures(features, minRh) {
    const result = [];
    for (const feat of features) {
        const p = feat.properties;
        const [lon, lat] = feat.geometry.coordinates;

        if (minRh > 0 && p.avg_rh < minRh) continue;

        const terminal = findNearestTerminal(lat, lon);
        // `detail` is what type and category used to be, joined by the producer
        const name = terminal ? terminal.name : p.detail || `Flare #${p.id}`;

        // both restricted to nights we could see, so the ratio is a rate. the
        // old max() guarded a numerator larger than its denominator, which the
        // archive can no longer produce; what it left behind was a window
        // holding no clear night at all reading 0% — never seen is not unlit.
        const detection_count = p.detection_dates;
        const observations = p.observations;
        // null, not 0, where we read too little of the window to divide by, or
        // never caught the site under clear sky: an unmeasured flare is not an
        // unlit one. the card renders it as '—' and the persistence layer
        // filter drops it rather than ranking it.
        const persistence = p.coverage < COVERAGE_MIN || observations === 0
            ? null : detection_count / observations;

        result.push({
            type: 'Feature',
            geometry: feat.geometry,
            properties: {
                name,
                terminal: terminal?.name || null,
                lat, lon,   // exact coords for detail/highlight
                id: p.id,
                cell: p.cell,
                detail: p.detail || '',
                country: p.country || '',
                avg_rh: p.avg_rh,
                max_rh: p.max_rh,
                detection_count,
                passes: p.passes,
                observations,
                persistence,
            }
        });
    }
    return result;
}
