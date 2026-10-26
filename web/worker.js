// one detector: postMessage([url, xmin, ymin, xmax, ymax, thresholds]) and
// get back s2_detect's row as an object
import init from './burnoff.js'
self.BURNOFF_PROXY = new URL('p/', location).href
const m = await init()
onmessage = ({data: [u, ...a]}) => {
  const p = m.ccall('detect', 'number',
    ['string', 'number', 'number', 'number', 'number', 'string'],
    [u, ...a.slice(0, 4), a[4] || ''])
  postMessage(JSON.parse(m.UTF8ToString(p))), m._free(p)
}
postMessage('ready')
