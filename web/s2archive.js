// S2 archive reader — reads the precomputed Sentinel-2 SWIR flare *cluster view*
// straight from the CloudFerro public parquet archive (s2-flares `box.sh archive`).
// The archive co-produces a derived cluster view partitioned by MGRS tile,
// `clusters/mgrs=<tile>/data.parquet`: one row per cluster (scalar score columns + a
// nested `detections` list). We enumerate those per-tile objects from the bucket
// listing, then range-read only the tiles a viewport overlaps with vendored
// DuckDB-WASM — each tile's parquet is loaded once, lazily, and cached. Viewports
// are then served from those cached tiles (bbox + date-overlap filter). Zero npm deps.

import { wgs84ToUtm, utmToWgs84 } from './s2/geo.js';
import { openDuckDB } from './duckdb.js';

let conn = null, _initPromise = null, _base = '', _tiles = null, _coverage = null, _tilesPromise = null, _clusterTiles = null;
const _tileCache = new Map();   // mgrs id -> Promise<cluster[]>
const overlaps = ([w, s, e, n], [tw, ts, te, tn]) => w <= te && e >= tw && s <= tn && n >= ts;

export function isReady() { return !!conn; }

// MGRS 100km-square id (e.g. "39RWJ") -> closed WGS84 corner ring [[lng,lat]×4, close].
// Used only to bound which per-tile cluster parquet a viewport overlaps (range-read
// gating); the coverage *display* + isCovered() come from the published coverage.geojson
// (the real scanned AOI boxes), not these squares.
const MGRS_COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];   // 100km easting letters, by (zone-1)%3
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';                 // 100km northing letters, period 2,000,000 m
const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX';                // 8° latitude bands from -80°
// granule overhang: S2 granules are 109,800 m, so a cluster anchor can sit up to
// (109800−100000)/2 = 4,900 m outside its tile's nominal square (most visibly across a
// UTM zone seam, e.g. Yamal LNG at 72°E). Pad the range-read footprint by that, else a
// viewport zoomed past the nominal square skips the tile holding an overhanging cluster.
const GRANULE_PAD = 4900;
function mgrsTileRing(id, pad = 0) {
    const [, z, band, col, row] = /^(\d+)([C-X])([A-Z])([A-Z])$/.exec(id);
    const zone = +z, isNorth = band >= 'N';
    const east = (MGRS_COLS[(zone - 1) % 3].indexOf(col) + 1) * 1e5;
    let north = (MGRS_ROWS.indexOf(row) + (zone % 2 ? 0 : 15)) * 1e5;  // even zones start the row letters at 'F' (≡ −5, i.e. +15 mod 20)
    const ref = wgs84ToUtm((zone - 1) * 6 - 177, -80 + 8 * MGRS_BANDS.indexOf(band) + 4, zone, isNorth)[1];
    north += Math.round((ref - north) / 2e6) * 2e6;                    // resolve 2,000,000 m ambiguity via band
    const [e0, e1, n0, n1] = [east - pad, east + 1e5 + pad, north - pad, north + 1e5 + pad];
    const [sw, se, nw, ne] = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]]
        .map(([e, n]) => utmToWgs84(e, n, zone, isNorth));
    return [sw, se, ne, nw, sw];   // [lng,lat] ring
}
const ringBbox = r => [Math.min(...r.map(c => c[0])), Math.min(...r.map(c => c[1])),
                       Math.max(...r.map(c => c[0])), Math.max(...r.map(c => c[1]))];

/** True if the viewport bbox overlaps a scanned AOI box. Unknown coverage ⇒ true (assume archived). */
export function isCovered(bbox) {
    if (!_tiles) return true;
    return _tiles.some(t => overlaps(bbox, t));
}

/** Resolves once the coverage geojson has been fetched. */
export function whenCovered() { return _tilesPromise || Promise.resolve(); }

/** The published scanned-AOI boxes (coverage.geojson) for the coverage overlay.
 *  Null until it lands / if absent. */
export function coverageTiles() {
    return _coverage && _coverage.features.length ? _coverage : null;
}

/** Init fetch: (1) page the `clusters/mgrs=…` listing (ListObjectsV2 caps at
 *  1000/response) to know which per-tile parquet a viewport can range-read; (2) load
 *  the published coverage.geojson — the real scanned AOI boxes — for the overlay + the
 *  isCovered() test. Independent: a missing coverage.geojson leaves data loading intact
 *  (isCovered then falls back to assume-covered). */
