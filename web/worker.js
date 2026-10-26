// one detector: postMessage([id, 'tiles', points]) or [id, 'detect',
// url, w, s, e, n, part, parts, points, thresholds] answers [id, its json].
// urls are gs://gcp-public-data-sentinel-2/tiles/..., read over google's
// json api, which answers cross-origin ranged reads. a read the detector is
// about to make is posted first, as ['ahead', url, range], for the page to
// start
import init from './burnoff.js'
const m = await init()
const bytes = a => new Uint8Array(new Float64Array(a).buffer)
const call = {
  tiles: ([p]) => m.ccall('tiles', 'number', ['array', 'number'],
                          [bytes(p), p.length / 2]),
  detect: ([u, w, s, e, n, i, k, p = [], th = '']) => m.ccall('detect',
    'number', ['string', ...Array(6).fill('number'), 'array', 'number',
               'string'], [u, w, s, e, n, i, k, bytes(p), p.length / 2, th]),
}
onmessage = ({data: [id, fn, ...a]}) => {
  const p = call[fn](a)
  postMessage([id, JSON.parse(m.UTF8ToString(p))]), m._free(p)
}
postMessage('ready')
