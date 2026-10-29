// jpeg2000 tier-1 and inverse 5/3 dwt, bit-exact with openjpeg 2.5.4, for
// webgpu (web/gpu.js) and native hosts alike. the host parses the packet
// headers (tier-2) and hands over a record per code-block, 5 u32 (a c
// struct, little-endian):
//   struct { uint32_t off, len;          // its segment in seg's bytes
//            uint16_t x, y;              // its origin, relative to its band's
//            uint8_t w, h, bps, passes;  // size (at most 32 × 32); bitplanes
//                                        // coded (Mb less missing msbs);
//                                        // coding passes
//            uint8_t band, _;            // orientation (0 ll, 1 hl, 2 lh,
//                                        // 3 hh) | resolution << 2
//            uint16_t tile; }            // its row of tl
// one layer and no coding-style flags, as in sentinel-2, so a block's
// passes are one contiguous segment.
//
// bindings, group 0: 0 p, the step's parameters; 1 tl, 12 u32 a tile: its
// rect x0 y0 x1 y1 and the window wanted x0 y0 x1 y1 in image coordinates,
// its plane's offset, its window's offset in out (u32), 2 spare; 2 rec;
// 3 seg; 4 dst, a plane; 5 src, a plane; 6 out. a tile's plane has its
// width as stride, bands laid out as openjpeg does (hl right of the lower
// resolution, lh below, hh both).
//
// the steps: t1 (p.n blocks) into a cleared plane; then, for each level l
// of p.L, dwt across rows (p.n 0) into the other plane and down columns
// (p.n 1) back, but the last level's columns are fin's, into out: each
// window's samples as u16 pairs, row-major, shifted by 2^(p.prec - 1) and
// clamped. dispatches are 2-d: x over blocks (64 a group, 65535 groups a
// row) or a tile's samples (256 a group), y over rows of groups or tiles

