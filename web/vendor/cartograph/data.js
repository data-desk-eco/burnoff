// same exports as data-core.js, with initData/meta/read proxied to a shared
// module worker so heavy decodes never block panning. falls back to inline
// data-core where module workers are unavailable (node tests, file://).
import * as core from './data-core.js';
export { norm, matches, spans, fc } from './data-core.js';

let worker = null, cfg, seq = 0;
const jobs = new Map();   // id -> {resolve, reject}

const rpc = (op, name, opts) => worker
    ? new Promise((resolve, reject) => {
        jobs.set(++seq, { resolve, reject });
        worker.postMessage({ id: seq, op, name, opts });
    })
    : core[op](name, opts);

try {
    worker = new Worker(new URL('data-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, ok, result, error } }) => {
        const j = jobs.get(id); jobs.delete(id);
        ok ? j.resolve(result) : j.reject(new Error(error));
    };
    worker.onerror = () => {   // worker failed to load: fail pending, go inline
        for (const j of jobs.values()) j.reject(new Error('data worker failed'));
        jobs.clear(); worker = null;
        if (cfg) core.initData(cfg);
    };
    // relative parquet paths must resolve against the page, not the worker url
    rpc('initData', { base: location.href }).catch(() => {});
} catch { }

export const initData = c => void rpc('initData', cfg = c)?.catch?.(() => {});
export const meta = (name, opts) => rpc('meta', name, opts);
export const read = (name, opts) => rpc('read', name, opts);
