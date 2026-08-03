// VNF (VIIRS Nightfire) data module — reads Parquet through Cartograph's
// DuckDB data layer. Remote URLs use range requests, column selection, and
// row-group statistics. Zero npm dependencies.
//
// Two tiers. The viewport reads eog/flares/data.parquet: one row per site,
// written in `cell` order so a bbox predicate prunes row groups spatially once
// the table is big enough to have more than one, with the site's own quarterly
// history nested in a `quarters` list. The UI's quarter window is applied over
// that list here rather than in the read — cartograph's where-builder only
// spans scalar columns.
//
// The daily series is read only per flare, on card open, via
// fetchVNFDetections. eog/detections is partitioned on `cell`, the H3
// resolution-1 index of the site's position, and sorted by site_id inside a
// cell — so a card touches one object and prunes to a row group of it. Nothing
// here computes an H3 index: the flares row carries the cell it was written
// under, which is why this module needs no bucket listing and no H3 library.
// eog/observations is partitioned the same way, and burnoff never reads it —
// the quarters list already carries the looks a rate divides by.
//
// It does not name an object either. The archive index states that eog/flares
// is one object and eog/detections is addressed by `cell`, so the path shape is
// the producer's to change.

import { read, meta } from './vendor/cartograph/data.js';
import { objects } from './vendor/cartograph/archive.js';
import { quarterOf } from './vendor/cartograph/util.js';
import { sumQuarters } from './clustering.js';

let _flares = null, _initPromise = null, _ready = false;

export function isReady() { return _ready; }

const COLS = ['id', 'lat', 'lon', 'cell', 'country', 'detail', 'quarters'];
// a quarter key is the first day of its quarter, so the span the picker gives
// selects exactly the quarters it ticked
const inWindow = (start, end) => q => q >= start && q <= end;

/**
 * Initialize VNF: resolve eog/flares against the archive index and open it
 * (remote: footer bytes only) so viewport queries can range-read row groups.
 */
export function initVNF() {
    return _initPromise ??= (async () => {
        [_flares] = await objects('flares', { provider: 'eog' });
        await meta(_flares);
        _ready = true;
    })();
}

/** Reset state so initVNF can be called again. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _flares = null;
}

// One feature per flare, its quarters summed over the window (detections load
// per flare on card open, so features carry none).
function siteFeatures(rows, startDate, endDate, { detectedOnly = false } = {}) {
    const keep = inWindow(startDate, endDate);
    const sites = [];
    for (const r of rows) {
        const t = sumQuarters(r.quarters, keep);
        // the old rollup was one row per flare-quarter, so a flare with nothing
        // in the window never came back at all — keep that
        if (!t.n) continue;
        // any night the site was seen lit, cloudy ones included — a flare only
        // ever caught under cloud still burned, and dropping it would be a
        // false negative
        if (detectedOnly && !t.detections) continue;
        sites.push({
            id: r.id, lat: Number(r.lat), lon: Number(r.lon), cell: r.cell,
            country: r.country || '', detail: r.detail || '',
            detection_dates: t.detections_clear, detection_any: t.detections,
            passes: t.observations, observations: t.clear, max_rh: t.rh_max,
            // share of the window's nights we read the sky for, over the exact
            // night count (`days`), not a 91-night approximation. low means a
            // platform was grounded over this site — see
            // data-desk/docs/archive/observations.md
            coverage: t.days ? t.observations / t.days : 0,
            // rh_sum spans every detection, cloudy nights included, so its mean
            // divides by detection_any — not the clear-night count
            avg_rh: t.detections ? t.rh_sum / t.detections : 0,
        });
    }
    sites.sort((a, b) => b.max_rh - a.max_rh);
    return {
        type: 'FeatureCollection',
        features: sites.map(({ lat, lon, ...p }) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { ...p, lat, lon },
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
    const rows = await read(_flares,
        { columns: COLS, where: { lat: [south, north], lon: [west, east] } });
    return siteFeatures(rows, startDate, endDate, { detectedOnly: true });
}

/**
 * Query a single VNF flare by ID (for deep links).
 * Returns a GeoJSON FeatureCollection with 0 or 1 features.
 */
export async function queryVNFFlare(flareId, startDate, endDate) {
    if (!_ready) throw new Error('VNF not initialized');
    const id = String(flareId);
    const rows = await read(_flares, { columns: COLS, where: { id: [id, id] } });
    return siteFeatures(rows, startDate, endDate);
}

/**
 * Daily detection history for one flare (card open) — the only reader of the
 * daily series. Every row in detections is one night the site was seen lit,
 * cloudy nights included, so there is nothing to filter: the nights nobody
 * caught it are observations rows and live in another table. Full history; the
 * card windows it to the selected quarters.
 *
 * The site's cell is the whole of the addressing — one object, and inside it
 * the site_id predicate prunes to a row group off the footer statistics. The
 * cell rides on the feature, so a card names its object without computing an H3
 * index and without a listing.
 */
export async function fetchVNFDetections({ id, cell }) {
    if (!id || !cell) return [];
    const rows = await read((await objects('detections', { provider: 'eog', key: cell }))[0],
        { columns: ['date', 'rh_mw'], where: { site_id: [String(id), String(id)] } });
    return rows.map(r => ({ date: String(r.date).slice(0, 10), rh_mw: Number(r.rh_mw) || 0 }))
        .sort((a, b) => a.date < b.date ? -1 : 1);
}

/** Set of `year_quarter` keys with any detection in the viewport over [start,end]. */
export async function availableQuartersVNF(bbox, startDate, endDate) {
    if (!_ready) return new Set();
    const [west, south, east, north] = bbox;
    const rows = await read(_flares, { columns: ['lat', 'lon', 'quarters'],
        where: { lat: [south, north], lon: [west, east] } });
    const keep = inWindow(startDate, endDate);
    const qs = new Set();
    for (const r of rows) for (const q of r.quarters ?? [])
        if (q.detections > 0 && keep(q.quarter)) qs.add(quarterOf(q.quarter));
    return qs;
}