struct P { n: u32, L: u32, l: u32, prec: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> tl: array<u32>;
@group(0) @binding(2) var<storage, read> rec: array<u32>;
@group(0) @binding(3) var<storage, read> seg: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst: array<i32>;
// the mq states as openjpeg indexes them, 2 × state + mps: qe | the next
// after an mps << 16 | after an lps << 24
const mq = array<u32, 94>(
  50484737, 33773057, 201602049, 218444801, 302389249, 319232001,
  403180225, 420022977, 973735201, 990577953, 1112277537, 1129120289,
  219043329, 202331649, 470832129, 487674881, 470960129, 487802881,
  471087105, 487929857, 571879425, 588722177, 605561857, 622404609,
  672799745, 689642497, 708449793, 725292545, 488527361, 471815681,
  471880705, 488723457, 505565441, 522408193, 539248641, 556091393,
  572930049, 589772801, 606614529, 623457281, 640299009, 657141761,
  640428033, 657270785, 674112513, 690955265, 707797505, 724640257,
  741481473, 758324225, 775165953, 792008705, 808850945, 825693697,
  842535937, 859378689, 876220929, 893063681, 909906177, 926748929,
  943590081, 960432833, 977275329, 994118081, 1010960545, 1027803297,
  1044645153, 1061487905, 1078330433, 1095173185, 1112015521, 1128858273,
  1145700897, 1162543649, 1179386177, 1196228929, 1213071633, 1229914385,
  1246756997, 1263599749, 1280442441, 1297285193, 1314127909, 1330970661,
  1347813397, 1364656149, 1381498889, 1398341641, 1415184389, 1432027141,
  1448738817, 1465581569, 1549555201, 1566397953);
// the block as columns of bits, a row a bit: significant, negative, visited
// by this bitplane's first pass, and significant when this bitplane and the
// last began. eight columns of eight fit in a vec2u; wider blocks pad an
// array, a column each side. the host keeps one of these two, by the
// codestream's block size
//8{
alias M = vec2u;
fn col(m: ptr<private, M>, x: u32) -> u32 {
  return select(0u, ((*m)[x >> 2u] >> ((x & 3u) * 8u)) & 255u, x < 8u);
}
fn put(m: ptr<private, M>, x: u32, b: u32) {
  (*m)[x >> 2u] |= b << ((x & 3u) * 8u);
}
//}
//32{
alias M = array<u32, 34>;
fn col(m: ptr<private, M>, x: u32) -> u32 { return (*m)[x + 1u]; }
fn put(m: ptr<private, M>, x: u32, b: u32) { (*m)[x + 1u] |= b; }
//}
var<private> S: M; var<private> N: M; var<private> V: M;
var<private> A: M; var<private> B: M;
// the 19 contexts' states, a byte each, in registers
var<private> c0: u32; var<private> c1: u32; var<private> c2: u32;
var<private> c3: u32; var<private> c4: u32;
var<private> a: u32; var<private> c: u32; var<private> ct: u32;
var<private> bp: u32; var<private> cur: u32;
var<private> off: u32; var<private> len: u32;
var<private> w: u32; var<private> h: u32; var<private> o: u32;
var<private> blk: u32; var<private> st: u32;
// where the coding is: pass (0 significance, 1 refinement, 2 cleanup), its
// bitplane and passes left, stripe, column, row in the stripe, and what the
// next symbol is (0 a sample's, 1 its sign, 2 and 3 a run's position, 4 a
// run); a run's first bit
var<private> k: u32; var<private> bit: i32; var<private> np: u32;
var<private> y0: u32; var<private> x: u32; var<private> r: u32;
var<private> md: u32; var<private> ru: u32;

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
fn dec(q: u32) -> u32 {
  let cw = select(select(select(select(c4, c3, q < 16u), c2, q < 12u), c1,
                         q < 8u), c0, q < 4u);
  let sh = (q & 3u) * 8u;
  let s = (cw >> sh) & 255u;
  let e = mq[s];
  let qe = e & 0xffffu;
  let m = s & 1u;
  a -= qe;
  let lps = (c >> 16u) < qe;
  if (!lps) {
    c -= qe << 16u;
    if (a >= 0x8000u) { return m; }
  }
  let d = m ^ u32(lps != (a < qe));
  let nw = (cw & ~(255u << sh)) | (select(e >> 24u, (e >> 16u) & 0xffu,
                                          d == m) << sh);
  let qw = q >> 2u;
  c0 = select(c0, nw, qw == 0u); c1 = select(c1, nw, qw == 1u);
  c2 = select(c2, nw, qw == 2u); c3 = select(c3, nw, qw == 3u);
  c4 = select(c4, nw, qw == 4u);
  if (lps) { a = qe; }
  var n = countLeadingZeros(a) - 16u;
  a <<= n;
  loop {
    if (ct == 0u) { bytein(); }
    let t = min(n, ct);
    c <<= t; ct -= t; n -= t;
    if (n == 0u) { break; }
  }
  return d;
}

// a column's bits at rows y - 1, y, y + 1
fn w3(m: u32, y: u32) -> u32 {
  return (((m << 1u) >> y) & 1u) | (((m >> y) & 3u) << 1u);
}
fn dl(m: u32) -> u32 { return m | (m << 1u) | (m >> 1u); }

// the next symbol's place, or false when the passes are done. a pass visits
// the stripes of 4 rows column by column; a column's rows still to code
// come as a nibble
fn find() -> bool {
  loop {
    let e = min(h - y0, 4u);
    let s = col(&S, x) >> y0; let v = col(&V, x) >> y0;
    let full = (0xfu >> (4u - e)) & (0xfu << r);
    // a full column with nothing significant in its 3 × 6 neighbourhood and
    // nothing visited is coded as a run
    let n6 = (col(&S, x - 1u) | col(&S, x) | col(&S, x + 1u)) >> y0;
    if (k == 2u && r == 0u && e == 4u && ((v & 15u) | (n6 & 31u)) == 0u &&
        (y0 == 0u || (((col(&S, x - 1u) | col(&S, x) | col(&S, x + 1u)) >>
                       (y0 - 1u)) & 1u) == 0u)) {
      md = 4u;
      return true;
    }
    var m = select(~(s | v), s & ~v, k == 1u) & full;
    if (k == 0u) {
      m &= dl(col(&S, x - 1u) | col(&S, x) | col(&S, x + 1u)) >> y0;
    }
    if (m != 0u) { r = countTrailingZeros(m); return true; }
    r = 0u; x++;
    if (x < w) { continue; }
    x = 0u; y0 += 4u;
    if (y0 < h) { continue; }
    y0 = 0u;
    if (k == 2u) { V = M(); }
    np--; k++;
    if (k == 3u) { k = 0u; bit--; B = A; A = S; }
    if (np == 0u || bit < 1) { return false; }
  }
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
  let x0 = tl[t]; let y0_ = tl[t + 1u]; let x1 = tl[t + 2u];
  let y1 = tl[t + 3u];
  // the band's place in the tile's plane, as openjpeg lays it out: hl right
  // of the lower resolution, lh below it
  let s = p.L + 1u - ((bd >> 2u) & 63u);
  let bx = (rec[i + 2u] & 0xffffu) +
    select(0u, ce(x1, s) - ce(x0, s), (o & 1u) != 0u && s <= p.L);
  let by = (rec[i + 2u] >> 16u) +
    select(0u, ce(y1, s) - ce(y0_, s), (o & 2u) != 0u && s <= p.L);
  st = x1 - x0;
  blk = tl[t + 8u] + by * st + bx;
  c0 = 8u; c4 = (6u << 8u) | (92u << 16u);
  cur = byte(0u); c = cur << 16u; bytein(); c <<= 7u; ct -= 7u; a = 0x8000u;
  // openjpeg's values carry one more fraction bit than the coefficient
  bit = i32((f >> 16u) & 255u); np = f >> 24u; k = 2u;
  // one symbol a turn, whatever its kind, decoded in one place, so the
  // lanes keep in step
  loop {
    if (np == 0u || bit < 1 || (md == 0u && !find())) { break; }
    let y = y0 + r;
    let j = blk + y * st + x;
    let one = 1 << u32(bit);
    let L = w3(col(&S, x - 1u), y); let C = w3(col(&S, x), y);
    let Rt = w3(col(&S, x + 1u), y);
    // the context: zero coding by the 8 neighbours and the band's
    // orientation; the sign by the 4 neighbours' signs; refinement by
    // whether refined before (significant when the last bitplane began)
    var hz = ((L >> 1u) & 1u) + ((Rt >> 1u) & 1u);
    var vt = (C & 1u) + (C >> 2u);
    let dg = (L & 1u) + (L >> 2u) + (Rt & 1u) + (Rt >> 2u);
    let hv = min(hz + vt, 2u);
    if (o == 1u) { let t = hz; hz = vt; vt = t; }
    let nl = col(&N, x - 1u); let nc = col(&N, x); let nr = col(&N, x + 1u);
    let hc = clamp(i32((L >> 1u) & 1u) * (1 - 2 * i32((nl >> y) & 1u)) +
                   i32((Rt >> 1u) & 1u) * (1 - 2 * i32((nr >> y) & 1u)), -1, 1);
    let vc = clamp(i32(C & 1u) * (1 - 2 * i32(((nc << 1u) >> y) & 1u)) +
                   i32(C >> 2u) * (1 - 2 * i32(((nc >> y) >> 1u) & 1u)), -1, 1);
    let z0 = select(select(select(min(dg, 2u), 2u + vt, vt > 0u),
                           select(select(5u, 6u, dg > 0u), 7u, vt > 0u),
                           hz == 1u), 8u, hz == 2u);
    let z3 = select(select(select(hv, 3u + hv, dg == 1u),
                           select(6u, 7u, hv > 0u), dg == 2u), 8u, dg > 2u);
    let mg = select(select(14u, 15u, (L | (C & 5u) | Rt) != 0u), 16u,
                    ((col(&B, x) >> y) & 1u) != 0u);
    let sc = 9u + select(u32(vc != 0), u32(3 + select(vc, -vc, hc < 0)),
                         hc != 0);
    let q = select(select(select(18u, 17u, md == 4u), sc, md == 1u),
                   select(select(z0, z3, o == 3u), mg, k == 1u), md == 0u);
    let sp = (hc < 0) || (hc == 0 && (vc < 0));
    let d = dec(q) ^ select(0u, 1u, md == 1u && sp);
    if (md == 0u && k == 1u) {
      let n = ((nc >> y) & 1u) != 0u;
      dst[j] += select(-1, 1, (d == 1u) != n) * (one >> 1u);
      r++;
    } else if (md == 0u) {
      if (d != 0u) { md = 1u; }
      else { if (k == 0u) { put(&V, x, 1u << y); } r++; }
    } else if (md == 1u) {
      put(&S, x, 1u << y); put(&N, x, d << y);
      if (k == 0u) { put(&V, x, 1u << y); }
      dst[j] = select(1, -1, d == 1u) * (one | (one >> 1u));
      md = 0u; r++;
    } else if (md == 4u) {
      if (d == 0u) { md = 0u; r = 4u; } else { md = 2u; }
    } else if (md == 2u) {
      ru = d << 1u; md = 3u;
    } else {
      r = ru | d; md = 1u;
    }
  }
  // the rest of the plane is zero, cleared before
  for (var xx = 0u; xx < w; xx++) {
    for (var m = col(&S, xx); m != 0u; m &= m - 1u) {
      let j = blk + countTrailingZeros(m) * st + xx;
      dst[j] = dst[j] / 2;
    }
  }
}

// the dwt: one lifting step for each sample of a resolution, from src
@group(0) @binding(5) var<storage, read> src: array<i32>;
@group(0) @binding(6) var<storage, read_write> out: array<u32>;
// a line: where it starts in src and its stride; its origin, length and
// number of lows
var<private> lb: u32; var<private> ls: u32;
var<private> lo0: i32; var<private> ln: i32; var<private> lsn: i32;

// symmetric extension
fn mir(j: i32) -> i32 {
  return select(select(j, 2 * ln - 2 - j, j >= ln), -j, j < 0);
}
fn at(i: i32) -> i32 { return src[lb + u32(i) * ls]; }
fn hi(j: i32) -> i32 { return at(lsn + ((lo0 + j) >> 1u) - (lo0 >> 1u)); }
fn lo(j: i32) -> i32 {
  return at(((lo0 + j) >> 1u) - ((lo0 + 1) >> 1u)) -
    ((hi(mir(j - 1)) + hi(mir(j + 1)) + 2) >> 2u);
}
// sample j of the line: lows first in src, then highs
fn lift(j: i32) -> i32 {
  lsn = ((lo0 + ln + 1) >> 1u) - ((lo0 + 1) >> 1u);
  if (ln == 1) { return select(at(0) / 2, at(0), (lo0 & 1) == 0); }
  if (((lo0 + j) & 1) == 0) { return lo(j); }
  return hi(j) + ((lo(mir(j - 1)) + lo(mir(j + 1))) >> 1u);
}

@compute @workgroup_size(256)
fn dwt(@builtin(global_invocation_id) g: vec3u) {
  let t = 12u * g.y; let s = p.L - p.l;
  let rx = ce(tl[t], s); let ry = ce(tl[t + 1u], s);
  let rw = ce(tl[t + 2u], s) - rx; let rh = ce(tl[t + 3u], s) - ry;
  if (g.x >= rw * rh) { return; }
  let sd = tl[t + 2u] - tl[t]; let cx = g.x % rw; let cy = g.x / rw;
  if (p.n == 0u) {
    lb = tl[t + 8u] + cy * sd; ls = 1u; lo0 = i32(rx); ln = i32(rw);
  } else {
    lb = tl[t + 8u] + cx; ls = sd; lo0 = i32(ry); ln = i32(rh);
  }
  dst[tl[t + 8u] + cy * sd + cx] = lift(i32(select(cy, cx, p.n == 0u)));
}

@compute @workgroup_size(256)
fn fin(@builtin(global_invocation_id) g: vec3u) {
  let t = 12u * g.y;
  let ww = tl[t + 6u] - tl[t + 4u]; let m = ww * (tl[t + 7u] - tl[t + 5u]);
  if (2u * g.x >= m) { return; }
  lo0 = i32(tl[t + 1u]); ln = i32(tl[t + 3u] - tl[t + 1u]);
  ls = tl[t + 2u] - tl[t];
  var u = 0u;
  for (var e = 0u; e < 2u && 2u * g.x + e < m; e++) {
    let i = 2u * g.x + e;
    lb = tl[t + 8u] + tl[t + 4u] - tl[t] + i % ww;
    let v = lift(i32(tl[t + 5u] - tl[t + 1u] + i / ww)) +
      (1 << (p.prec - 1u));
    u |= u32(clamp(v, 0, (1 << p.prec) - 1)) << (16u * e);
  }
  out[tl[t + 9u] + g.x] = u;
}
