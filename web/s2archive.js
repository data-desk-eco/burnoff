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

let conn = null, _initPromise = null, _base = '', _tiles = null, _rings = null, _tilesPromise = null, _clusterTiles = null, _clusterBboxPromise = null;
const _tileCache = new Map();   // mgrs id -> Promise<cluster[]>
const overlaps = ([w, s, e, n], [tw, ts, te, tn]) => w <= te && e >= tw && s <= tn && n >= ts;

export function isReady() { return !!conn; }

// MGRS 100km-square id (e.g. "39RWJ") -> closed WGS84 corner ring [[lng,lat]×4, close].
// Used only for the coverage OUTLINE overlay: the nominal 100 km squares tile
// edge-to-edge without overlap, so their union draws the scanned footprint cleanly.
// (Cluster LOADING does NOT use these squares — a cluster's anchor can sit well
// outside its own tile's square, because the cluster inherits its anchor detection's
// S2 *granule* tile and granule footprints overhang the nominal square by ~10 km.
// Loading filters on each tile's TRUE data bbox instead; see loadClusterBboxes.)
const MGRS_COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];   // 100km easting letters, by (zone-1)%3
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';                 // 100km northing letters, period 2,000,000 m
const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX';                // 8° latitude bands from -80°
function mgrsTileRing(id) {
    const [, z, band, col, row] = /^(\d+)([C-X])([A-Z])([A-Z])$/.exec(id);
    const zone = +z, isNorth = band >= 'N';
    const east = (MGRS_COLS[(zone - 1) % 3].indexOf(col) + 1) * 1e5;
    let north = (MGRS_ROWS.indexOf(row) + (zone % 2 ? 0 : 15)) * 1e5;  // even zones start the row letters at 'F' (≡ −5, i.e. +15 mod 20)
    const ref = wgs84ToUtm((zone - 1) * 6 - 177, -80 + 8 * MGRS_BANDS.indexOf(band) + 4, zone, isNorth)[1];
    north += Math.round((ref - north) / 2e6) * 2e6;                    // resolve 2,000,000 m ambiguity via band
    const [e0, e1, n0, n1] = [east, east + 1e5, north, north + 1e5];
    const [sw, se, nw, ne] = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]]
        .map(([e, n]) => utmToWgs84(e, n, zone, isNorth));
    return [sw, se, ne, nw, sw];   // [lng,lat] ring
}
const ringBbox = r => [Math.min(...r.map(c => c[0])), Math.min(...r.map(c => c[1])),
                       Math.max(...r.map(c => c[0])), Math.max(...r.map(c => c[1]))];

/** True if the viewport bbox overlaps any archived MGRS tile. Unknown coverage ⇒ true (assume archived). */
export function isCovered(bbox) {
    if (!_tiles) return true;
    return _tiles.some(t => overlaps(bbox, t));
}

/** Resolves once the coverage footprint (MGRS tile listing) has been fetched. */
export function whenCovered() { return _tilesPromise || Promise.resolve(); }

/** One polygon Feature per archived MGRS tile, for the coverage outline overlay.
 *  Null until the tile listing lands. */
export function coverageTiles() {
    if (!_rings || !_rings.length) return null;
    return { type: 'FeatureCollection', features: _rings.map(r => ({
        type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [r] } })) };
}

/** Bucket listing at init: the `detections/mgrs=…` partitions are the coverage
 *  footprint. Pages through every key (ListObjectsV2 caps a response at 1000) so the
 *  coverage hint stays complete as the archive grows past one page. */
function loadTiles() {
    return _tilesPromise ??= (async () => {
        try {
            const ids = new Set(), clusters = new Set();
            for (let token = ''; ;) {
                const xml = await (await fetch(`${_base}?list-type=2&max-keys=1000`
                    + (token && `&continuation-token=${encodeURIComponent(token)}`))).text();
                for (const m of xml.matchAll(/detections\/mgrs=(\d+[C-X][A-Z]{2})/g)) ids.add(m[1]);
                for (const m of xml.matchAll(/clusters\/mgrs=(\d+[C-X][A-Z]{2})/g)) clusters.add(m[1]);
                if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
                token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? '';
                if (!token) break;
            }
            _clusterTiles = [...clusters].map(id => ({
                id, key: `${_base}/clusters/mgrs=${id}/data.parquet`, bbox: ringBbox(mgrsTileRing(id)) }));
            _rings = [...ids].map(mgrsTileRing);
            _tiles = _rings.map(ringBbox);
        } catch { _tiles = null; _rings = null; _clusterTiles = null; }
    })();
}

// Refine each cluster tile's bbox to its TRUE data extent (min/max lon/lat of the
// clusters it holds), read once from the parquet footer statistics — DuckDB answers
// min/max from metadata alone, so this is footer-only range reads, not full scans.
// Replaces the old nominal-square + fixed-pad guess, which under-covered granule
// overhang (a cluster anchor can sit ~10 km outside its tile's square) and so dropped
// edge clusters once the viewport zoomed past the square. On query failure the nominal
// square set in loadTiles remains as a (smaller) fallback. Runs after conn is ready.
function loadClusterBboxes() {
    return _clusterBboxPromise ??= (async () => {
        await loadTiles();
        if (!conn || !_clusterTiles?.length) return;
        try {
            const list = _clusterTiles.map(t => `'${t.key}'`).join(',');
            const res = await conn.query(`
                SELECT regexp_extract(filename, 'mgrs=([0-9A-Z]+)', 1) AS mgrs,
                       min(lon) AS w, min(lat) AS s, max(lon) AS e, max(lat) AS n
                FROM read_parquet([${list}], filename = true) GROUP BY 1`);
            const by = new Map();
            for (let i = 0; i < res.numRows; i++) {
                const r = res.get(i);
                by.set(String(r.mgrs), [Number(r.w), Number(r.s), Number(r.e), Number(r.n)]);
            }
            for (const t of _clusterTiles) t.bbox = by.get(t.id) ?? t.bbox;
        } catch (err) { console.error('S2 archive cluster-bbox stats failed:', err); }
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
    await loadClusterBboxes();   // tile list (listing) + true per-tile data bboxes (footer stats)
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
