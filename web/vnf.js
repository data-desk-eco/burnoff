// VNF (VIIRS Nightfire) data module — reads parquet (local or remote) through
// cartograph's hyparquet data layer: remote urls are range-read (footer first,
// then only the row groups a query's bbox/date filter touches via row-group
// stats). Zero npm dependencies.
//
// Two tiers, both hilbert-ordered over (lon, lat) so bbox reads prune row
// groups spatially: the viewport reads a small flare x quarter rollup
// (quarters.parquet, windowed to the UI's quarter grid); the big daily
// parquet is read only per flare, on card open, via fetchVNFDetections — so
// its multi-MB footer loads lazily behind the first card. flares.parquet
// (flare_id -> lat/lon) resolves ids to positions so per-flare reads can
// filter spatially too.

import { read, meta } from './vendor/cartograph/data.js';
import { quarterOf } from './vendor/cartograph/util.js';

let _url = null, _initPromise = null, _ready = false;

export function isReady() { return _ready; }

const sibling = f => _url.replace(/[^/]*$/, f);
const COLS = ['flare_id', 'lat', 'lon', 'quarter', 'days', 'clear_days',
              'detected_days', 'rh_sum', 'rh_max', 'type', 'category', 'country'];

/**
 * Initialize VNF: open the quarterly rollup (remote: footer bytes only) so
 * viewport queries can range-read row groups.
 * @param {string} url - URL or local path to the daily parquet (the rollup
 *   and flare index are resolved as siblings)
 */
export function initVNF(url) {
    _url = url;
    return _initPromise ??= meta(sibling('quarters.parquet')).then(() => { _ready = true; });
}

/** Reset state so initVNF can be called again with a different URL. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _url = null;
    _flares = null;
}

let _flares = null;
const flareIndex = () => _flares ??= read(sibling('flares.parquet'))
    .then(rows => new Map(rows.map(r => [Number(r.flare_id), r])));

// Rollup rows grouped to one feature per flare with summed quarter aggregates
// (detections load per flare on card open, so features carry none).
function siteFeatures(rows, { detectedOnly = false } = {}) {
    const by = new Map();
    for (const r of rows) {
        let s = by.get(r.flare_id);
        if (!s) by.set(r.flare_id, s = {
            flare_id: Number(r.flare_id), lat: Number(r.lat), lon: Number(r.lon),
            type: '', category: '', country: '',
            total_dates: 0, clear_dates: 0, detection_dates: 0, rh_sum: 0, max_rh: 0,
        });
        s.total_dates += Number(r.days);
        s.clear_dates += Number(r.clear_days);
        s.detection_dates += Number(r.detected_days);
        s.rh_sum += Number(r.rh_sum);
        s.max_rh = Math.max(s.max_rh, Number(r.rh_max));
        for (const k of ['type', 'category', 'country']) s[k] ||= r[k] || '';
    }
    const sites = [...by.values()].filter(s => !detectedOnly || s.detection_dates > 0)
        .sort((a, b) => b.max_rh - a.max_rh);
    return {
        type: 'FeatureCollection',
        features: sites.map(({ lat, lon, rh_sum, ...p }) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                ...p, lat, lon,
                avg_rh: p.detection_dates ? rh_sum / p.detection_dates : 0,
                detections: [],
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
    const rows = await read(sibling('quarters.parquet'), { columns: COLS,
        where: { lat: [south, north], lon: [west, east], quarter: [startDate, endDate] } });
    return siteFeatures(rows, { detectedOnly: true });
}

/**
 * Query a single VNF flare by ID (for deep links).
 * Returns a GeoJSON FeatureCollection with 0 or 1 features.
 */
export async function queryVNFFlare(flareId, startDate, endDate) {
    if (!_ready) throw new Error('VNF not initialized');
    const f = (await flareIndex()).get(Number(flareId));
    if (!f) return { type: 'FeatureCollection', features: [] };
    const rows = await read(sibling('quarters.parquet'), { columns: COLS,
        where: { flare_id: [Number(flareId), Number(flareId)], quarter: [startDate, endDate],
                 lat: [f.lat - 0.01, f.lat + 0.01], lon: [f.lon - 0.01, f.lon + 0.01] } });
    return siteFeatures(rows);
}

/**
 * Daily detection history for one flare (card open) — the only reader of the
 * big daily parquet. Full history; the card filters to the quarter window.
 */
export async function fetchVNFDetections(flareId) {
    const f = (await flareIndex()).get(Number(flareId));
    if (!f) return [];
    const rows = await read(_url, { columns: ['flare_id', 'lat', 'lon', 'date', 'detected', 'rh_mw'],
        where: { flare_id: [Number(flareId), Number(flareId)], detected: [true, true],
                 lat: [f.lat - 0.01, f.lat + 0.01], lon: [f.lon - 0.01, f.lon + 0.01] } });
    return rows.map(r => ({ date: String(r.date).slice(0, 10), rh_mw: Number(r.rh_mw) || 0 }))
        .sort((a, b) => a.date < b.date ? -1 : 1);
}

/** Set of `year_quarter` keys with any detection in the viewport over [start,end]. */
export async function availableQuartersVNF(bbox, startDate, endDate) {
    if (!_ready) return new Set();
    const [west, south, east, north] = bbox;
    const rows = await read(sibling('quarters.parquet'),
        { columns: ['lat', 'lon', 'quarter', 'detected_days'],
          where: { lat: [south, north], lon: [west, east],
                   quarter: [startDate, endDate], detected_days: [1, null] } });
    return new Set(rows.map(r => quarterOf(r.quarter)));
}
