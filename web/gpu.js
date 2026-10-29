// jpeg2000 tier-1 and inverse 5/3 dwt in webgpu, bit-exact with openjpeg:
// one invocation per code-block, then one per sample for each lifting step.
// the cpu parses the packet headers (tier-2) and hands over, unchanged from
// the wasm heap, a record per code-block, 5 u32 (a c struct, little-endian):
//   struct { uint32_t off, len;        // its segment in bytes
//            uint16_t x, y;            // its origin, relative to its band's
//            uint8_t w, h, bps, passes; // size; bitplanes coded (Mb minus
//                                       // missing msbs); coding passes
//            uint8_t band, _;          // orientation (0 ll, 1 hl, 2 lh,
//                                       // 3 hh) | resolution << 2
//            uint16_t tile; }          // index into tiles
// one layer and no coding-style flags, as in sentinel-2, so a block's
// passes are one contiguous segment. blocks are at most 32 wide (s2 has 8
// to N0512, 32 from N0513). tiles holds 8 i32 a tile: its rect x0 y0 x1 y1
// and the window wanted of it, both in image coordinates. decode gives the
// windows' samples, each row-major from an even offset
const QE = [0x5601, 0x3401, 0x1801, 0xac1, 0x521, 0x221, 0x5601, 0x5401,
  0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601, 0x5601, 0x5401, 0x5101,
  0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801,
  0x1601, 0x1401, 0x1201, 0x1101, 0xac1, 0x9c1, 0x8a1, 0x521, 0x441, 0x2a1,
  0x221, 0x141, 0x111, 0x85, 0x49, 0x25, 0x15, 9, 5, 1, 0x5601]
const LPS = [1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15,
  16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46]
// the mq states as openjpeg indexes them, 2 × state + mps: qe | next state
// after an mps << 16 | after an lps << 24
const MQ = QE.flatMap((q, s) => [0, 1].map(m => q |
  2 * ({5: 38, 13: 29, 45: 45, 46: 46}[s] ?? s + 1) + m << 16 |
  2 * LPS[s] + (m ^ [0, 6, 14].includes(s)) << 24))

