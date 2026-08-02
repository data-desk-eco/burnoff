// S2 archive reader — reads the Data Desk Sentinel-2 flare tables straight from
// the CloudFerro public Parquet archive. `data-desk/flares/data.parquet` is one
// row per cluster: one object, so there is nothing to enumerate — the archive
// only partitions a table past 250 MB, and it partitions on `cell`, an H3
// index a reader calculates from a position rather than discovers by listing.
// The bucket listing this module used to page is gone with the mgrs= keys.
// The per-date series left the cluster row with it: it now lives in
// `data-desk/detections/data.parquet` and is read per cluster, on card open.
// `data-desk/coverage.geojson` gives the real scanned AOI boxes for the
// coverage test and the intro-modal worldmap. Zero npm dependencies.

import { read } from './vendor/cartograph/data.js';
import { quarterOf } from './vendor/cartograph/util.js';

let _base = '', _tiles = null, _coverage = null, _initPromise = null, _flares = null;
const overlaps = ([w, s, e, n], [tw, ts, te, tn]) => w <= te && e >= tw && s <= tn && n >= ts;
const inBox = ([w, s, e, n], c) => c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n;

export function isReady() { return !!_base; }

const url = f => `${_base}/${f}`;
const ringBbox = r => [Math.min(...r.map(c => c[0])), Math.min(...r.map(c => c[1])),
                       Math.max(...r.map(c => c[0])), Math.max(...r.map(c => c[1]))];

/** True if the viewport bbox overlaps a scanned AOI box. Unknown coverage ⇒ true (assume archived). */
export function isCovered(bbox) {
    if (!_tiles) return true;
    return _tiles.some(t => overlaps(bbox, t));
}

/** Resolves once the coverage geojson has been fetched. */
export function whenCovered() { return _initPromise || Promise.resolve(); }

/** The published scanned-AOI boxes (coverage.geojson) for the coverage overlay.
 *  Null until it lands / if absent. */
export function coverageTiles() {
    return _coverage && _coverage.features.length ? _coverage : null;
}

/** Remember the archive base URL and load the published coverage.geojson — the
 *  real scanned AOI boxes — for the overlay + the isCovered() test (memoized).
 *  Independent of the flare table: a missing coverage.geojson leaves data
 *  loading intact (isCovered then falls back to assume-covered). */
export function initS2Archive(base) {
    _base = base.replace(/\/$/, '');
    // the whole archive is one object, so start pulling it here rather than on
    // the first viewport: it downloads while maplibre loads its style and tiles
    flares().catch(err => console.warn('S2 archive warm-up failed:', err));
    return _initPromise ??= (async () => {
        try {
            _coverage = await (await fetch(url('data-desk/coverage.geojson'))).json();
            _tiles = _coverage.features.map(f => ringBbox(f.geometry.coordinates[0]));
        } catch { _coverage = null; _tiles = null; }
    })();
}

// One object for the whole archive, so read it once and hold the rows: every
// viewport, quarter indicator and re-score is then served from memory, where
// the old per-tile cache served only the tiles a viewport had already touched.
const flares = () => _flares ??= read(url('data-desk/flares/data.parquet'))
    .catch(err => { _flares = null; throw err; });

/**
 * Archive clusters intersecting a viewport bbox + date window. The date window
 * is an overlap filter on each cluster's [first_seen, last_seen]; the published
 * scalar columns are passed through.
 */
export async function queryS2Archive(bbox, startDate, endDate) {
    if (!_base) throw new Error('S2 archive not initialized');
    return (await flares()).filter(c => inBox(bbox, c) &&
        c.last_seen >= startDate && c.first_seen <= endDate);
}

/** Set of `year_quarter` keys that have any detection in the viewport (all dates). */
export async function availableQuartersS2(bbox) {
    if (!_base) return new Set();
    const qs = new Set();
    for (const c of await flares())
        if (inBox(bbox, c))
            // the quarters list carries the count the nested date list used to
            // be counted from, so this no longer walks every detection
            for (const q of c.quarters ?? []) if (q.detections > 0) qs.add(quarterOf(q.quarter));
    return qs;
}

/**
 * Per-date history for one cluster (card open). The flares row carries a
 * detection count, not a list, so the dates come from data-desk/detections —
 * one object today, filtered to this site. Rows there are written in
 * (cell, site_id, date) order, so passing the cluster's own `cell` alongside
 * its id prunes row groups off the footer instead of scanning the table; it is
 * also the address if the object ever partitions. `kind` is in the predicate
 * because this provider writes its methane plumes to the same table.
 */
export async function fetchS2Detections({ id, cell }) {
    if (!id) return [];
    const rows = await read(url('data-desk/detections/data.parquet'),
        { columns: ['date', 'lat', 'lon', 'max_b12', 'pixels'],
          where: { site_id: [String(id), String(id)], kind: ['flare', 'flare'],
                   ...(cell ? { cell: [cell, cell] } : {}) } });
    return rows.map(r => ({
        date: String(r.date).slice(0, 10),
        max_b12: Number(r.max_b12), b12_corrected: Number(r.max_b12),
        pixels: Number(r.pixels), raw_lon: Number(r.lon), raw_lat: Number(r.lat),
    })).sort((a, b) => a.date < b.date ? -1 : 1);
}
