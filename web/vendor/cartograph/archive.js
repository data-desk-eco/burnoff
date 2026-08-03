// The archive publishes what it contains. <base>/index.json is one small object
// mapping table -> provider -> the partition key that provider's table is
// addressed by, or null when it is a single data.parquet:
//
//   <base>/<provider>/<table>/data.parquet                   key null
//   <base>/<provider>/<table>/<key>=<value>/data.parquet     key named
//
// A map fetches it once and then names exact objects. That is what removes the
// three things a cross-provider read used to need: a glob whose wildcard is the
// first path segment (no literal prefix to narrow on, so the browser paginates
// the whole bucket before reading a byte), a single read_parquet([...]) over
// enumerated URLs (one missing object fails all of them), and a provider list
// hardcoded in every app.
//
// JSON rather than Parquet so the fetch overlaps the ~6 MB DuckDB download
// instead of queueing behind it — and so curl, jq and read_json see it too.

let base, doc;

/** Fetch the index once. Idempotent, independent of the DuckDB connection, and
 *  safe to call at module parse. Returns the document. */
export function initArchive(url) {
    base = String(url).replace(/\/+$/, '');
    return doc ??= fetch(`${base}/index.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`archive index: HTTP ${r.status}`)))
        .catch(err => { doc = null; throw err; });
}

/** Every object of `table` the caller can name: one URL per provider that
 *  publishes it whole, plus each partitioned provider addressed at `key` — the
 *  partition value, which a reader computes from a position or carries on a row.
 *  A partitioned provider is left out when no key is given, because an HTTPS URL
 *  cannot expand a glob and a table too big to name is not one to read whole.
 *
 *  URLs, not rows: the caller keeps its own Promise.allSettled, so a provider
 *  that has not published costs its own rows and nothing else. */
export async function objects(table, { key, provider } = {}) {
    // through initArchive, not the memo: a fetch that failed cleared it, and
    // reading the cleared memo reported "call initArchive first" for what was
    // really an HTTP 503. going back through it says what went wrong and retries.
    if (!base) throw new Error('archive: call initArchive(base) first');
    return Object.entries((await initArchive(base))[table] ?? {})
        .filter(([p, part]) => (!provider || p === provider) && (!part || key != null))
        .map(([p, part]) => `${base}/${p}/${table}/${part ? `${part}=${key}/` : ''}data.parquet`);
}
