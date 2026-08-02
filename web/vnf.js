// VNF (VIIRS Nightfire) data module — reads Parquet through Cartograph's
// DuckDB data layer. Remote URLs use range requests, column selection, and
// row-group statistics. Zero npm dependencies.
//
// Two tiers. The viewport reads a small flare x quarter rollup
// (quarters.parquet, hilbert-ordered over (lon, lat) so a bbox prunes row
// groups spatially, windowed to the UI's quarter grid). The daily series is
// read only per flare, on card open, via fetchVNFDetections.
//
// That daily series is 64 spatial cells, not one file, and inside a cell the
// rows are sorted by (flare_id, date) — so a card reads one row group of
// one ~9 MB object behind a 114 KB footer. It used to be one 539 MB file
// hilbert-ordered end to end, where a flare's nights were scattered over a
// dozen row groups and a card decoded 559,574 rows to show 958 detections.
// flares.parquet carries the cell each flare lives in, so an id resolves to its
// object without listing the bucket.

import { read, meta } from './vendor/cartograph/data.js';
import { quarterOf } from './vendor/cartograph/util.js';

let _base = null, _initPromise = null, _ready = false;

export function isReady() { return _ready; }

const url = f => _base + f;
const COLS = ['flare_id', 'lat', 'lon', 'quarter', 'days', 'profiled_days', 'clear_days',
              'detected_days', 'detected_any_days', 'rh_sum', 'rh_max', 'type', 'category', 'country'];

/**
 * Initialize VNF: open the quarterly rollup (remote: footer bytes only) so
 * viewport queries can range-read row groups.
 * @param {string} base - URL or local path prefix of the vnf view, ending in a
 *   slash: the rollup, the flare index and data/cell=N/ hang off it
 */
export function initVNF(base) {
    _base = base;
    // The first detail card needs the flare-to-cell index before it can read
    // that flare's daily row group. Warm the small index while the quarterly
    // footer loads so the card does not serialize both requests.
    flareIndex().catch(err => console.warn('VNF flare index warm-up failed:', err));
    return _initPromise ??= meta(url('quarters.parquet')).then(() => { _ready = true; });
}

/** Reset state so initVNF can be called again with a different base. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _base = null;
    _flares = null;
}

let _flares = null;
const flareIndex = () => _flares ??= read(url('flares.parquet'))
    .then(rows => new Map(rows.map(r => [Number(r.flare_id), r])))
    .catch(err => { _flares = null; throw err; });

// Rollup rows grouped to one feature per flare with summed quarter aggregates
// (detections load per flare on card open, so features carry none).
function siteFeatures(rows, { detectedOnly = false } = {}) {
    const by = new Map();
    for (const r of rows) {
        let s = by.get(r.flare_id);
        if (!s) by.set(r.flare_id, s = {
            flare_id: Number(r.flare_id), lat: Number(r.lat), lon: Number(r.lon),
            type: '', category: '', country: '',
            total_dates: 0, profiled_dates: 0, clear_dates: 0, detection_dates: 0,
            detection_any: 0, rh_sum: 0, max_rh: 0, quarters: new Set(),
        });
        s.quarters.add(String(r.quarter));
        s.total_dates += Number(r.days);
        s.profiled_dates += Number(r.profiled_days);
        s.clear_dates += Number(r.clear_days);
        s.detection_dates += Number(r.detected_days);
        s.detection_any += Number(r.detected_any_days);
        s.rh_sum += Number(r.rh_sum);
        s.max_rh = Math.max(s.max_rh, Number(r.rh_max));
        for (const k of ['type', 'category', 'country']) s[k] ||= r[k] || '';
    }
    // any night the site was seen lit, cloudy ones included — a flare only ever
    // caught under cloud still burned, and dropping it would be a false negative
    const sites = [...by.values()].filter(s => !detectedOnly || s.detection_any > 0)
        .sort((a, b) => b.max_rh - a.max_rh);
    return {
        type: 'FeatureCollection',
        features: sites.map(({ lat, lon, rh_sum, quarters, ...p }) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                ...p, lat, lon,
                // share of the window's nights we read the sky for, over the
                // exact night count (`days`), not a 91-night approximation.
                // low means a platform was grounded over this site — see
                // data-desk/docs/archive/vnf.md
                coverage: p.total_dates ? p.profiled_dates / p.total_dates : 0,
                // rh_sum spans every detection, cloudy nights included, so its
                // mean divides by detection_any — not the clear-night count
                avg_rh: p.detection_any ? rh_sum / p.detection_any : 0,
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
    const rows = await read(url('quarters.parquet'), { columns: COLS,
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
    const rows = await read(url('quarters.parquet'), { columns: COLS,
        where: { flare_id: [Number(flareId), Number(flareId)], quarter: [startDate, endDate],
                 lat: [f.lat - 0.01, f.lat + 0.01], lon: [f.lon - 0.01, f.lon + 0.01] } });
    return siteFeatures(rows);
}

/**
 * Daily detection history for one flare (card open) — the only reader of the
 * daily series. It carries a row for every flare on every night from 2012-03 to
 * wherever the cloud series ends, lit or not, so the detected filter is what
 * keeps this small. Full history; the card filters to the quarter window.
 *
 * The flare's cell is the whole of the addressing: one object, and inside it
 * the flare_id predicate prunes to a row group off the footer statistics. There
 * is no lat/lon predicate any more — it was only ever standing in for an index
 * on a file sorted by position, and the daily rows no longer carry a position.
 * `detected` has to stay in `columns` as well as `where`: cartograph filters
 * rows on the values it read, and a column it never read reads as null.
 */
export async function fetchVNFDetections(flareId) {
    const f = (await flareIndex()).get(Number(flareId));
    if (!f) return [];
    const rows = await read(url(`data/cell=${Number(f.cell)}/data.parquet`),
        { columns: ['flare_id', 'date', 'detected', 'rh_mw'],
          where: { flare_id: [Number(flareId), Number(flareId)], detected: [true, true] } });
    return rows.map(r => ({ date: String(r.date).slice(0, 10), rh_mw: Number(r.rh_mw) || 0 }))
        .sort((a, b) => a.date < b.date ? -1 : 1);
}

/** Set of `year_quarter` keys with any detection in the viewport over [start,end]. */
export async function availableQuartersVNF(bbox, startDate, endDate) {
    if (!_ready) return new Set();
    const [west, south, east, north] = bbox;
    const rows = await read(url('quarters.parquet'),
        { columns: ['lat', 'lon', 'quarter', 'detected_any_days'],
          where: { lat: [south, north], lon: [west, east],
                   quarter: [startDate, endDate], detected_any_days: [1, null] } });
    return new Set(rows.map(r => quarterOf(r.quarter)));
}