const T1 = R => `
struct P { n: u32, L: u32, l: u32, prec: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> tl: array<u32>;
@group(0) @binding(2) var<storage, read> rec: array<u32>;
@group(0) @binding(3) var<storage, read> seg: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst: array<i32>;
const MQ = array<u32, 94>(${MQ});
// rows of bits, one row of padding each side: significant, negative,
// visited this bitplane, refined before
var<private> sg: array<u32, ${R + 2}>;
var<private> ng: array<u32, ${R + 2}>;
var<private> vs: array<u32, ${R + 2}>;
var<private> mu: array<u32, ${R + 2}>;
var<private> cx: array<u32, 19>;
var<private> a: u32; var<private> c: u32; var<private> ct: u32;
var<private> bp: u32; var<private> cur: u32;
var<private> off: u32; var<private> len: u32;
var<private> w: u32; var<private> h: u32; var<private> o: u32;
var<private> blk: u32; var<private> st: u32;

// past its end a segment reads as 0xff, as openjpeg pads it
fn byte(i: u32) -> u32 {
  let q = off + i;
  return select(0xffu, (seg[q >> 2u] >> ((q & 3u) * 8u)) & 0xffu, i < len);
}
fn bytein() {
  let n = byte(bp + 1u);
  let ff = cur == 0xffu;
  let mk = ff && n > 0x8fu;
  if (!mk) { bp++; cur = n; }
  c += select(n << select(8u, 9u, ff), 0xff00u, mk);
  ct = select(8u, 7u, ff && !mk);
}
fn dec(k: u32) -> u32 {
  let s = cx[k];
  let e = MQ[s];
  let q = e & 0xffffu;
  let m = s & 1u;
  a -= q;
  let lps = (c >> 16u) < q;
  if (!lps) {
    c -= q << 16u;
    if (a >= 0x8000u) { return m; }
  }
  let d = m ^ u32(lps != (a < q));
  cx[k] = select(e >> 24u, (e >> 16u) & 0xffu, d == m);
  if (lps) { a = q; }
  var n = countLeadingZeros(a) - 16u;
  a <<= n;
  loop {
    if (ct == 0u) { bytein(); }
    let k = min(n, ct);
    c <<= k; ct -= k; n -= k;
    if (n == 0u) { break; }
  }
  return d;
}

// a padded row's bits at x - 1, x, x + 1
fn w3(r: u32, x: u32) -> u32 {
  return (((r << 1u) >> x) & 1u) | (((r >> x) & 3u) << 1u);
}
fn nb(x: u32, y: u32) -> u32 {
  return w3(sg[y], x) | (w3(sg[y + 1u], x) & 5u) | w3(sg[y + 2u], x);
}
// zero coding context, by the 8 neighbours and the band's orientation
fn zc(x: u32, y: u32) -> u32 {
  let U = w3(sg[y], x); let M = w3(sg[y + 1u], x); let D = w3(sg[y + 2u], x);
  var hz = (M & 1u) + (M >> 2u);
  var vt = ((U >> 1u) & 1u) + ((D >> 1u) & 1u);
  let d = (U & 1u) + (U >> 2u) + (D & 1u) + (D >> 2u);
  if (o == 3u) {
    let hv = min(hz + vt, 2u);
    return select(select(select(hv, 3u + hv, d == 1u),
                         select(6u, 7u, hv > 0u), d == 2u), 8u, d > 2u);
  }
  if (o == 1u) { let t = hz; hz = vt; vt = t; }
  return select(select(select(min(d, 2u), 2u + vt, vt > 0u),
                       select(select(5u, 6u, d > 0u), 7u, vt > 0u), hz == 1u),
                8u, hz == 2u);
}
fn cn(r: u32, b: u32) -> i32 {
  return select(0, select(1, -1, (ng[r] & b) != 0u), (sg[r] & b) != 0u);
}
// x y becomes significant: its sign, by its 4 neighbours', and value v
fn sig(x: u32, y: u32, v: i32) {
  let b = 1u << x;
  let hc = clamp(cn(y + 1u, b >> 1u) + cn(y + 1u, b << 1u), -1, 1);
  let vc = clamp(cn(y, b) + cn(y + 2u, b), -1, 1);
  let n = select(u32(vc != 0), u32(3 + select(vc, -vc, hc < 0)), hc != 0);
  let s = dec(9u + n) ^ u32(hc < 0 || (hc == 0 && vc < 0));
  sg[y + 1u] |= b;
  ng[y + 1u] |= s << x;
  dst[blk + y * st + x] = select(v, -v, s == 1u);
}

fn sigpass(v: i32) {
  for (var y0 = 0u; y0 < h; y0 += 4u) {
    for (var x = 0u; x < w; x++) {
      for (var y = y0; y < min(y0 + 4u, h); y++) {
        let b = 1u << x;
        if (((sg[y + 1u] | vs[y + 1u]) & b) != 0u || nb(x, y) == 0u) {
          continue;
        }
        if (dec(zc(x, y)) != 0u) { sig(x, y, v); }
        vs[y + 1u] |= b;
      }
    }
  }
}
fn refpass(v: i32) {
  for (var y0 = 0u; y0 < h; y0 += 4u) {
    for (var x = 0u; x < w; x++) {
      for (var y = y0; y < min(y0 + 4u, h); y++) {
        let b = 1u << x;
        if ((sg[y + 1u] & ~vs[y + 1u] & b) == 0u) { continue; }
        let d = dec(select(select(14u, 15u, nb(x, y) != 0u), 16u,
                           (mu[y + 1u] & b) != 0u));
        let i = blk + y * st + x;
        dst[i] += select(-v, v, (d ^ u32(dst[i] < 0)) != 0u);
        mu[y + 1u] |= b;
      }
    }
  }
}
fn clnpass(v: i32) {
  for (var y0 = 0u; y0 < h; y0 += 4u) {
    let e = min(y0 + 4u, h);
    for (var x = 0u; x < w; x++) {
      let b = 1u << x;
      var y = y0;
      // a full column with nothing significant in its 3 × 6 neighbourhood
      // is coded as a run
      if (e == y0 + 4u &&
          ((sg[y0] | sg[y0 + 1u] | sg[y0 + 2u] | sg[y0 + 3u] | sg[y0 + 4u] |
            sg[y0 + 5u]) & (b | (b << 1u) | (b >> 1u))) == 0u &&
          ((vs[y0 + 1u] | vs[y0 + 2u] | vs[y0 + 3u] | vs[y0 + 4u]) & b) == 0u) {
        if (dec(17u) == 0u) { continue; }
        let r = dec(18u) << 1u;
        y += r | dec(18u);
        sig(x, y, v);
        y++;
      }
      for (; y < e; y++) {
        if (((sg[y + 1u] | vs[y + 1u]) & b) == 0u && dec(zc(x, y)) != 0u) {
          sig(x, y, v);
        }
      }
    }
  }
  for (var y = 0u; y < ${R + 2}u; y++) { vs[y] = 0u; }
}

fn ce(a: u32, s: u32) -> u32 { return (a + (1u << s) - 1u) >> s; }

@compute @workgroup_size(64)
fn t1(@builtin(global_invocation_id) g: vec3u) {
  let i = 5u * (g.x + g.y * 4194240u);
  if (i >= 5u * p.n) { return; }
  off = rec[i]; len = rec[i + 1u];
  let f = rec[i + 3u]; let bd = rec[i + 4u];
  w = f & 255u; h = (f >> 8u) & 255u; o = bd & 3u;
  let t = 12u * (bd >> 16u);
  let x0 = tl[t]; let y0 = tl[t + 1u]; let x1 = tl[t + 2u]; let y1 = tl[t + 3u];
  // the band's place in the tile's plane, as openjpeg lays it out: hl right
  // of the lower resolution, lh below it
  let s = p.L + 1u - ((bd >> 2u) & 63u);
  let bx = (rec[i + 2u] & 0xffffu) +
    select(0u, ce(x1, s) - ce(x0, s), (o & 1u) != 0u && s <= p.L);
  let by = (rec[i + 2u] >> 16u) +
    select(0u, ce(y1, s) - ce(y0, s), (o & 2u) != 0u && s <= p.L);
  st = x1 - x0;
  blk = tl[t + 8u] + by * st + bx;
  cx[0] = 8u; cx[17] = 6u; cx[18] = 92u;
  cur = byte(0u); c = cur << 16u; bytein(); c <<= 7u; ct -= 7u; a = 0x8000u;
  // openjpeg's values carry one more fraction bit than the coefficient
  var bit = i32((f >> 16u) & 255u);
  var k = 2u;
  for (var n = 0u; n < (f >> 24u) && bit >= 1; n++) {
    let one = 1 << u32(bit);
    switch k {
      case 0u: { sigpass(one | (one >> 1u)); }
      case 1u: { refpass(one >> 1u); }
      default: { clnpass(one | (one >> 1u)); }
    }
    k++;
    if (k == 3u) { k = 0u; bit--; }
  }
  for (var y = 0u; y < h; y++) {
    for (var x = 0u; x < w; x++) {
      let j = blk + y * st + x;
      dst[j] = select(0, dst[j] / 2, ((sg[y + 1u] >> x) & 1u) != 0u);
    }
  }
}`

