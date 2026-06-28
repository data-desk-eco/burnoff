// Terminal grid + the pure feature-builders shared across modes: the S2 archive
// view (archiveFeature), VNF (enrichVNFFeatures), and naming for the cross-date
// clusterer (findNearestTerminal). Terminal features come from terminals.geojson
// via setTerminals(). No app/CRDT state — crossDateCluster stays in app.js since it
// reads the processedMap.

export const DEG_TO_RAD = Math.PI / 180;
const R_EARTH = 6371000;
const TERMINAL_MATCH_M = 7500;

// Fast equirectangular distance — accurate to <0.1% under 1 km and below ~70° lat.
export function fastDistM(lat1, lon1, lat2, lon2) {
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

export function getTerminals() { return _terminals; }

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
        const facilityName = p.facility_name || '';
        const facilityType = p.facility_type || '';
        const typeCat = [p.type, p.category].filter(Boolean).join(' — ');
        const name = facilityName || (terminal ? terminal.name : typeCat || `Flare #${p.flare_id}`);

        const passes = p.total_dates;
        const detection_count = p.detection_dates;
        const observations = Math.max(p.clear_dates, detection_count);
        const persistence = observations > 0 ? detection_count / observations : 0;

        result.push({
            type: 'Feature',
            geometry: feat.geometry,
            properties: {
                name,
                terminal: terminal?.name || null,
                facility_type: facilityType,
                facility_name: facilityName,
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
