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
const no = () => {}, wasm = await (await fetch(new URL('burnoff.wasm',
  import.meta.url))).arrayBuffer()
const m = await init({instantiateWasm: (i, ok) =>
  WebAssembly.instantiate(wasm, i).then(r => ok(r.instance))})
const g = await gpu().then(() => 1, e =>
  console.warn(`burnoff: ${e.message}, decoding on the cpu`))
const bytes = a => new Uint8Array(new Float64Array(a).buffer)
const json = p => {
  const s = m.UTF8ToString(p)
  return m._free(p), JSON.parse(s)
}
const drop = new Set()
const heap = (T, p, n) => new T(m.HEAPU8.buffer, p, n)

// finished detections in indexeddb, keyed by the call and the wasm's
// digest: a view opened again reads nothing. its keys are read once
const build = crypto.subtle?.digest('SHA-256', wasm).then(d =>
  String.fromCharCode(...new Uint8Array(d)), no)
const db = new Promise((ok, err) => {
  const q = indexedDB.open('burnoff', 1)
  q.onupgradeneeded = () => q.result.createObjectStore('r')
  q.onsuccess = () => ok(q.result), q.onerror = err
}).catch(no)
const kept = (k, v) => db.then(d => d && new Promise(ok => {
  const s = d.transaction('r', v ? 'readwrite' : 'readonly').objectStore('r')
  const q = v ? s.put(v, k) : k ? s.get(k) : s.getAllKeys()
  q.onsuccess = () => ok(q.result), q.onerror = () => ok()
}))
const keys = kept().then(k => new Set(k), no)

// pieces of the files read, by url, {u, lo, e, n: the file's size, p: a
// promise of their bytes or null, k: their key on disk}: the last 64 MB in
// memory, and the last 1 GB on disk (the cache api), those from byte 0
// (headers, masks) kept longest. one on its way holds to the end of its
// file until it ends
const at = new Map(), mem = [], dk = []
const of = u => at.get(u) ?? at.set(u, []).get(u)
const cut = (a, c) => a.includes(c) && a.splice(a.indexOf(c), 1)
const disk = await globalThis.caches?.open('burnoff').catch(no)
for (const {url: k} of await disk?.keys().catch(no) ?? []) {
  const q = new URL(k).searchParams, c = {u: q.get('u'), lo: +q.get('lo'),
    e: +q.get('e'), n: +q.get('n'), p: null, k}
  of(c.u).push(c), dk.push(c)
}
let room = 64e6, full = dk.reduce((s, c) => s + c.e - c.lo, 0)
function hold(c) {
  for (mem.push(c), room -= c.s = isFinite(c.e) ? c.e - c.lo : 0; room < 0;) {
    const d = mem.shift()
    room += d.s, d.p = null, d.k || cut(of(d.u), d)
  }
  return c
}
const find = (u, f, c = at.get(u)?.find(f)) => c && !c.p && c.k
  ? (c.p = disk.match(c.k).then(r => r.arrayBuffer()).then(b =>
       new Uint8Array(b), () => (cut(of(u), c), cut(dk, c), null)), hold(c))
  : c
function save(c, b) {
  const k = 'https://burnoff/?' + new URLSearchParams(
    {u: c.u, lo: c.lo, e: c.e, n: c.n})
  disk?.put(k, new Response(b)).then(() => {
    for (dk.push(c), c.k = k, full += c.e - c.lo; full > 1e9;) {
      const [d] = dk.splice(Math.max(dk.findIndex(d => d.lo), 0), 1)
      full -= d.e - d.lo, disk.delete(d.k), d.k = null
      d.p || cut(of(d.u), d)
    }
  }, no)
}

// one read, which burnoff.c judges and asks for again after a failure that
// may pass, wait seconds later: [status, size, wait, body]. it skips the
// http cache, which takes one read of a url at a time: 112 site reads of
// one scene took 14.0 s through it and 7.4 s past it (4 workers of 8, gs://)
// b11 and b8a by code-block, a sixth of a site's bytes in 6 to 9 times
// the reads and a round more, only when asked to spare data: saveData, a
// 2g or 3g effectiveType, or worker.js?cb=1. a measured link is not used:
// under aerial's load a fast line's share looked slow
const nc = navigator.connection
const cb = +(new URL(import.meta.url).searchParams.get('cb') ??
  (nc?.saveData || /2g|3g/.test(nc?.effectiveType)))
