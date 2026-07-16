// module worker body: parquet fetch + decode off the ui thread. rows are
// filtered worker-side (inside core.read) so only matches cross the boundary;
// structured clone carries the bigints/dates in rows and footer.
import * as core from './data-core.js';

onmessage = async ({ data: { id, op, name, opts } }) => {
    try { postMessage({ id, ok: true, result: await core[op](name, opts) }); }
    catch (e) { postMessage({ id, ok: false, error: String(e?.message ?? e) }); }
};