function loadTiles() {
    return _tilesPromise ??= (async () => {
        try {
            const clusters = new Set();
            for (let token = ''; ;) {
                const xml = await (await fetch(`${_base}?list-type=2&max-keys=1000`
                    + (token && `&continuation-token=${encodeURIComponent(token)}`))).text();
                for (const m of xml.matchAll(/clusters\/mgrs=(\d+[C-X][A-Z]{2})/g)) clusters.add(m[1]);
                if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
                token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? '';
                if (!token) break;
            }
            _clusterTiles = [...clusters].map(id => ({
                id, key: `${_base}/clusters/mgrs=${id}/data.parquet`, bbox: ringBbox(mgrsTileRing(id, GRANULE_PAD)) }));
        } catch { _clusterTiles = null; }
        try {
            _coverage = await (await fetch(`${_base}/coverage.geojson`)).json();
            _tiles = _coverage.features.map(f => ringBbox(f.geometry.coordinates[0]));
        } catch { _coverage = null; _tiles = null; }
    })();
}

/** Init DuckDB-WASM and remember the archive base URL. */
export function initS2Archive(base) {
    _base = base.replace(/\/$/, '');
    return _initPromise ??= _init();
}

async function _init() {
    loadTiles();   // fire-and-forget; isCovered assumes archived until the listing lands
    ({ conn } = await openDuckDB());   // archive is always remote (https)
}

const num = v => v == null ? null : Number(v);

/** Load one MGRS tile's cluster parquet once, lazily, and cache it by tile id. */
function loadTile(t) {
    if (!_tileCache.has(t.id)) _tileCache.set(t.id, (async () => {
        const res = await conn.query(`
            SELECT lon, lat, max_b12, avg_b12, detection_count, date_count,
                   CAST(first_date AS VARCHAR) AS first_date, CAST(last_date AS VARCHAR) AS last_date,
                   persistence, seasonal, ratio_score, persistence_score, glint_penalty,
                   total_score, max_ratio, min_glint, glint_suspect, to_json(detections) AS detections
            FROM read_parquet('${t.key}')`);
        const out = [];
        for (let i = 0; i < res.numRows; i++) {
            const r = res.get(i);
            out.push({
                lon: Number(r.lon), lat: Number(r.lat),
                max_b12: Number(r.max_b12), avg_b12: Number(r.avg_b12),
                detection_count: Number(r.detection_count), date_count: Number(r.date_count),
                first_date: String(r.first_date).slice(0, 10), last_date: String(r.last_date).slice(0, 10),
                persistence: num(r.persistence), seasonal: !!r.seasonal,
                ratio_score: num(r.ratio_score), persistence_score: num(r.persistence_score),
                glint_penalty: num(r.glint_penalty), total_score: num(r.total_score),
                max_ratio: num(r.max_ratio), min_glint: num(r.min_glint), glint_suspect: !!r.glint_suspect,
                detections: JSON.parse(r.detections).map(d => ({ ...d, date: String(d.date).slice(0, 10) })),
            });
        }
        return out;
    })());
    return _tileCache.get(t.id);
}

/** Clusters from every archived tile the viewport bbox overlaps (loaded lazily). */
async function loadViewport(bbox) {
    await loadTiles();   // the per-tile file list comes from the bucket listing
    const tiles = (_clusterTiles || []).filter(t => overlaps(bbox, t.bbox));
    return (await Promise.all(tiles.map(loadTile))).flat();
}

/**
 * Precomputed clusters intersecting a viewport bbox + date window. Only the archive
 * tiles the viewport overlaps are range-read (and cached), so a far-out or
 * uncovered viewport fetches nothing. The date window is an overlap filter on each
 * cluster's [first_date, last_date]; the published scalar scores are passed through.
 */
export async function queryS2Archive(bbox, startDate, endDate) {
    if (!conn) throw new Error('S2 archive not initialized');
    const [w, s, e, n] = bbox;
    return (await loadViewport(bbox)).filter(c =>
        c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n &&
        c.last_date >= startDate && c.first_date <= endDate);
}

/** Set of `year_quarter` keys that have any detection in the viewport (all dates). */
export async function availableQuartersS2(bbox) {
    if (!conn) return new Set();
    const [w, s, e, n] = bbox;
    const qs = new Set();
    for (const c of await loadViewport(bbox)) {
        if (c.lon < w || c.lon > e || c.lat < s || c.lat > n) continue;
        for (const d of c.detections) {
            const q = Math.floor((+d.date.slice(5, 7) - 1) / 3) + 1;
            qs.add(`${d.date.slice(0, 4)}_${q}`);
        }
    }
    return qs;
}
