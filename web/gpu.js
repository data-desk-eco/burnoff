// jpeg2000 decoding in webgpu, bit-exact with openjpeg: j2k.wgsl's tier-1
// and inverse 5/3 dwt, fed the cpu's tier-2 records (laid out in j2k.wgsl)
// straight from the wasm heap. it works in a dedicated worker. one call
// takes any number of tiles, of any number of scenes: a whole stage is one
// dispatch a step
let dev, src
const pipes = {}
export async function init() {
  if (dev) return dev
  const ad = await navigator.gpu?.requestAdapter()
  if (!ad) throw Error('no webgpu adapter')
  const l = ad.limits
  src = await (await fetch(new URL('j2k.wgsl', import.meta.url))).text()
  return dev = await ad.requestDevice({requiredFeatures:
      ad.features.has('timestamp-query') ? ['timestamp-query'] : [],
    requiredLimits: {maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
                     maxBufferSize: l.maxBufferSize}})
}
// a module for blocks of up to 8 × 8, whose state stays in registers, and
// one for larger, compiled when first needed
const pipe = (R, e) => pipes[R + e] ??= dev.createComputePipeline({
  layout: 'auto', compute: {entryPoint: e, module: pipes[R] ??=
    dev.createShaderModule({code: src.replace(R > 8 ? /\/\/8\{[^]*?\/\/\}/ :
                                              /\/\/32\{[^]*?\/\/\}/, '')})}})

// recs (Uint32Array, 5 a block), bytes (Uint8Array), tiles (Int32Array, 8 a
// tile: its rect and the window wanted, in image coordinates); levels of
// decomposition and bit depth from the codestream. gives the windows'
// samples, each from an even offset. opt.time gets the kernels'
// nanoseconds, opt.planes the coefficients after tier-1
export async function decode(recs, bytes, tiles, levels = 4, prec = 15,
                             opt = {}) {
  await init()
  const n = recs.length / 5, nt = tiles.length / 8, G = GPUBufferUsage
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
  const buf = (u, s, d) => {
    const b = dev.createBuffer({size: Math.max(16, s + 3 & ~3), usage: u})
    const k = d?.byteLength & ~3
    if (d) dev.queue.writeBuffer(b, 0, d.buffer, d.byteOffset, k),
      k < d.byteLength && dev.queue.writeBuffer(b, k,
        Uint8Array.from([0, 1, 2, 3], i => d[k + i] ?? 0))
    return b
  }
  const S = G.STORAGE | G.COPY_DST, u = buf(G.UNIFORM | G.COPY_DST, 256 * 9)
  const bt = buf(S, tl.byteLength, tl), br = buf(S, recs.byteLength, recs)
  const bs = buf(S, bytes.byteLength, bytes), pl = buf(S | G.COPY_SRC, 4 * px)
  const tmp = buf(S, 4 * px), bo = buf(S | G.COPY_SRC, 4 * ow)
  const rd = buf(G.MAP_READ | G.COPY_DST, 4 * ow)
  // each step's parameters: tier-1's, the dwt's rows and columns a level,
  // and the last columns'
  const steps = [[n, 0], ...Array.from({length: 2 * levels - 1},
    (_, i) => [i & 1, (i >> 1) + 1]), [0, levels]]
  steps.forEach(([a, l], i) => dev.queue.writeBuffer(u, 256 * i,
    new Uint32Array([a, levels, l, prec])))
  const qs = opt.time && dev.features.has('timestamp-query') &&
    dev.createQuerySet({type: 'timestamp', count: 4})
  const ce = dev.createCommandEncoder(), wg = Math.ceil(n / 64)
  // timestamps: tier-1's start and end, the dwt's first start and last end
  const pass = (i, b, e, p, bufs, x, y) => {
    const c = ce.beginComputePass(qs && b + e > -2 ? {timestampWrites: {
      querySet: qs, beginningOfPassWriteIndex: b < 0 ? undefined : b,
      endOfPassWriteIndex: e < 0 ? undefined : e}} : {})
    c.setPipeline(p), c.setBindGroup(0, dev.createBindGroup({
      layout: p.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: u, offset: 256 * i, size: 16}},
        ...Object.entries({1: bt, ...bufs}).map(([k, b]) =>
          ({binding: +k, resource: {buffer: b}}))]}))
    c.dispatchWorkgroups(x, y), c.end()
  }
  ce.clearBuffer(pl)
  pass(0, 0, 1, pipe(R, 't1'), {2: br, 3: bs, 4: pl}, Math.min(wg, 65535),
       Math.ceil(wg / 65535))
  let pc
  if (opt.planes) pc = buf(G.MAP_READ | G.COPY_DST, 4 * px),
    ce.copyBufferToBuffer(pl, 0, pc, 0, 4 * px)
  for (let i = 1; i < steps.length - 1; i++)
    pass(i, i == 1 ? 2 : -1, i == steps.length - 2 ? 3 : -1, pipe(R, 'dwt'),
         i & 1 ? {5: pl, 4: tmp} : {5: tmp, 4: pl}, Math.ceil(amax / 256), nt)
  pass(steps.length - 1, -1, -1, pipe(R, 'fin'), {5: tmp, 6: bo},
       Math.ceil(wmax / 256), nt)
  ce.copyBufferToBuffer(bo, 0, rd, 0, 4 * ow)
  let qr
  if (qs) {
    const q = buf(G.QUERY_RESOLVE | G.COPY_SRC, 32)
    qr = buf(G.MAP_READ | G.COPY_DST, 32)
    ce.resolveQuerySet(qs, 0, 4, q, 0), ce.copyBufferToBuffer(q, 0, qr, 0, 32)
  }
  dev.queue.submit([ce.finish()])
  await rd.mapAsync(GPUMapMode.READ)
  const r = new Uint16Array(rd.getMappedRange().slice(0))
  if (pc) await pc.mapAsync(GPUMapMode.READ),
    opt.planes = new Int32Array(pc.getMappedRange().slice(0))
  if (qr) {
    await qr.mapAsync(GPUMapMode.READ)
    const t = new BigInt64Array(qr.getMappedRange())
    opt.time = {t1: Number(t[1] - t[0]), dwt: Number(t[3] - t[2])}
  }
  for (const b of [u, bt, br, bs, pl, tmp, bo, rd, pc, qr]) b?.destroy()
  return r
}