// one lifting step for each sample of a resolution, rows then columns,
// from src into dst; the last, into the windows as u16 pairs
const DWT = `
struct P { n: u32, L: u32, l: u32, prec: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> tl: array<u32>;
@group(0) @binding(5) var<storage, read> src: array<i32>;
@group(0) @binding(4) var<storage, read_write> dst: array<i32>;
@group(0) @binding(6) var<storage, read_write> out: array<u32>;
var<private> lb: u32; var<private> ls: u32;
var<private> o: i32; var<private> n: i32; var<private> sn: i32;

fn ce(a: u32, s: u32) -> u32 { return (a + (1u << s) - 1u) >> s; }
// symmetric extension
fn mir(j: i32) -> i32 { return select(select(j, 2 * n - 2 - j, j >= n), -j, j < 0); }
fn at(k: i32) -> i32 { return src[lb + u32(k) * ls]; }
fn hi(j: i32) -> i32 { return at(sn + ((o + j) >> 1u) - (o >> 1u)); }
fn lo(j: i32) -> i32 {
  return at(((o + j) >> 1u) - ((o + 1) >> 1u)) -
    ((hi(mir(j - 1)) + hi(mir(j + 1)) + 2) >> 2u);
}
// sample j of the line of n from o: lows first in src, then highs
fn lift(j: i32) -> i32 {
  sn = ((o + n + 1) >> 1u) - ((o + 1) >> 1u);
  if (n == 1) { return select(at(0) / 2, at(0), (o & 1) == 0); }
  if (((o + j) & 1) == 0) { return lo(j); }
  return hi(j) + ((lo(mir(j - 1)) + lo(mir(j + 1))) >> 1u);
}

@compute @workgroup_size(256)
fn dwt(@builtin(global_invocation_id) g: vec3u) {
  let t = 12u * g.y; let s = p.L - p.l;
  let x0 = ce(tl[t], s); let y0 = ce(tl[t + 1u], s);
  let rw = ce(tl[t + 2u], s) - x0; let rh = ce(tl[t + 3u], s) - y0;
  if (g.x >= rw * rh) { return; }
  let st = tl[t + 2u] - tl[t]; let x = g.x % rw; let y = g.x / rw;
  if (p.n == 0u) { lb = tl[t + 8u] + y * st; ls = 1u; o = i32(x0); n = i32(rw); }
  else { lb = tl[t + 8u] + x; ls = st; o = i32(y0); n = i32(rh); }
  dst[tl[t + 8u] + y * st + x] = lift(i32(select(y, x, p.n == 0u)));
}

@compute @workgroup_size(256)
fn fin(@builtin(global_invocation_id) g: vec3u) {
  let t = 12u * g.y;
  let ww = tl[t + 6u] - tl[t + 4u]; let m = ww * (tl[t + 7u] - tl[t + 5u]);
  if (2u * g.x >= m) { return; }
  let st = tl[t + 2u] - tl[t];
  o = i32(tl[t + 1u]); n = i32(tl[t + 3u] - tl[t + 1u]); ls = st;
  var r = 0u;
  for (var e = 0u; e < 2u && 2u * g.x + e < m; e++) {
    let k = 2u * g.x + e;
    lb = tl[t + 8u] + tl[t + 4u] - tl[t] + k % ww;
    let v = lift(i32(tl[t + 5u] - tl[t + 1u] + k / ww)) + (1 << (p.prec - 1u));
    r |= u32(clamp(v, 0, (1 << p.prec) - 1)) << (16u * e);
  }
  out[tl[t + 9u] + g.x] = r;
}`

