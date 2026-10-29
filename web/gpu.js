// jpeg2000 decoding in webgpu, bit-exact with openjpeg: j2k.wgsl's tier-1
// and inverse 5/3 dwt, fed the cpu's tier-2 records (laid out in j2k.wgsl)
// straight from the wasm heap, and b12's screen. it works in a dedicated
// worker. one call takes any number of tiles, of any number of scenes: a
// whole stage is one compute pass, a dispatch a step, ending in a canary
// that must be read back with the results (src/gpu.c says why). a device
// lost is asked for again on the next call
let dev, src, pipes
export async function init() {
  if (dev) return dev
  const ad = await navigator.gpu?.requestAdapter()
  if (!ad) throw Error('no webgpu adapter')
  const l = ad.limits
  src ??= await (await fetch(new URL('j2k.wgsl', import.meta.url))).text()
  const d = await ad.requestDevice({requiredLimits: {
    maxBufferSize: l.maxBufferSize,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize}})
  d.lost.then(() => dev = null)
  return pipes = {}, dev = d
}
// a module for blocks of up to 8 × 8, whose state stays in registers, and
// one for larger, compiled when first needed
const pipe = (R, e) => pipes[R + e] ??= dev.createComputePipeline({
  layout: 'auto', compute: {entryPoint: e, module: pipes[R] ??=
    dev.createShaderModule({code: src.replace(R > 8 ? /\/\/8\{[^]*?\/\/\}/ :
                                              /\/\/32\{[^]*?\/\/\}/, '')})}})
const G = () => GPUBufferUsage
// a buffer of s bytes, with d's bytes if given
const buf = (u, s, d) => {
  const b = dev.createBuffer({size: Math.max(16, s + 3 & ~3), usage: u})
  const k = d?.byteLength & ~3
  if (d) dev.queue.writeBuffer(b, 0, d.buffer, d.byteOffset, k),
    k < d.byteLength && dev.queue.writeBuffer(b, k,
      Uint8Array.from([0, 1, 2, 3], i => d[k + i] ?? 0))
  return b
}
// a dispatch of entry e in pass c, with bindings b (and uniform slot i)
const run = (c, e, R, b, x, y = 1, u, i) => {
  const p = pipe(R, e)
  c.setPipeline(p), c.setBindGroup(0, dev.createBindGroup({
    layout: p.getBindGroupLayout(0), entries: [...u ? [{binding: 0,
      resource: {buffer: u, offset: 256 * i, size: 16}}] : [],
      ...Object.entries(b).map(([k, b]) =>
        ({binding: +k, resource: {buffer: b}}))]})),
  c.dispatchWorkgroups(x, y)
}
// h's pass ended by the canary, its copies (buffer, offset, bytes) read
// back with it, submitted; its buffers go. gives the bytes read
async function fetch_(h, cps) {
  const {ce, c} = h, y = c ? buf(G().STORAGE | G().COPY_SRC, 4)
    : buf(G().COPY_SRC | G().COPY_DST, 4, Uint32Array.of(0xb0ff))
  if (c) run(c, 'mark', 8, {12: y}, 1), c.end()
  let s = 0
  for (const [, , n] of cps) s += n
  const r = buf(G().MAP_READ | G().COPY_DST, s + 4)
  s = 0
  for (const [b, o, n] of cps) ce.copyBufferToBuffer(b, o, r, s, n), s += n
  ce.copyBufferToBuffer(y, 0, r, s, 4), dev.queue.submit([ce.finish()])
  for (const b of [y, ...h.drop ?? []]) b.destroy()
  await r.mapAsync(GPUMapMode.READ)
  const a = r.getMappedRange().slice(0)
  r.destroy()
  if (new Uint32Array(a, s, 1)[0] != 0xb0ff) throw Error('gpu work dropped')
  return a.slice(0, s)
}

