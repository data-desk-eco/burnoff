// parquet backend (hyparquet + decompressors, expected as a sibling vendor
// dir: ../hyparquet/). relative paths are fetched whole; absolute http(s)
// urls are range-read — the footer first, then only the row groups a read
// touches (override per call with {range}). environment-agnostic: runs
// inside data-worker.js in browsers, inline via data.js elsewhere.

const HYP = new URL('../hyparquet/', import.meta.url).href;
const DDB = new URL('../duckdb/', import.meta.url).href;   // duckdb-wasm-lite release, sibling vendor dir

let lib;   // hyparquet + compressors module namespace, loaded on first open
const load = () => lib ??= Promise.all(
    [import(`${HYP}hyparquet.mjs`), import(`${HYP}hyparquet-compressors.mjs`)]
).then(([h, c]) => ({ ...h, ...c }));

let files = {}, base;
const opened = new Map();   // url -> promise<{h, file, meta}>

// start opening listed parquets at once (fetch before the first read needs
// them); `base` resolves relative paths (the page url when run in a worker)
export function initData({ files: f = {}, prefetch = [], base: b } = {}) {
    files = f;
    base = b ?? base;
    for (const n of prefetch) open(files[n]);
}

function open(url, range = /^https?:/i.test(url)) {
    return opened.get(url) ?? opened.set(url, (async () => {
        const h = await load();
        const src = base ? `${new URL(url, base)}` : url;
        const file = range ? h.cachedAsyncBuffer(await h.asyncBufferFromUrl({ url: src }))
                           : await fetch(src).then(r => r.arrayBuffer());
        return { h, file, meta: await h.parquetMetadataAsync(file) };
    })()).get(url);
}

// parquet footer metadata (row groups, column stats) — for remote urls this
// costs only the footer bytes
export const meta = (name, { range } = {}) => open(files[name] ?? name, range).then(o => o.meta);

// read rows as plain objects; `name` is a data.files key or a url.
// opts.where {col: [min, max]} (either bound nullable) prunes row groups via
// footer stats then filters rows; opts.columns limits the columns read
export async function read(name, { columns, where, range } = {}) {
    const { h, file, meta } = await open(files[name] ?? name, range);
    const parts = await Promise.all(spans(meta, where).map(([rowStart, rowEnd]) =>
        h.parquetReadObjects({ file, compressors: h.compressors, columns, rowStart, rowEnd })));
    const rows = parts.flat().map(norm);
    return where ? rows.filter(r => matches(r, where)) : rows;
}

// sql escalation: real sql over remote parquet when a map outgrows the
// hyparquet predicate scans above (client-side joins, arbitrary group-bys).
// nothing loads until the first query, then duckdb-wasm-lite (worker + wasm,
// ~4.4 MB brotli) is imported from the ../duckdb/ sibling vendor dir and kept
// alive. remote parquet needs no registration — `select * from 'https://…'`
// range-reads directly. rows normalise like read() (bigints/dates); see the
// duckdb-wasm-lite readme for the geometry/spatial predicates it ships.
let ddb;
export async function sql(query) {
    ddb ??= (async () => {
        const d = await import(`${DDB}duckdb-browser.mjs`);
        const db = new d.AsyncDuckDB(new d.VoidLogger(), new Worker(`${DDB}duckdb-browser-eh.worker.js`));
        await db.instantiate(`${DDB}duckdb-eh.wasm`);
        return db;
    })();
    const c = await (await ddb).connect();
    try { return (await c.query(query)).toArray().map(r => norm(r.toJSON())); }
    finally { await c.close(); }
}

// bigints -> numbers, dates -> iso strings (date-only at utc midnight),
// recursing into nested lists/structs
export const norm = v =>
    typeof v === 'bigint' ? Number(v)
    : v instanceof Date ? v.toISOString().replace('T00:00:00.000Z', '')
    : Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' && !ArrayBuffer.isView(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
    : v;

export const matches = (r, where) => Object.entries(where).every(([c, [lo, hi]]) =>
    r[c] != null && (lo == null || r[c] >= lo) && (hi == null || r[c] <= hi));

// [rowStart, rowEnd] spans of the row groups whose column stats may overlap
// `where`, adjacent survivors merged into one contiguous read; groups without
// stats are kept
export function spans(meta, where = {}) {
    const out = [];
    let row = 0;
    for (const g of meta.row_groups) {
        const n = Number(g.num_rows);
        const hit = Object.entries(where).every(([c, [lo, hi]]) => {
            const s = g.columns.find(x => x.meta_data?.path_in_schema[0] === c)?.meta_data?.statistics;
            return s?.min_value == null
                || ((hi == null || norm(s.min_value) <= hi) && (lo == null || norm(s.max_value) >= lo));
        });
        if (hit) out.at(-1)?.[1] === row ? out.at(-1)[1] = row + n : out.push([row, row + n]);
        row += n;
    }
    return out;
}

// rows with lat/lon columns -> point FeatureCollection (coords kept as
// properties too: geojson geometry gets quantized by the tile grid)
export function fc(data, { lat = 'lat', lon = 'lon' } = {}) {
    return {
        type: 'FeatureCollection',
        features: data.map(p => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(p[lon]), Number(p[lat])] },
            properties: p
        }))
    };
}