// at most FLY reads in flight, the rest queued: by code-block aerial's 4
// workers asked chrome for thousands at once, which it refused
// (ERR_INSUFFICIENT_RESOURCES)
const FLY = 128, line = []
let on = 0
async function read(u, lo, hi) {
  if (on++ >= FLY) await new Promise(ok => line.push(ok))
  try {
    const r = await fetch(u, { method: hi == -2 ? 'HEAD' : 'GET',
      headers: lo || hi >= 0 ? { Range: `bytes=${lo}-${hi < 0 ? '' : hi - 1}` }
        : {}, cache: 'no-store',
      signal: AbortSignal.timeout(6e4) })   // a stalled read fails
    const b = new Uint8Array(await r.arrayBuffer())
    const n = +r.headers.get('content-range')?.split('/')[1]
      || (hi == -2 ? +r.headers.get('content-length') : -1)
    return [r.status, n, +r.headers.get('retry-after') || 0, b]
  } catch { return [-1, -1, 0, new Uint8Array(0)] }
  finally { on--, line.shift()?.() }
}

// [lo, hi) of u (hi -1: to its end) from the pieces that hold its ends and
// one read of the rest, which another job's read on its way may be: a
// read made whole, never one more
async function take(u, lo, hi) {
  let a = lo, z = hi < 0 ? find(u, c => c.lo <= lo && c.e == c.n)?.n ?? -1
                         : hi, c, f
  const ps = [], whole = ([s, n, , b]) => s == 206 &&
    b.length == (z < 0 ? n : z) - a || s == 200 && !a && b.length >= z
  for (; (z < 0 || a < z) && (c = find(u, c => c.lo <= a && a < c.e));)
    ps.push([c, c.p]), a = c.e
  for (; a < z && (c = find(u, c => c.lo < z && z <= c.e));)
    ps.push([c, c.p]), z = c.lo
  if (z < 0 ? a < Infinity : a < z) {
    const p = {u, lo: a, e: z < 0 ? Infinity : z, n: -1}
    p.p = (f = read(u, a, z)).then(r => whole(r)
      ? (p.n = r[1] < 0 ? r[3].length : r[1], p.e = a + r[3].length,
         save(p, r[3]), r[3])
      : (cut(of(u), p), null))
    ps.push([p, p.p]), of(u).push(hold(p))
  }
  const r = await f, b = await Promise.all(ps.map(c => c[1]))
  if (r && !whole(r)) return a == lo && z == hi ? r : read(u, lo, hi)
  const n = Math.max(...ps.map(c => c[0].n))
  const o = new Uint8Array(Math.max((hi < 0 ? n : hi) - lo, 0))
  let x = lo
  for (let i; (i = ps.findIndex(([c], k) => b[k] && c.lo <= x && x < c.e))
              >= 0;) x = ps[i][0].e
  if (x < lo + o.length || !o.length) return read(u, lo, hi)
  ps.forEach(([{lo: l}], i) => b[i] && o.set(b[i].subarray(
    Math.max(lo - l, 0), Math.min(lo + o.length - l, b[i].length)),
    Math.max(l - lo, 0)))
  return [206, n, 0, o]
}
async function get(j, i, u, lo, hi, wait) {
  if (wait) await new Promise(ok => setTimeout(ok, wait * 1e3))
  const [s, size, w, b] = await (hi == -2 ? read : take)(u, lo, hi)
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
  detect: async (a, id) => {
    const [u, w, s, e, n, i, k, p = [], th = ''] = a
    const key = await build && await build + JSON.stringify(a)
    const c = (await keys)?.has(key) && await kept(key)
    if (c) return c
    const j = m.ccall('detect', 'number', ['string', ...Array(6).fill(
      'number'), 'string', 'number'], [u, w, s, e, n, i, k, th, cb])
    // 1: reads lacking; 2: decodes queued, made by the next step if not here
    for (let t; !drop.has(id) && (t = m._next(j));)
      await (t == 1 ? Promise.all(json(m._reads(j)).map(r => get(j, ...r)))
                    : g && dec(j).catch(no))
    const r = json(m.ccall('result', 'number', ['number', 'array', 'number'],
                           [j, bytes(p), p.length / 2]))
    if (drop.delete(id)) return {dropped: true}
    if (key && !r.error) kept(key, r).catch(no), (await keys)?.add(key)
    return r
  },
}
onmessage = async ({ data: [id, fn, ...a] }) => fn == 'drop'
  ? drop.add(id) : postMessage([id, await call[fn](a, id)])
postMessage('ready')
