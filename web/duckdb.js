// Shared DuckDB-WASM bootstrap for the VNF and S2-archive Parquet readers.
// Returns { db, conn }. A non-https `localFile` (dev) is fetched whole and
// registered as a buffer; otherwise httpfs caching is enabled for efficient
// remote row-group range reads. Zero npm dependencies (vendored bundle).

export async function openDuckDB(localFile) {
    const duckdb = await import('./vendor/duckdb/duckdb-browser.mjs');
    // Absolute URLs — the worker runs in a Blob context.
    const base = new URL('.', import.meta.url).href;
    const blob = new Blob([`importScripts("${base}vendor/duckdb/duckdb-browser-eh.worker.js");`], { type: 'text/javascript' });
    const db = new duckdb.AsyncDuckDB({ log: () => {} }, new Worker(URL.createObjectURL(blob)));
    await db.instantiate(base + 'vendor/duckdb/duckdb-eh.wasm');
    const conn = await db.connect();

    if (localFile && !localFile.startsWith('https://')) {
        const buf = await (await fetch(localFile)).arrayBuffer();
        await db.registerFileBuffer(localFile, new Uint8Array(buf));
    } else {
        await conn.query(`SET enable_http_metadata_cache=true`);
        await conn.query(`SET enable_object_cache=true`);
    }
    return { db, conn };
}
