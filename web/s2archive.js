// S2 archive reader — reads precomputed Sentinel-2 SWIR flare detections straight
// from the CloudFerro public parquet archive (hive-partitioned by preset/mgrs/date)
// via vendored DuckDB-WASM. The viewport's tiles+dates are enumerated with a STAC
// search (no bucket LIST needed — anonymous listing is denied); the parquet objects
// that exist are range-read directly. Zero npm dependencies.
import { searchSTAC } from './vendor/s2-flares/lib/stac.js';

let conn = null, _initPromise = null, _base = '', _preset = 'loose';
const _exists = new Map(); // object url -> bool; archive is static per session, probe once

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
 * Read all archived detections within a viewport bbox and date range.
 * Returns { detections, observations } shaped for crossDateCluster: detections use
 * burnoff field names (flare_lon/flare_lat, block_id=mgrs); observations is one
 * record per existing scene (a cloud-free pass, the persistence denominator).
 */
export async function queryS2Archive(bbox, startDate, endDate) {
    if (!conn) throw new Error('S2 archive not initialized');

    // Enumerate viewport scenes via STAC, keep the parquet objects that exist.
    const scenes = new Map(); // url -> { mgrs, date }
    for await (const it of searchSTAC(bbox, startDate, endDate))
        scenes.set(objUrl(it.mgrs, it.date), { mgrs: it.mgrs, date: it.date });
    const urls = [...scenes.keys()];
    await Promise.all(urls.filter(u => !_exists.has(u)).map(u =>
        fetch(u, { method: 'HEAD' }).then(r => _exists.set(u, r.ok)).catch(() => _exists.set(u, false))));
    const live = urls.filter(u => _exists.get(u));
    if (!live.length) return { detections: [], observations: [] };

    const [w, s, e, n] = bbox;
    const list = live.map(u => `'${u}'`).join(',');
    const res = await conn.query(`
        SELECT mgrs, CAST(date AS VARCHAR) AS date, lon, lat,
               max_b12, avg_b12, max_b11 AS peak_b11, b12_b11_ratio, pixels,
               sun_elevation, sun_azimuth, glint_angle, glint_score
        FROM read_parquet([${list}], hive_partitioning=true)
        WHERE lon BETWEEN ${w} AND ${e} AND lat BETWEEN ${s} AND ${n}
    `);

    const detections = [];
    for (let i = 0; i < res.numRows; i++) {
        const r = res.get(i);
        const mgrs = String(r.mgrs);
        detections.push({
            date: String(r.date).slice(0, 10), mgrs, block_id: mgrs, block_row: 0, block_col: 0,
            flare_lon: Number(r.lon), flare_lat: Number(r.lat),
            max_b12: Number(r.max_b12), avg_b12: Number(r.avg_b12), pixels: Number(r.pixels),
            peak_b11: num(r.peak_b11), b12_b11_ratio: num(r.b12_b11_ratio),
            sun_elevation: num(r.sun_elevation), sun_azimuth: num(r.sun_azimuth),
            glint_angle: num(r.glint_angle), glint_score: num(r.glint_score),
        });
    }
    const observations = live.map(u => ({ block_id: scenes.get(u).mgrs, date: scenes.get(u).date, cloudFree: true }));
    return { detections, observations };
}
