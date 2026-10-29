// jpeg2000 decoding in webgpu, bit-exact with openjpeg: j2k.wgsl's tier-1
// and inverse 5/3 dwt, fed the cpu's tier-2 records (laid out in j2k.wgsl)
// straight from the wasm heap. it works in a dedicated worker. one call
// takes any number of tiles, of any number of scenes: a whole stage is one
// dispatch a step
let dev, src, last
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
// samples, each from an even offset, or with opt.keep none: they stay on
// the gpu for cells(). opt.time gets the kernels' nanoseconds, opt.planes
// the coefficients after tier-1
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
  const rd = opt.keep ? null : buf(G.MAP_READ | G.COPY_DST, 4 * ow)
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
  if (rd) ce.copyBufferToBuffer(bo, 0, rd, 0, 4 * ow)
  let qr
  if (qs) {
    const q = buf(G.QUERY_RESOLVE | G.COPY_SRC, 32)
    qr = buf(G.MAP_READ | G.COPY_DST, 32)
    ce.resolveQuerySet(qs, 0, 4, q, 0), ce.copyBufferToBuffer(q, 0, qr, 0, 32)
  }
  dev.queue.submit([ce.finish()])
  if (rd) await rd.mapAsync(GPUMapMode.READ)
  const r = rd && new Uint16Array(rd.getMappedRange().slice(0))
  if (pc) await pc.mapAsync(GPUMapMode.READ),
    opt.planes = new Int32Array(pc.getMappedRange().slice(0))
  if (qr) {
    await qr.mapAsync(GPUMapMode.READ)
    const t = new BigInt64Array(qr.getMappedRange())
    opt.time = {t1: Number(t[1] - t[0]), dwt: Number(t[3] - t[2])}
  }
  last?.bt.destroy(), last?.bo.destroy(), last = opt.keep && {bt, bo, tl}
  for (const b of [u, br, bs, pl, tmp, rd, pc, qr, ...last ? [] : [bt, bo]])
    b?.destroy()
  return r
}

