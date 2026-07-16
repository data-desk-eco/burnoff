// VNF (VIIRS Nightfire) data module — reads a parquet file (local or remote)
// through cartograph's hyparquet data layer: remote urls are range-read
// (footer first, then only the row groups a query's bbox/date filter touches
// via row-group stats), local paths are fetched whole. Zero npm dependencies.

import { read, meta } from './vendor/cartograph/data.js';
import { quarterOf } from './vendor/cartograph/util.js';

let _url = null, _initPromise = null, _ready = false;

export function isReady() { return _ready; }

const COLS = ['flare_id', 'lat', 'lon', 'date', 'clear', 'detected', 'rh_mw', 'temp_k',
              'type', 'category', 'country'];

/**
 * Initialize the VNF parquet: open it (remote: footer bytes only) so
 * queries can range-read row groups.
 * @param {string} url - URL or local path to the parquet file
 */
export function initVNF(url) {
    return _initPromise ??= meta(_url = url).then(() => { _ready = true; });
}

/** Reset state so initVNF can be called again with a different URL. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _url = null;
}

// Per-site aggregation shared by the viewport and single-flare queries (the
// old duckdb GROUP BY in js): daily rows grouped to one feature per flare with
// clear/detected counts, first non-empty labels and an ordered detection list.
function siteFeatures(rows, { detectedOnly = false } = {}) {
    const by = new Map();
    for (const r of rows) {
        let s = by.get(r.flare_id);
        if (!s) by.set(r.flare_id, s = {
            flare_id: Number(r.flare_id), lat: Number(r.lat), lon: Number(r.lon),
            type: '', category: '', country: '',
            total_dates: 0, clear_dates: 0, detection_dates: 0, avg_rh: 0, max_rh: 0, detections: [],
        });
        s.total_dates++;
        if (r.clear) s.clear_dates++;
        if (r.detected) {
            s.detection_dates++;
            s.avg_rh += Number(r.rh_mw) || 0;
            s.max_rh = Math.max(s.max_rh, Number(r.rh_mw) || 0);
            s.detections.push({ date: String(r.date).slice(0, 10), rh_mw: Number(r.rh_mw) || 0, temp_k: Number(r.temp_k) || 0 });
        }
        for (const k of ['type', 'category', 'country']) s[k] ||= r[k] || '';
    }
    const sites = [...by.values()].filter(s => !detectedOnly || s.detection_dates > 0)
        .sort((a, b) => b.max_rh - a.max_rh);
    return {
        type: 'FeatureCollection',
        features: sites.map(({ lat, lon, detections, ...p }) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                ...p,
                avg_rh: p.detection_dates ? p.avg_rh / p.detection_dates : 0,
                detections: detections.sort((a, b) => a.date < b.date ? -1 : 1),
            },
        })),
    };
}

/**
 * Query VNF sites within a bounding box and date range.
 * Returns a GeoJSON FeatureCollection with per-site aggregated data.
 */
export async function queryVNF(bbox, startDate, endDate) {
    if (!_ready) throw new Error('VNF not initialized');
    const [west, south, east, north] = bbox;
    const rows = await read(_url, { columns: COLS,
        where: { lat: [south, north], lon: [west, east], date: [startDate, endDate] } });
    return siteFeatures(rows, { detectedOnly: true });
}

/**
 * Query a single VNF flare by ID (for deep links).
 * Returns a GeoJSON FeatureCollection with 0 or 1 features.
 */
export async function queryVNFFlare(flareId, startDate, endDate) {
    if (!_ready) throw new Error('VNF not initialized');
    const rows = await read(_url, { columns: COLS,
        where: { flare_id: [Number(flareId), Number(flareId)], date: [startDate, endDate] } });
    return siteFeatures(rows);
}

/** Set of `year_quarter` keys with any detection in the viewport over [start,end]. */
export async function availableQuartersVNF(bbox, startDate, endDate) {
    if (!_ready) return new Set();
    const [west, south, east, north] = bbox;
    const rows = await read(_url, { columns: ['lat', 'lon', 'date', 'detected'],
        where: { lat: [south, north], lon: [west, east], date: [startDate, endDate], detected: [true, true] } });
    return new Set(rows.map(r => quarterOf(r.date)));
}
