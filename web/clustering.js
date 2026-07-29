// Terminal grid + the pure feature-builders shared across modes: the S2 archive
// view (archiveFeature), VNF (enrichVNFFeatures), and naming for the cross-date
// clusterer (findNearestTerminal). Terminal features come from terminals.geojson
// via setTerminals(). No app/CRDT state — crossDateCluster lives in detect.js
// since it reads the processedMap.

export const DEG_TO_RAD = Math.PI / 180;
const R_EARTH = 6371000;
const TERMINAL_MATCH_M = 7500;
// the denominator is ours now: a night counts as read when a satellite flew and
// we sampled the sky at the site's overpass hours, so a low share means a
// platform outage or a stretch the cloud series has not reached yet — not eog's
// silence. quarters run 0.93–1.00 read, against 0.68 for one still filling, so
// the threshold sits in that gap. below it, persistence is not a number we have.
const COVERAGE_MIN = 0.8;

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

// Map a precomputed archive cluster (clusters/data.parquet row) to the same Feature
// shape crossDateCluster emits, so rendering/detail/CSV are unchanged. The view is
// pre-clustered server-side, so the avg-B12 slider gates these rows client-side and
// the merge-distance/score controls don't re-run. The view carries no cloud counts,
// only the published persistence, so we report the cloud-free observation count
// (detections / persistence) and leave passes null — there is no total-pass figure
// to compute a meaningful cloud-free fraction from.
export function archiveFeature(c) {
    const terminal = findNearestTerminal(c.lat, c.lon);
    const observations = c.persistence ? Math.round(c.detection_count / c.persistence) : c.date_count;
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
            name: terminal ? terminal.name : `${c.detection_count} detection${c.detection_count !== 1 ? 's' : ''}`,
            terminal: terminal?.name || null,
            lat: c.lat, lon: c.lon,   // exact coords for detail/highlight
            max_b12: c.max_b12, detection_count: c.detection_count, seasonal: c.seasonal,
            total_score: c.total_score, ratio_score: c.ratio_score,
            persistence_score: c.persistence_score, glint_penalty: c.glint_penalty,
            max_ratio: c.max_ratio, min_glint: c.min_glint, glint_suspect: c.glint_suspect,
            persistence: c.persistence, passes: null, observations,
            detections: c.detections.map(d => ({
                date: d.date, max_b12: d.max_b12, pixels: d.pixels,
                raw_lon: d.lon, raw_lat: d.lat, b12_corrected: d.max_b12,
            })),
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
        const typeCat = [p.type, p.category].filter(Boolean).join(' — ');
        const name = terminal ? terminal.name : typeCat || `Flare #${p.flare_id}`;

        const passes = p.profiled_dates;
        // both restricted to nights we could see, so the ratio is a rate. the
        // old max() guarded a numerator larger than its denominator, which the
        // archive can no longer produce; what it left behind was a window
        // holding no clear night at all reading 0% — never seen is not unlit.
        const detection_count = p.detection_dates;
        const observations = p.clear_dates;
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
                flare_id: p.flare_id,
                type: p.type || '',
                category: p.category || '',
                country: p.country || '',
                avg_rh: p.avg_rh,
                max_rh: p.max_rh,
                detection_count,
                passes,
                observations,
                persistence,
                detections: p.detections
            }
        });
    }
    return result;
}