// the detector's background cells and candidates over box (x0 y0 x1 y1,
// pixels of one scene's last decode, kept), as src/burnoff.c run() makes
// them: mask is the 60 m cloudy flags (a byte a pixel, mw a row), t run()'s
// thresholds. gives cells, 8 u32 a cell row by row (see j2k.wgsl), the
// candidates' box indices in raster order and their dn, and hot (a
// candidate reaches peak_b12_min). opt.time gets the kernel's nanoseconds
const cal = d => d ? (d - 1000) / 10000 : 0
// the least dn whose value passes f
const least = (f, d = 1) => { while (d < 65536 && !f(cal(d))) d++; return d }
export async function cells(box, mask, mw, t = {}, opt = {}) {
  const {b12_min = .3, peak_b12_min = .5, contrast_ratio = 3,
         background_floor = .15, max_cloud_local = .75} = t
  const [X0, Y0, X1, Y1] = box, {bt, bo, tl} = last, G = GPUBufferUsage
  let tw = 0, th = 0, iw = 0, ih = 0
  for (let i = 0; i < tl.length; i += 12)
    tw = Math.max(tw, tl[i + 2] - tl[i]),
    th = Math.max(th, tl[i + 3] - tl[i + 1]),
    iw = Math.max(iw, tl[i + 2]), ih = Math.max(ih, tl[i + 3])
  const nx = Math.ceil(iw / tw), gx0 = X0 / 320 | 0, gy0 = Y0 / 320 | 0
  const ncx = ((X1 - 1) / 320 | 0) - gx0 + 1
  const nc = ncx * (((Y1 - 1) / 320 | 0) - gy0 + 1)
  const cap = Math.min((X1 - X0) * (Y1 - Y0), 1 << 22)
  // run()'s comparisons of doubles as cuts in dn: dim under m; a candidate
  // at or over a and over the contrast on its cell's median
  let m = 1
  while (m < Math.ceil(1000 + b12_min * 10000) && cal(m) < b12_min) m++
  if (m > 4064) throw Error('b12_min past the histogram')
  const a = least(v => v > b12_min), ns = nx * Math.ceil(ih / th)
  const o = 17 + ns + 102401 + m
  const cq = new Uint32Array(o + (mask.length + 3 >> 2))
  cq.set([X0, Y0, X1, Y1, tw, th, nx, gx0, gy0, ncx, mw, m, 17, 17 + ns,
          17 + ns + 102401, o, cap])
  cq.fill(~0, 17, 17 + ns)
  for (let i = 0; i < tl.length; i += 12)
    cq[17 + (tl[i + 1] / th | 0) * nx + (tl[i] / tw | 0)] = i / 12
  for (let n = 0; n <= 102400; n++)
    cq[17 + ns + n] = Math.floor(max_cloud_local * n)
  for (let i = 0; i < m; i++) {
    const ct = Math.max(cal(i), background_floor) * contrast_ratio
    cq[o - m + i] = Math.max(a, least(v => v > ct,
                                      Math.max(1, Math.floor(ct * 1e4) + 990)))
  }
  new Uint8Array(cq.buffer, 4 * o).set(mask)
  const mk = (u, s) => dev.createBuffer({size: s, usage: u})
  const bq = mk(G.STORAGE | G.COPY_DST, cq.byteLength)
  const bc = mk(G.STORAGE | G.COPY_SRC, 32 * nc)
  const bk = mk(G.STORAGE | G.COPY_SRC | G.COPY_DST, 8 * cap + 4)
  const r1 = mk(G.MAP_READ | G.COPY_DST, 32 * nc + 4)
  dev.queue.writeBuffer(bq, 0, cq)
  const qs = opt.time && dev.features.has('timestamp-query') &&
    dev.createQuerySet({type: 'timestamp', count: 2})
  const qb = qs && mk(G.QUERY_RESOLVE | G.COPY_SRC, 16)
  const qr = qs && mk(G.MAP_READ | G.COPY_DST, 16)
  const ce = dev.createCommandEncoder(), p = pipe(8, 'cells')
  ce.clearBuffer(bk, 0, 4)
  const c = ce.beginComputePass(qs ? {timestampWrites: {querySet: qs,
    beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
  c.setPipeline(p), c.setBindGroup(0, dev.createBindGroup({
    layout: p.getBindGroupLayout(0), entries: Object.entries(
      {1: bt, 6: bo, 7: bq, 8: bc, 9: bk}).map(([k, b]) =>
      ({binding: +k, resource: {buffer: b}}))}))
  c.dispatchWorkgroups(nc), c.end()
  ce.copyBufferToBuffer(bc, 0, r1, 0, 32 * nc)
  ce.copyBufferToBuffer(bk, 0, r1, 32 * nc, 4)
  if (qs) ce.resolveQuerySet(qs, 0, 2, qb, 0),
    ce.copyBufferToBuffer(qb, 0, qr, 0, 16)
  dev.queue.submit([ce.finish()])
  await r1.mapAsync(GPUMapMode.READ)
  const cs = new Uint32Array(r1.getMappedRange().slice(0))
  const k = cs[8 * nc]
  if (k > cap) throw Error(`${k} candidates, past ${cap}`)
  // then the candidates alone, sorted to raster order
  const r2 = mk(G.MAP_READ | G.COPY_DST, 8 * k + 8)
  const e = dev.createCommandEncoder()
  if (k) e.copyBufferToBuffer(bk, 4, r2, 0, 8 * k)
  dev.queue.submit([e.finish()])
  await r2.mapAsync(GPUMapMode.READ)
  const pr = new Uint32Array(r2.getMappedRange()), sk = new Float64Array(k)
  for (let i = 0; i < k; i++) sk[i] = pr[2 * i] * 65536 + pr[2 * i + 1]
  sk.sort()
  const idx = new Int32Array(k), dn = new Uint16Array(k)
  for (let i = 0; i < k; i++) idx[i] = sk[i] / 65536, dn[i] = sk[i] % 65536
  if (qr) {
    await qr.mapAsync(GPUMapMode.READ)
    const t = new BigInt64Array(qr.getMappedRange())
    opt.time = Number(t[1] - t[0])
  }
  const p5 = least(v => v >= peak_b12_min)
  for (const b of [bq, bc, bk, r1, r2, qb, qr]) b?.destroy()
  return {cells: cs.subarray(0, 8 * nc), idx, dn, hot: dn.some(d => d >= p5)}
}
