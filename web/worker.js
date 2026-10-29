// one detector: postMessage([id, 'tiles', points]) or [id, 'detect',
// url, w, s, e, n, part, parts, points, thresholds] answers [id, its json].
// urls are gs://gcp-public-data-sentinel-2/tiles/..., read over google's
// json api, which answers cross-origin ranged reads. a detection runs in
// stages, each a batch of reads made here at once, then decodes in wasm,
// so a worker holds any number in flight: one decodes while others wait
import init from './burnoff.js'
const m = await init()
const bytes = a => new Uint8Array(new Float64Array(a).buffer)
const json = p => {
  const s = m.UTF8ToString(p)
  return m._free(p), JSON.parse(s)
}
// one read, which burnoff.c judges and asks for again after a failure that
// may pass, wait seconds later
async function get(j, i, u, lo, hi, wait) {
  let s = -1, size = -1, w = 0, b = new Uint8Array(0)
  if (wait) await new Promise(ok => setTimeout(ok, wait * 1e3))
  try {
    const r = await fetch(u, { method: hi == -2 ? 'HEAD' : 'GET',
      headers: lo || hi >= 0 ? { Range: `bytes=${lo}-${hi < 0 ? '' : hi - 1}` }
        : {}, signal: AbortSignal.timeout(6e4) })   // a stalled read fails
    b = new Uint8Array(await r.arrayBuffer()), s = r.status
    size = +r.headers.get('content-range')?.split('/')[1]
      || (hi == -2 ? +r.headers.get('content-length') : -1)
    w = +r.headers.get('retry-after') || 0
  } catch {}
  const p = m._malloc(b.length || 1)
  m.HEAPU8.set(b, p), m._answer(j, i, s, size, p, b.length, w)
}
const call = {
  tiles: ([p]) => json(m.ccall('tiles', 'number', ['array', 'number'],
                               [bytes(p), p.length / 2])),
  detect: async ([u, w, s, e, n, i, k, p = [], th = '']) => {
    const j = m.ccall('detect', 'number', ['string', ...Array(6).fill(
      'number'), 'string'], [u, w, s, e, n, i, k, th])
    // 1: reads lacking; 2: decodes queued, made by the next step here
    for (let t; (t = m._next(j));)
      if (t == 1) await Promise.all(json(m._reads(j)).map(r => get(j, ...r)))
    return json(m.ccall('result', 'number', ['number', 'array', 'number'],
                        [j, bytes(p), p.length / 2]))
  },
}
onmessage = async ({ data: [id, fn, ...a] }) =>
  postMessage([id, await call[fn](a)])
postMessage('ready')