// recs (Uint32Array, 5 a block), bytes (Uint8Array), tiles (Int32Array, 8 a
// tile: its rect and the window wanted, in image coordinates); levels of
// decomposition and bit depth from the codestream. gives the windows'
// samples, each from an even offset, or with keep a handle to them, not
// yet run, for cells(). it reads its arguments before it first waits, so
// they may be views of a heap that can grow
export async function decode(recs, bytes, tiles, levels = 4, prec = 15,
                             keep) {
  if (!dev) await init()
  const n = recs.length / 5, nt = tiles.length / 8, S = G().STORAGE
  const tl = new Uint32Array(12 * nt)
  let px = 0, ow = 0, wmax = 0, amax = 0, R = 8
  for (let i = 0; i < nt; i++) {
    const [x0, y0, x1, y1, a, b, c, d] = tiles.subarray(8 * i, 8 * i + 8)
    const m = (c - a) * (d - b) + 1 >> 1
    tl.set([x0, y0, x1, y1, a, b, c, d, px, ow], 12 * i)
    px += (x1 - x0) * (y1 - y0), ow += m
    wmax = Math.max(wmax, m), amax = Math.max(amax, (x1 - x0) * (y1 - y0))
  }
  for (let i = 3; i < recs.length; i += 5)
    if ((recs[i] & 0xffff) + 0x707 & 0xf0f0) R = 32
  // each step's parameters: tier-1's, the dwt's rows and columns a level,
  // and the last columns'
  const u = buf(G().UNIFORM | G().COPY_DST, 256 * (2 * levels + 1))
  for (let i = 0; i <= 2 * levels; i++)
    dev.queue.writeBuffer(u, 256 * i, Uint32Array.of(i ? (i - 1) & (i < 2 *
      levels) : n, levels, i + 1 >> 1, prec))
  const W = S | G().COPY_DST, bt = buf(W, tl.byteLength, tl)
  const br = buf(W, recs.byteLength, recs), bs = buf(W, bytes.byteLength, bytes)
  const pl = buf(S, 4 * px), tmp = buf(S, 4 * px)
  const bo = buf(S | G().COPY_SRC, 4 * ow), ce = dev.createCommandEncoder()
  const c = ce.beginComputePass(), wg = Math.ceil(n / 64)
  run(c, 't1', R, {1: bt, 2: br, 3: bs, 4: pl}, Math.min(wg, 65535),
      Math.ceil(wg / 65535), u, 0)
  for (let i = 1; i < 2 * levels; i++)
    run(c, 'dwt', R, i & 1 ? {1: bt, 5: pl, 4: tmp} : {1: bt, 5: tmp, 4: pl},
        Math.ceil(amax / 256), nt, u, i)
  run(c, 'fin', R, {1: bt, 5: tmp, 6: bo}, Math.ceil(wmax / 256), nt, u,
      2 * levels)
  const h = {ce, c, bt, bo, drop: [u, br, bs, pl, tmp]}
  if (keep) return h
  h.drop.push(bt, bo)
  return new Uint16Array(await fetch_(h, [[bo, 0, 4 * ow]]))
}

// b12's screen, as src/burnoff.c screen() makes it, over decode h (from
// decode(..., keep)): j2k.wgsl's cells, ring and squares, reading cq
// (burnoff.c table()). gives 8 u32 a cell, the candidates' number k, 2 a
// 640 m square, then 2 a candidate (box index, dn) in no order and its
// ring, k
export async function cells(h, cq) {
  const S = G().STORAGE | G().COPY_SRC, [X0, Y0, X1, Y1] = cq
  const nc = cq[9] * (((Y1 - 1) / 320 | 0) - cq[8] + 1), cap = cq[16]
  const nx = ((X1 - 1) >> 5) - (X0 >> 5) + 1
  const ny = ((Y1 - 1) >> 5) - (Y0 >> 5) + 1, m = 8 * nc + 1 + 2 * nx * ny
  const bq = buf(G().STORAGE | G().COPY_DST, cq.byteLength, cq)
  const bc = buf(S, 32 * nc), bk = buf(S, 8 * cap + 4), bg = buf(S, 4 * cap)
  const bs = buf(S, 8 * nx * ny), b = {1: h.bt, 6: h.bo, 7: bq, 8: bc}
  // the cells, then each candidate's ring and the squares, read back with
  // the candidates' number, then the candidates
  run(h.c, 'cells', 8, {...b, 9: bk}, nc)
  run(h.c, 'ring', 8, {...b, 9: bk, 10: bg}, 1024)
  run(h.c, 'squares', 8, {...b, 11: bs}, nx, ny)
  h.drop.push(h.bt, h.bo, bq, bc, bs)
  const a = new Uint32Array(await fetch_(h, [[bc, 0, 32 * nc], [bk, 0, 4],
                                             [bs, 0, 8 * nx * ny]]))
  const k = a[8 * nc], o = k <= cap && new Uint32Array(m + 3 * k)
  if (o && k) o.set(new Uint32Array(await fetch_({ce:
    dev.createCommandEncoder()}, [[bk, 4, 8 * k], [bg, 0, 4 * k]])), m)
  bk.destroy(), bg.destroy()
  if (!o) throw Error(k + ' candidates, past ' + cap)
  return o.set(a), o
}