let dev, dwt, fin
const t1s = {}
export async function init() {
  if (dev) return dev
  const ad = await navigator.gpu?.requestAdapter()
  if (!ad) throw Error('no webgpu adapter')
  const ts = ad.features.has('timestamp-query'), l = ad.limits
  dev = await ad.requestDevice({requiredFeatures: ts ? ['timestamp-query'] : [],
    requiredLimits: {maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
                     maxBufferSize: l.maxBufferSize}})
  const m = dev.createShaderModule({code: DWT})
  ;[dwt, fin] = ['dwt', 'fin'].map(e => dev.createComputePipeline(
    {layout: 'auto', compute: {module: m, entryPoint: e}}))
  return dev
}
// one pipeline for each block height, rounded up to 8 or 32: its rows
// stay in registers
const t1 = R => t1s[R] ??= dev.createComputePipeline({layout: 'auto',
  compute: {module: dev.createShaderModule({code: T1(R)}), entryPoint: 't1'}})

// recs (Uint32Array, 5 a block), bytes (Uint8Array), tiles (Int32Array, 8 a
// tile); levels of decomposition and bit depth from the codestream. opt.time
// gets the kernels' nanoseconds, opt.planes the coefficients after tier-1
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
  for (let i = 3; i < recs.length; i += 5) if ((recs[i] >> 8 & 255) > 8) R = 32
  const buf = (u, s, d) => {
    const b = dev.createBuffer({size: Math.max(16, s + 3 & ~3), usage: u})
    if (d) dev.queue.writeBuffer(b, 0, d.buffer, d.byteOffset, d.byteLength & ~3),
      d.byteLength & 3 && dev.queue.writeBuffer(b, d.byteLength & ~3,
        Uint8Array.from([...d.subarray(d.byteLength & ~3), 0, 0, 0].slice(0, 4)))
    return b
  }
  const S = G.STORAGE | G.COPY_DST, u = buf(G.UNIFORM | G.COPY_DST, 256 * 9)
  const bt = buf(S, tl.byteLength, tl), br = buf(S, recs.byteLength, recs)
  const bs = buf(S, bytes.byteLength, bytes), pl = buf(S | G.COPY_SRC, 4 * px)
  const tmp = buf(S, 4 * px), bo = buf(S | G.COPY_SRC, 4 * ow)
  const rd = buf(G.MAP_READ | G.COPY_DST, 4 * ow)
  const steps = [[n, 0], ...Array.from({length: 2 * levels - 1},
    (_, i) => [i & 1, (i >> 1) + 1]), [0, levels]]
  steps.forEach(([a, l], i) => dev.queue.writeBuffer(u, 256 * i,
    new Uint32Array([a, levels, l, prec])))
  const bind = (p, i, e) => dev.createBindGroup({layout: p.getBindGroupLayout(0),
    entries: [{binding: 0, resource: {buffer: u, offset: 256 * i, size: 16}},
      {binding: 1, resource: {buffer: bt}},
      ...Object.entries(e).map(([k, b]) => ({binding: +k, resource: {buffer: b}}))]})
  const qs = opt.time && dev.features.has('timestamp-query') &&
    dev.createQuerySet({type: 'timestamp', count: 4})
  const ce = dev.createCommandEncoder(), wg = Math.ceil(n / 64)
  // timestamps: tier-1's start and end, the dwt's first start and last end
  const pass = (b, e, p, g, x, y) => {
    const c = ce.beginComputePass(qs && b + e > -2 ? {timestampWrites: {
      querySet: qs, beginningOfPassWriteIndex: b < 0 ? undefined : b,
      endOfPassWriteIndex: e < 0 ? undefined : e}} : {})
    c.setPipeline(p), c.setBindGroup(0, g), c.dispatchWorkgroups(x, y), c.end()
  }
  ce.clearBuffer(pl)
  pass(0, 1, t1(R), bind(t1(R), 0, {2: br, 3: bs, 4: pl}),
       Math.min(wg, 65535), Math.ceil(wg / 65535))
  let pc
  if (opt.planes) pc = buf(G.MAP_READ | G.COPY_DST, 4 * px),
    ce.copyBufferToBuffer(pl, 0, pc, 0, 4 * px)
  for (let i = 1; i < steps.length - 1; i++)
    pass(i == 1 ? 2 : -1, i == steps.length - 2 ? 3 : -1, dwt,
         bind(dwt, i, i & 1 ? {5: pl, 4: tmp} : {5: tmp, 4: pl}),
         Math.ceil(amax / 256), nt)
  pass(-1, -1, fin, bind(fin, steps.length - 1, {5: tmp, 6: bo}),
       Math.ceil(wmax / 256), nt)
  ce.copyBufferToBuffer(bo, 0, rd, 0, 4 * ow)
  let qr
  if (qs) qr = buf(G.MAP_READ | G.COPY_DST, 32), (() => {
    const q = buf(G.QUERY_RESOLVE | G.COPY_SRC, 32)
    ce.resolveQuerySet(qs, 0, 4, q, 0), ce.copyBufferToBuffer(q, 0, qr, 0, 32)
  })()
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
