// one detector: postMessage([id, 'tiles', points]) or [id, 'detect',
// url, w, s, e, n, part, parts, points, thresholds] answers [id, its json].
// urls are gs://gcp-public-data-sentinel-2/tiles/..., read over google's
// json api, which answers cross-origin ranged reads. a detection runs in
// stages, each a batch of reads made here at once, then decodes on the gpu,
// so a worker holds any number in flight: one decodes while others wait.
// without a webgpu adapter it decodes on the cpu, as it says once.
// [id, 'drop'] ends detection id at its next stage, answering {dropped:
// true}: a view that moved on frees the worker for the next one's reads
import init from './burnoff.js'
import {init as gpu, decode, cells} from './gpu.js'
const m = await init()
const g = await gpu().then(() => 1, e =>
  console.warn(`burnoff: ${e.message}, decoding on the cpu`))
const bytes = a => new Uint8Array(new Float64Array(a).buffer)
const json = p => {
  const s = m.UTF8ToString(p)
  return m._free(p), JSON.parse(s)
}
const drop = new Set()
const heap = (T, p, n) => new T(m.HEAPU8.buffer, p, n)
// one read, which burnoff.c judges and asks for again after a failure that
// may pass, wait seconds later. it skips the http cache, which takes one
// read of a url at a time: 112 site reads of one scene took 14.0 s through
// it and 7.4 s past it (4 workers of 8, gs://)
async function get(j, i, u, lo, hi, wait) {
  let s = -1, size = -1, w = 0, b = new Uint8Array(0)
  if (wait) await new Promise(ok => setTimeout(ok, wait * 1e3))
  try {
    const r = await fetch(u, { method: hi == -2 ? 'HEAD' : 'GET',
      headers: lo || hi >= 0 ? { Range: `bytes=${lo}-${hi < 0 ? '' : hi - 1}` }
        : {}, cache: 'no-store',
      signal: AbortSignal.timeout(6e4) })   // a stalled read fails
    b = new Uint8Array(await r.arrayBuffer()), s = r.status
    size = +r.headers.get('content-range')?.split('/')[1]
      || (hi == -2 ? +r.headers.get('content-length') : -1)
    w = +r.headers.get('retry-after') || 0
  } catch {}
  const p = m._malloc(b.length || 1)
  m.HEAPU8.set(b, p), m._answer(j, i, s, size, p, b.length, w)
}
// a stage's decodes on the gpu, b12's screened there too, given to the
// job; on a failure next() makes them on the cpu
async function dec(j) {
  const r = m._records(j)
  if (!r) return
  const [rec, n, seg, ns, tl, nt, l, prec, cq, nq] = heap(Uint32Array, r, 10)
  let o = await decode(heap(Uint32Array, rec, 5 * n),
    heap(Uint8Array, seg, ns), heap(Int32Array, tl, 8 * nt), l, prec,
    cq)
  if (cq) o = await cells(o, heap(Uint32Array, cq, nq))
  const p = m._malloc(o.byteLength)
  m.HEAPU8.set(new Uint8Array(o.buffer, o.byteOffset, o.byteLength), p)
  m._took(j, p)
}
const call = {
  tiles: ([p]) => json(m.ccall('tiles', 'number', ['array', 'number'],
                               [bytes(p), p.length / 2])),
  detect: async ([u, w, s, e, n, i, k, p = [], th = ''], id) => {
    const j = m.ccall('detect', 'number', ['string', ...Array(6).fill(
      'number'), 'string'], [u, w, s, e, n, i, k, th])
    // 1: reads lacking; 2: decodes queued, made by the next step if not here
    for (let t; !drop.has(id) && (t = m._next(j));)
      await (t == 1 ? Promise.all(json(m._reads(j)).map(r => get(j, ...r)))
                    : g && dec(j).catch(() => {}))
    const r = json(m.ccall('result', 'number', ['number', 'array', 'number'],
                           [j, bytes(p), p.length / 2]))
    return drop.delete(id) ? {dropped: true} : r
  },
}
onmessage = async ({ data: [id, fn, ...a] }) => fn == 'drop'
  ? drop.add(id) : postMessage([id, await call[fn](a, id)])
postMessage('ready')
