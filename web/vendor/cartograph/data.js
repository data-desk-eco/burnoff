// duckdb-wasm parquet backend (expected as a sibling vendor dir: ../duckdb/).
// parquet exports sized for the browser are fetched whole and registered as
// buffers; queries come back as plain row objects. the host page needs the
// importmap that remaps the duckdb bundle's /npm/... imports (see example/).

const DUCKDB = new URL('../duckdb/', import.meta.url).href;

let db, conn, opening;
const registered = new Map();   // name -> promise resolving once queryable
const prefetched = new Map();   // name -> arraybuffer promise
let files = {};

// start prefetching listed parquets at once (before the wasm is even loaded)
export function initData({ files: f = {}, prefetch = [] } = {}) {
    files = f;
    for (const n of prefetch) prefetched.set(n, fetch(files[n]).then(r => r.arrayBuffer()));
    opening ??= open();
    return opening;
}

async function open() {
    const duckdb = await import(`${DUCKDB}duckdb-browser.mjs`);
    // absolute url — the worker runs in a blob context
    const blob = new Blob([`importScripts("${DUCKDB}duckdb-browser-eh.worker.js");`], { type: 'text/javascript' });
    db = new duckdb.AsyncDuckDB({ log: () => {} }, new Worker(URL.createObjectURL(blob)));
    await db.instantiate(`${DUCKDB}duckdb-eh.wasm`);
    conn = await db.connect();
}

// ensure parquets are registered before querying them — no-ops when loaded.
// sql references them by name: `SELECT … FROM 'plumes.parquet'`
export function need(...names) {
    return Promise.all(names.map(n => registered.get(n) ?? registered.set(n, (async () => {
        const buf = await (prefetched.get(n) ?? fetch(files[n]).then(r => r.arrayBuffer()));
        await opening;
        await db.registerFileBuffer(`${n}.parquet`, new Uint8Array(buf));
    })()).get(n)));
}

export async function query(sql) {
    await opening;
    return rows(await conn.query(sql));
}

// arrow result -> plain row objects. `col.toArray()` returns the raw typed
// buffer and does NOT apply arrow's null bitmap, so null slots in numeric
// columns surface as garbage — carry the vector for nullable columns and emit
// real nulls via isValid(). bigints downcast to Number; nested values (list
// columns) come back as arrays via toJSON.
export function rows(result) {
    const n = result.numRows;
    if (n === 0) return [];
    const columns = result.schema.fields.map(f => {
        const col = result.getChild(f.name);
        return { name: f.name, col, arr: col.toArray(), nullable: col.nullCount > 0 };
    });
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const obj = {};
        for (const { name, col, arr, nullable } of columns) {
            let v = nullable && !col.isValid(i) ? null : arr[i];
            if (typeof v === 'bigint') v = Number(v);
            else if (v && typeof v === 'object' && typeof v.toJSON === 'function') v = v.toJSON();
            obj[name] = v;
        }
        out[i] = obj;
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
