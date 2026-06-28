// S2 archive reader — reads the precomputed Sentinel-2 SWIR flare *cluster view*
// straight from the CloudFerro public parquet archive (s2-flares `box.sh archive`).
// The archive co-produces a single derived view, `clusters/data.parquet`: one row per
// cluster (scalar score columns + a nested `detections` list). We range-read that one
// object with vendored DuckDB-WASM, load every cluster once, then serve each viewport
// from memory (bbox + date-overlap filter). Zero npm dependencies.

let conn = null, _initPromise = null, _base = '', _all = null;

export function isReady() { return !!conn; }

/** Init DuckDB-WASM and remember the archive base URL. */
export function initS2Archive(base) {
    _base = base.replace(/\/$/, '');
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

const num = v => v == null ? null : Number(v);

/** Load every cluster row once (the view is one small global object) and cache it. */
function loadAll() {
    return _all ??= (async () => {
        const res = await conn.query(`
            SELECT lon, lat, max_b12, avg_b12, detection_count, date_count,
                   CAST(first_date AS VARCHAR) AS first_date, CAST(last_date AS VARCHAR) AS last_date,
                   persistence, seasonal, ratio_score, persistence_score, glint_penalty,
                   total_score, max_ratio, min_glint, glint_suspect, to_json(detections) AS detections
            FROM read_parquet('${_base}/clusters/data.parquet')`);
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
    })();
}

/**
 * Precomputed clusters intersecting a viewport bbox + date window. The view is
 * clustered over the whole archive, so the date window is an overlap filter on each
 * cluster's [first_date, last_date]; the published scalar scores are passed through.
 */
export async function queryS2Archive(bbox, startDate, endDate) {
    if (!conn) throw new Error('S2 archive not initialized');
    const [w, s, e, n] = bbox;
    return (await loadAll()).filter(c =>
        c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n &&
        c.last_date >= startDate && c.first_date <= endDate);
}
