// S2 archive reader — reads precomputed Sentinel-2 SWIR flare detections straight
// from the CloudFerro public parquet archive (hive-partitioned by preset/mgrs/date)
// via vendored DuckDB-WASM. The viewport's tiles+dates are enumerated with a STAC
// search (no bucket LIST needed — anonymous listing is denied); the parquet objects
// that exist are range-read directly. Zero npm dependencies.
import { searchSTAC } from './vendor/s2-flares/lib/stac.js';

let conn = null, _initPromise = null, _base = '', _preset = 'loose';
// the archive is immutable per session, so every probe/read is cached forever:
const _exists = new Map(); // object url -> bool (HEAD probe)
const _rows = new Map();   // object url -> detections[] (whole tile, parsed once)
const _stac = new Map();   // snapped-bbox+dates key -> Promise<Map<url,{mgrs,date}>>
const SNAP = 0.5;          // degrees; snap the viewport out to this grid so local pans reuse the STAC enumeration

export function isReady() { return !!conn; }

/** Init DuckDB-WASM and remember the archive base URL + preset. */
export function initS2Archive(base, preset = 'loose') {
    _base = base.replace(/\/$/, '');
    _preset = preset;
    return _initPromise ??= _init();
}

async function _init() {
    const duckdb = await import('./vendor/duckdb/duckdb-browser.mjs');
    const b = new URL('.', import.meta.url).href;
    const blob = new Blob([`importScripts("${b}vendor/duckdb/duckdb-browser-eh.worker.js");`], { type: 'text/javascript' });
    const db = new duckdb.AsyncDuckDB({ log: () => {} }, new Worker(URL.createObjectURL(blob)));
    await db.instantiate(b + 'vendor/duckdb/duckdb-eh.wasm');
    conn = await db.connect();
    await conn.query(`SET enable_http_metadata_cache=true`);
    await conn.query(`SET enable_object_cache=true`);
}

const objUrl = (mgrs, date) => `${_base}/flares/preset=${_preset}/mgrs=${mgrs}/date=${date}/data.parquet`;
const num = v => v == null ? null : Number(v);

/**
 * Enumerate the parquet objects covering a viewport, cached by the viewport
 * snapped out to the SNAP grid + date range. Panning within a snapped cell reuses
 * the STAC search (and the wider snapped area means the tiles are pre-fetched), so
 * local navigation issues no further STAC requests.
 */
function enumScenes(bbox, startDate, endDate) {
    const [w, s, e, n] = bbox;
    const lo = (v, f) => f(v / SNAP) * SNAP;
    const snap = [lo(w, Math.floor), lo(s, Math.floor), lo(e, Math.ceil), lo(n, Math.ceil)];
    const key = [...snap, startDate, endDate].join(',');
    let p = _stac.get(key);
    if (!p) _stac.set(key, p = (async () => {
        const scenes = new Map(); // url -> { mgrs, date }
        for await (const it of searchSTAC(snap, startDate, endDate))
            scenes.set(objUrl(it.mgrs, it.date), { mgrs: it.mgrs, date: it.date });
        return scenes;
    })());
    return p;
}

/** Read whole tiles (no bbox filter) once and cache their parsed rows by object url. */
async function readTiles(urls) {
    for (const u of urls) _rows.set(u, []); // empty tiles still cache as "read"
    const list = urls.map(u => `'${u}'`).join(',');
    const res = await conn.query(`
        SELECT mgrs, CAST(date AS VARCHAR) AS date, lon, lat,
               max_b12, avg_b12, max_b11 AS peak_b11, b12_b11_ratio, pixels,
               sun_elevation, sun_azimuth, glint_angle, glint_score
        FROM read_parquet([${list}], hive_partitioning=true)
    `);
    for (let i = 0; i < res.numRows; i++) {
        const r = res.get(i);
        const mgrs = String(r.mgrs), date = String(r.date).slice(0, 10);
        _rows.get(objUrl(mgrs, date))?.push({
            date, mgrs, block_id: mgrs, block_row: 0, block_col: 0,
            flare_lon: Number(r.lon), flare_lat: Number(r.lat),
            max_b12: Number(r.max_b12), avg_b12: Number(r.avg_b12), pixels: Number(r.pixels),
            peak_b11: num(r.peak_b11), b12_b11_ratio: num(r.b12_b11_ratio),
            sun_elevation: num(r.sun_elevation), sun_azimuth: num(r.sun_azimuth),
            glint_angle: num(r.glint_angle), glint_score: num(r.glint_score),
        });
    }
}

/**
 * Read all archived detections within a viewport bbox and date range.
 * Returns { detections, observations } shaped for crossDateCluster: detections use
 * burnoff field names (flare_lon/flare_lat, block_id=mgrs); observations is one
 * record per existing scene (a cloud-free pass, the persistence denominator).
 *
 * STAC enumeration and per-tile parquet reads are both cached, so panning within an
 * already-visited region is a pure in-memory bbox filter — no network requests.
 */
export async function queryS2Archive(bbox, startDate, endDate) {
    if (!conn) throw new Error('S2 archive not initialized');

    const scenes = await enumScenes(bbox, startDate, endDate);
    const urls = [...scenes.keys()];
    await Promise.all(urls.filter(u => !_exists.has(u)).map(u =>
        fetch(u, { method: 'HEAD' }).then(r => _exists.set(u, r.ok)).catch(() => _exists.set(u, false))));
    const live = urls.filter(u => _exists.get(u));
    if (!live.length) return { detections: [], observations: [] };

    const missing = live.filter(u => !_rows.has(u));
    if (missing.length) await readTiles(missing);

    // Assemble from cache; filter to the live viewport bbox client-side.
    const [w, s, e, n] = bbox;
    const detections = [];
    for (const u of live)
        for (const d of _rows.get(u) || [])
            if (d.flare_lon >= w && d.flare_lon <= e && d.flare_lat >= s && d.flare_lat <= n)
                detections.push(d);
    const observations = live.map(u => ({ block_id: scenes.get(u).mgrs, date: scenes.get(u).date, cloudFree: true }));
    return { detections, observations };
}
