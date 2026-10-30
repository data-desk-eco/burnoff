// j2k: burnoff's jpeg 2000 decoder, for the codestreams sentinel-2 l1c
// writes and nothing else. a survey of baselines N0400 to N0513 (2022-26,
// six MGRS tiles) found one shape: part 1, one quality layer, LRCP,
// reversible 5/3, no quantisation, ROI, SOP or EPH, one tile-part per tile,
// a PLT in each, and equal unsigned components (the cloud mask's three
// under the RCT). code-blocks are 8x8 to N0512, 32x32 from N0513 and 16x16
// in the mask. anything else is refused, not guessed at.
//
// a tile decodes from just the packets a window needs (j2k_need), tier-2
// lists their code-blocks as plain records (j2k_cb), tier-1 decodes each
// into its tile-component's coefficients, and the windowed inverse 5/3,
// RCT and level shift give samples equal to openjpeg 2.5's.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  int w, h, tw, th, nx, nt, nc, prec, nl, cbw, cbh, mct, mp;
  size_t hlen;                      // SOC to the first SOT
  unsigned char ppx[33], ppy[33];   // precinct size exponents
  unsigned char mb[97];             // magnitude bits per band, as in QCD
} j2k;

// one code-block for tier-1, five uint32s little-endian, as web/j2k.wgsl
// takes them
typedef struct {
  uint32_t off, len;        // its segment: d[off, off + len), then 0xff 0xff
  uint16_t x, y;            // its corner, relative to its band's
  uint8_t w, h, bps, pass;  // size; bitplanes (the first cleanup codes plane
                            // bps - 1); coding passes, one segment
  uint8_t band, comp;       // orientation (0 LL, 1 HL, 2 LH, 3 HH) | res << 2
  uint16_t row;             // the caller's: its tile's row of j2k.wgsl's tl
} j2k_cb;

typedef struct { j2k_cb *cb; uint8_t *d; size_t n, nd, cap, capd; } j2k_cbs;

typedef struct { int x0, y0, x1, y1; } j2k_box;

#define JMIN(a, b) ((a) < (b) ? (a) : (b))
#define JMAX(a, b) ((a) > (b) ? (a) : (b))
#define CD(a, n) (-(-(a) >> (n)))   // ceil(a / 2^n), arithmetic shifts

static unsigned u16(const uint8_t *p) { return p[0] << 8 | p[1]; }
static unsigned u32(const uint8_t *p) { return u16(p) << 16 | u16(p + 2); }

static j2k_box tbox(const j2k *j, int k) {
  int x = k % j->nx * j->tw, y = k / j->nx * j->th;
  return (j2k_box){x, y, JMIN(x + j->tw, j->w), JMIN(y + j->th, j->h)};
}

// resolution r of tile t, and band b of it (b 0 at r 0, else 1..3)
static j2k_box rbox(j2k_box t, int l) {
  return (j2k_box){CD(t.x0, l), CD(t.y0, l), CD(t.x1, l), CD(t.y1, l)};
}

static j2k_box bbox(const j2k *j, j2k_box t, int r, int b) {
  int l = j->nl - r, ox = r ? (b & 1) << l : 0, oy = r ? (b >> 1) << l : 0;
  l += !!r;
  return (j2k_box){CD(t.x0 - ox, l), CD(t.y0 - oy, l), CD(t.x1 - ox, l),
                   CD(t.y1 - oy, l)};
}

static int pw(const j2k *j, j2k_box t, int r, int y) {
  j2k_box R = rbox(t, j->nl - r);
  int p = y ? j->ppy[r] : j->ppx[r], a = y ? R.y0 : R.x0, b = y ? R.y1 : R.x1;
  return b > a ? CD(b, p) - (a >> p) : 0;
}

// packets of tile k, all components
static int npk(const j2k *j, j2k_box t) {
  int n = 0;
  for (int r = 0; r <= j->nl; r++) n += pw(j, t, r, 0) * pw(j, t, r, 1);
  return n * j->nc;
}

// the main header at p (SOC), to the first SOT or the end of p[0, n)
const char *j2k_main(j2k *j, const uint8_t *p, size_t n) {
  const uint8_t *q = p + 2, *e = p + n;
  int got = 0, nq = 0;
  memset(j, 0, sizeof *j);
  if (n < 4 || u16(p) != 0xff4f) return "no jpeg 2000 codestream";
  for (; q < e && u16(q) != 0xff90; q += 2 + u16(q + 2)) {
    unsigned m = u16(q), L = q + 4 <= e ? u16(q + 2) : 0;
    const uint8_t *s = q + 4;
    if (L < 2 || q + 2 + L > e) return "truncated main header";
    if (m == 0xff51) {
      if (L < 41 || L != 38 + 3 * u16(s + 34) || u32(s + 10) | u32(s + 14) |
          u32(s + 26) | u32(s + 30))
        return "image or tile origin not at 0";
      j->w = u32(s + 2), j->h = u32(s + 6), j->tw = u32(s + 18);
      j->th = u32(s + 22), j->nc = u16(s + 34);
      for (int c = 0; c < j->nc; c++)
        if (s[36 + 3 * c] != s[36] || s[37 + 3 * c] != 1 || s[38 + 3 * c] != 1)
          return "components differ or are subsampled";
      if (s[36] > 15) return "not unsigned, up to 16 bits";
      j->prec = s[36] + 1, got |= 1;
    } else if (m == 0xff52) {
      if (L < 12 || s[0] & ~1 || s[1] > 1 || u16(s + 2) != 1 || s[8] ||
          s[9] != 1 || L < 12 + (s[0] & 1) * (s[5] + 1u))
        return "not one layer, LRCP, reversible, plain code-blocks";
      j->mct = s[4], j->nl = s[5], j->cbw = (s[6] & 15) + 2;
      j->cbh = (s[7] & 15) + 2, got |= 2;
      for (int r = 0; r <= j->nl && r < 33; r++)
        j->ppx[r] = s[0] ? s[10 + r] & 15 : 15,
        j->ppy[r] = s[0] ? s[10 + r] >> 4 : 15;
    } else if (m == 0xff5c) {
      if (s[0] & 31 || (nq = L - 3) > 97) return "quantised";
      for (int i = 0; i < nq; i++) j->mb[i] = (s[0] >> 5) + (s[1 + i] >> 3) - 1;
      got |= 4;
    } else if (m != 0xff55 && m != 0xff57 && m != 0xff63 && m != 0xff64)
      return "unsupported marker in main header";   // COC, QCC, RGN, POC..
  }
  if (got != 7) return "incomplete main header";
  if (j->nl > 32 || nq != 3 * j->nl + 1 || j->cbw > 5 || j->cbh > 5 ||
      j->w <= 0 || j->h <= 0 || j->tw <= 0 ||
      j->th <= 0 || !j->nc || j->nc > 4 || (j->mct && j->nc < 3))
    return "unsupported coding parameters";
  for (int r = 1; r <= j->nl; r++)
    if (!j->ppx[r] || !j->ppy[r]) return "unsupported precincts";
  j->nx = (j->w + j->tw - 1) / j->tw;
  j->nt = j->nx * ((j->h + j->th - 1) / j->th);
  for (int k = 0; k < j->nt; k++) j->mp = JMAX(j->mp, npk(j, tbox(j, k)));
  j->hlen = q - p;
  return NULL;
}

// what a window of tile t needs at each level r >= 1, in res r's
// coordinates: the output w, and the low (even) and high (odd) samples of
// each axis, as band coordinates. an even output reads the odds beside it,
// an odd one the evens beside it and so odds two away
typedef struct { j2k_box w; int lx0, lx1, hx0, hx1, ly0, ly1, hy0, hy1; } lev;

static void reach(const j2k *j, j2k_box t, j2k_box w, lev *L) {
  for (int r = j->nl; r >= 0; r--) {
    j2k_box R = rbox(t, j->nl - r);
    lev *v = &L[r];
    v->w = w;
    if (w.x0 >= w.x1 || w.y0 >= w.y1) w = (j2k_box){0, 0, 0, 0};
    v->lx0 = CD(JMAX(w.x0 - 1, R.x0), 1), v->lx1 = CD(JMIN(w.x1 + 1, R.x1), 1);
    v->hx0 = JMAX(w.x0 - 2, R.x0) >> 1, v->hx1 = JMIN(w.x1 + 2, R.x1) >> 1;
    v->ly0 = CD(JMAX(w.y0 - 1, R.y0), 1), v->ly1 = CD(JMIN(w.y1 + 1, R.y1), 1);
    v->hy0 = JMAX(w.y0 - 2, R.y0) >> 1, v->hy1 = JMIN(w.y1 + 2, R.y1) >> 1;
    if (w.x0 >= w.x1) v->lx1 = v->lx0, v->hx1 = v->hx0;
    if (w.y0 >= w.y1) v->ly1 = v->ly0, v->hy1 = v->hy0;
    w = (j2k_box){v->lx0, v->ly0, v->lx1, v->ly1};
  }
}

// the needed rect of band b at resolution r
static j2k_box nbox(const lev *L, int r, int b) {
  const lev *v = &L[r];
  return !r ? v->w
       : (j2k_box){b & 1 ? v->hx0 : v->lx0, b & 2 ? v->hy0 : v->ly0,
                   b & 1 ? v->hx1 : v->lx1, b & 2 ? v->hy1 : v->ly1};
}

static int meets(j2k_box a, j2k_box b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// which packets of tile k (in codestream order) window [x0,x1)×[y0,y1)
// needs: those of each precinct that meets the window's reach. returns the
// tile's packet count; need may be NULL
int j2k_need(const j2k *j, int k, int x0, int y0, int x1, int y1,
             char *need) {
  j2k_box t = tbox(j, k);
  j2k_box w = {JMAX(x0, t.x0), JMAX(y0, t.y0), JMIN(x1, t.x1), JMIN(y1, t.y1)};
  lev L[33];
  int n = 0;
  reach(j, t, w, L);
  for (int r = 0; r <= j->nl; r++) {
    j2k_box R = rbox(t, j->nl - r);
    int nx = pw(j, t, r, 0), np = nx * pw(j, t, r, 1);
    int px = j->ppx[r] - !!r, py = j->ppy[r] - !!r;
    for (int c = 0; c < j->nc; c++, n += np)
      for (int p = 0; need && p < np; p++) {
        int ix = (R.x0 >> j->ppx[r]) + p % nx;
        int iy = (R.y0 >> j->ppy[r]) + p / nx;
        j2k_box P = {ix << px, iy << py, (ix + 1) << px, (iy + 1) << py};
        need[n + p] = 0;
        for (int b = !!r; b < (r ? 4 : 1); b++) {
          j2k_box B = bbox(j, t, r, b), N = nbox(L, r, b);
          need[n + p] |= meets(B, N) && meets(P, N);
        }
      }
  }
  return n;
}

// packet headers: bits with a 0 after each 0xff byte, zeros past the end,
// which p counts on through, so that a header past e is seen
typedef struct { const uint8_t *p, *e; unsigned buf, ct; } bio;

static void bin(bio *b) {
  b->buf = b->buf << 8 & 0xffff, b->ct = b->buf == 0xff00 ? 7 : 8;
  if (b->p++ < b->e) b->buf |= b->p[-1];
}

static unsigned bit(bio *b) {
  if (!b->ct) bin(b);
  return b->buf >> --b->ct & 1;
}

static unsigned bits(bio *b, int n) {
  unsigned v = 0;
  while (n-- > 0) v = v << 1 | bit(b);
  return v;
}

// tag trees: up to 32x32 leaves, with each level's offset and width
typedef struct { uint8_t v[1366], lo[1366]; int at[7], w[7], n; } tree;

static void tinit(tree *t, int w, int h) {
  int n = 0, i = 0;
  do t->at[i] = n, t->w[i] = w, n += w * h, w = (w + 1) / 2, h = (h + 1) / 2;
  while (t->at[i++] + 1 < n);
  t->n = i;
  memset(t->v, 255, n), memset(t->lo, 0, n);
}

// is leaf (x,y) below th? root to leaf, as openjpeg's opj_tgt_decode
static int tdec(bio *b, tree *t, int x, int y, int th) {
  int low = 0, i = 0;
  for (int l = t->n - 1; l >= 0; l--) {
    i = t->at[l] + (y >> l) * t->w[l] + (x >> l);
    if (low > t->lo[i]) t->lo[i] = low; else low = t->lo[i];
    while (low < th && low < t->v[i])
      if (bit(b)) t->v[i] = low; else low++;
    t->lo[i] = low;
  }
  return t->v[i] < th;
}

static unsigned npasses(bio *b) {
  unsigned n;
  if (!bit(b)) return 1;
  if (!bit(b)) return 2;
  if ((n = bits(b, 2)) != 3) return 3 + n;
  if ((n = bits(b, 5)) != 31) return 6 + n;
  return 37 + bits(b, 7);
}

static void *grow(void *p, size_t *cap, size_t need, size_t sz) {
  if (need > *cap) p = realloc(p, (*cap = 2 * need + 64) * sz);
  return p;
}

// packet p of resolution r, component c of tile k, from s[0, n): its
// length, and with o, its code-blocks that meet the needed rects L; with
// hd, s may hold only its header, and their offsets are in the packet
static const char *packet(const j2k *j, int k, int r, int c, int p,
                          const uint8_t *s, size_t n, const lev *L, int row,
                          j2k_cbs *o, size_t *len, int hd) {
  j2k_box t = tbox(j, k), R = rbox(t, j->nl - r);
  int nx = pw(j, t, r, 0), px = j->ppx[r] - !!r, py = j->ppy[r] - !!r;
  int ix = (R.x0 >> j->ppx[r]) + p % nx, iy = (R.y0 >> j->ppy[r]) + p / nx;
  int cw = JMIN(j->cbw, px), ch = JMIN(j->cbh, py);
  size_t body = 0, first = o ? o->n : 0;
  bio b = {s, s + n, 0, 0};
  tree inc, msb;
  int present = bit(&b);
  for (int bd = !!r; bd < (r ? 4 : 1); bd++) {
    j2k_box B = bbox(j, t, r, bd);
    j2k_box P = {JMAX(ix << px, B.x0), JMAX(iy << py, B.y0),
                 JMIN((ix + 1) << px, B.x1), JMIN((iy + 1) << py, B.y1)};
    int gx = P.x0 >> cw, gy = P.y0 >> ch;
    int gw = P.x1 > P.x0 ? CD(P.x1, cw) - gx : 0;
    int gh = P.y1 > P.y0 ? CD(P.y1, ch) - gy : 0;
    if (B.x0 >= B.x1 || B.y0 >= B.y1 || !gw || !gh) continue;
    if (gw > 32 || gh > 32) return "more than 32x32 code-blocks a precinct";
    tinit(&inc, gw, gh), tinit(&msb, gw, gh);
    for (int y = 0; y < gh; y++)
      for (int x = 0; x < gw; x++) {
        j2k_box C = {JMAX((gx + x) << cw, P.x0), JMAX((gy + y) << ch, P.y0),
                     JMIN((gx + x + 1) << cw, P.x1),
                     JMIN((gy + y + 1) << ch, P.y1)};
        unsigned np = 0, bps = 0, sl = 0, i = 0, lb = 3;
        if (present && tdec(&b, &inc, x, y, 1)) {
          while (i < 64 && !tdec(&b, &msb, x, y, i)) i++;
          if (i > j->mb[r ? 3 * r - 3 + bd : 0] + 1u) return "bad bitplanes";
          bps = j->mb[r ? 3 * r - 3 + bd : 0] + 1 - i;
          np = npasses(&b);
          while (bit(&b)) lb++;
          sl = bits(&b, lb + 31 - __builtin_clz(np));
          if (bps >= 31 || np > 109) return "unsupported code-block";
        }
        if (o && meets(C, nbox(L, r, bd))) {
          o->cb = grow(o->cb, &o->cap, o->n + 1, sizeof *o->cb);
          o->cb[o->n++] = (j2k_cb){body, sl, C.x0 - B.x0, C.y0 - B.y0,
            C.x1 - C.x0, C.y1 - C.y0, bps, np, bd | r << 2, c, row};
        }
        body += sl;
      }
  }
  if ((b.buf & 0xff) == 0xff) bin(&b);   // byte-align, past any 0xff
  size_t h = b.p - s;
  if (h + (hd ? 0 : body) > n) return "truncated packet";
  *len = h + body;
  for (size_t i = first; o && i < o->n; i++) {
    j2k_cb *q = &o->cb[i];
    if (hd) { q->off += h; continue; }
    o->d = grow(o->d, &o->capd, o->nd + q->len + 2, 1);
    memcpy(o->d + o->nd, s + h + q->off, q->len);
    q->off = o->nd, o->nd += q->len;
    o->d[o->nd++] = 0xff, o->d[o->nd++] = 0xff;   // openjpeg's sentinel
  }
  return NULL;
}

// the packets of tile k in order, i from 0: resolution r, then component
// c, then precinct p (LRCP and RLCP agree with one layer)
#define PACKETS(j, k, i, r, c, p)                                           \
  for (int r = 0, i = 0; r <= (j)->nl; r++)                                 \
    for (int c = 0, np_ = pw(j, tbox(j, k), r, 0) * pw(j, tbox(j, k), r, 1); \
         c < (j)->nc; c++)                                                  \
      for (int p = 0; p < np_; p++, i++)

// a tile-part at p: its tile k, its length and its packets, packet i at
// p[off[i], off[i] + pn[i]) (j->mp of each), by its PLT, for which p[0, n)
// need hold only the header, or failing that by walking packet headers,
// for which it must hold the whole tile-part
const char *j2k_part(const j2k *j, const uint8_t *p, size_t n, int *k,
                     size_t *len, uint32_t *off, uint32_t *pn) {
  if (n < 14 || u16(p) != 0xff90 || u16(p + 2) != 10) return "no SOT";
  size_t L = u32(p + 6) ? u32(p + 6) : n, np = 0, at;
  const uint8_t *q = p + 12, *e = p + JMIN(L, n);
  uint32_t v = 0;
  if ((*k = u16(p + 4)) >= j->nt || p[10] || p[11] > 1) return "bad SOT";
  for (; q + 4 <= e && u16(q) != 0xff93; q += 2 + u16(q + 2)) {
    if (u16(q) == 0xff58)
      for (const uint8_t *z = q + 5; z < q + 2 + u16(q + 2) && z < e; z++)
        if (v = v << 7 | (*z & 127), !(*z & 128)) {
          if ((int)np == j->mp) return "too many packets in PLT";
          pn[np++] = v, v = 0;
        }
    if (u16(q) != 0xff58 && u16(q) != 0xff64)
      return "unsupported marker in tile-part header";
  }
  if (q + 2 > e) return "no SOD";
  if (!np && L > n) return "truncated tile-part";
  at = q + 2 - p, *len = L;
  if (np && (int)np != npk(j, tbox(j, *k))) return "PLT does not match tile";
  PACKETS(j, *k, i, r, c, pr) {
    size_t l = np ? pn[i] : 0;
    const char *err = np ? NULL : packet(j, *k, r, c, pr, p + at, L - at,
                                         NULL, 0, NULL, &l, 0);
    if (err) return err;
    if (at + l > L) return "packets overrun the tile-part";
    off[i] = at, pn[i] = l, at += l;
  }
  return NULL;
}

// tier-2: the code-blocks window [x0,x1)×[y0,y1) of tile k needs, from
// packets pk/pn (NULL when not read), appended to o, tagged row
const char *j2k_t2(const j2k *j, int k, const uint8_t *const *pk,
                   const uint32_t *pn, int x0, int y0, int x1, int y1,
                   int row, j2k_cbs *o) {
  j2k_box t = tbox(j, k);
  lev L[33];
  char need[4096];
  size_t len;
  if (j->mp > 4096) return "too many packets";
  j2k_need(j, k, x0, y0, x1, y1, need);
  reach(j, t, (j2k_box){JMAX(x0, t.x0), JMAX(y0, t.y0), JMIN(x1, t.x1),
                        JMIN(y1, t.y1)}, L);
  PACKETS(j, k, i, r, c, p) {
    const char *e = !need[i] ? NULL
                  : !pk[i] ? "a needed packet is missing"
                  : packet(j, k, r, c, p, pk[i], pn[i], L, row, o, &len, 0);
    if (e) return e;
  }
  return NULL;
}

// the code-blocks of packet i of tile k that window [x0,x1)×[y0,y1) needs,
// from s[0, n), which need hold only its header: appended to o, each off
// its offset in the packet and row i
const char *j2k_blocks(const j2k *j, int k, int i, const uint8_t *s,
                       size_t n, int x0, int y0, int x1, int y1,
                       j2k_cbs *o) {
  j2k_box t = tbox(j, k);
  lev L[33];
  size_t len;
  reach(j, t, (j2k_box){JMAX(x0, t.x0), JMAX(y0, t.y0), JMIN(x1, t.x1),
                        JMIN(y1, t.y1)}, L);
  PACKETS(j, k, a, r, c, p)
    if (a == i) return packet(j, k, r, c, p, s, n, L, i, o, &len, 1);
  return "no such packet";
}

// tier-1. the MQ decoder's 47 states as qe, then for each state and mps
// (cx = state << 1 | mps) the next cx on an mps and on an lps
static const uint16_t QE[47] = {0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521,
  0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601,
  0x5601, 0x5401, 0x5101, 0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401,
  0x2201, 0x1c01, 0x1801, 0x1601, 0x1401, 0x1201, 0x1101, 0x0ac1, 0x09c1,
  0x08a1, 0x0521, 0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049,
  0x0025, 0x0015, 0x0009, 0x0005, 0x0001, 0x5601};
static const uint8_t NM[47] = {1, 2, 3, 4, 5, 38, 7, 8, 9, 10, 11, 12, 13,
  29, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 45, 46};
static const uint8_t NL[47] = {1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18,
  20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46};
static uint32_t MQ[94];   // qe | next on mps << 16 | next on lps << 24

// context labels: zero coding by orientation (0: LL and LH, 1: HL, 2: HH)
// from the 8 neighbours' significance (bits NW N NE W E SW S SE), and sign
// coding (label | xor bit << 7) from W, E, N, S as sig | neg << 1 each
static uint8_t ZC[3][256], SC[256];

__attribute__((constructor)) static void j2k_init(void) {
  for (int i = 0; i < 94; i++) {
    int s = i >> 1, m = i & 1;
    MQ[i] = QE[s] | (NM[s] << 1 | m) << 16 |
            (unsigned)(NL[s] << 1 | (m ^ (s == 0 || s == 6 || s == 14))) << 24;
  }
  for (int f = 0; f < 256; f++) {
    int h = (f >> 3 & 1) + (f >> 4 & 1), v = (f >> 1 & 1) + (f >> 6 & 1);
    int d = (f & 1) + (f >> 2 & 1) + (f >> 5 & 1) + (f >> 7 & 1), hv = h + v;
    for (int o = 0; o < 2; o++) {
      int a = o ? v : h, b = o ? h : v;
      ZC[o][f] = a == 2 ? 8 : a ? (b ? 7 : d ? 6 : 5)
               : b ? 2 + b : d > 1 ? 2 : d;
    }
    ZC[2][f] = d > 2 ? 8 : d == 2 ? 6 + !!hv : d ? 3 + JMIN(hv, 2)
             : JMIN(hv, 2);
    int hc = JMIN(((f & 3) == 1) + ((f >> 2 & 3) == 1), 1) -
             JMIN(((f & 3) == 3) + ((f >> 2 & 3) == 3), 1);
    int vc = JMIN(((f >> 4 & 3) == 1) + ((f >> 6 & 3) == 1), 1) -
             JMIN(((f >> 4 & 3) == 3) + ((f >> 6 & 3) == 3), 1);
    int x = hc < 0 || (!hc && vc < 0);
    if (hc < 0) hc = -hc, vc = -vc;
    SC[f] = 9 + (!hc ? !!vc : 3 + vc) | x << 7;
  }
}

// the MQ decoder (ISO 15444-1 C.3), past the end reading 0xff 0xff as a
// marker, as openjpeg does. c is the standard's 32-bit register shifted up
// 32 bits, so that up to 48 bits can wait below its top 16, and each
// decision is branch-free: one in two is an lps on sentinel-2's noisy planes
typedef struct { uint32_t a; int ct; uint64_t c; const uint8_t *p; } mq;
#define INL static inline __attribute__((always_inline))

INL void mqin(mq *m) {   // bytes in, while there is room
  for (; m->ct <= 32; m->ct += 8)
    if (m->p[0] != 0xff) m->c += (uint64_t)*++m->p << (40 - m->ct);
    else if (m->p[1] > 0x8f) m->c += 0xffull << (40 - m->ct);
    else m->c += (uint64_t)*++m->p << (41 - m->ct), m->ct--;
}

INL int mqd(mq *m, uint8_t *cx) {
  uint32_t s = MQ[*cx], q = s & 0xffff, a = m->a - q;
  int x = m->c >> 48 < q, lps = (a < q) ^ x, d = (*cx & 1) ^ lps;
  m->c -= x ? 0 : (uint64_t)q << 48, a = x ? q : a;
  *cx = x || !(a & 0x8000) ? lps ? s >> 24 : s >> 16 : *cx;
  int n = __builtin_clz(a) - 16;   // renormalise
  m->a = a << n, m->c <<= n, m->ct -= n;
  if (m->ct < 16) mqin(m);
  return d;
}

// flags, one uint16 per coefficient, the four of a stripe's column side
// by side (one 64-bit load tests them): neighbours' significance in the
// low byte, then
#define SIG 256   // significant
#define NEG 512   // negative
#define VIS 1024  // visited by this plane's significance pass
#define REF 2048  // refined before
#define X4(b) (0x0001000100010001ull * (b))

// coefficient p, row r of its stripe (S4 flags a stripe), turns
// significant: its sign, value and neighbours' flags
INL void sig(mq *m, uint8_t *cx, uint16_t *p, int r, int S4, int32_t *v,
             int oph) {
  int n = r ? -1 : 3 - S4, s = r < 3 ? 1 : S4 - 3;
  int c = SC[(p[-4] >> 8 & 3) | (p[4] >> 6 & 12) | (p[n] >> 4 & 48) |
             (p[s] >> 2 & 192)];
  int g = mqd(m, cx + (c & 31)) ^ c >> 7;
  *v = g ? -oph : oph;
  p[0] |= SIG | g << 9, p[n - 4] |= 128, p[n] |= 64, p[n + 4] |= 32;
  p[-4] |= 16, p[4] |= 8, p[s - 4] |= 4, p[s] |= 2, p[s + 4] |= 1;
}

// tier-1: one code-block's passes, in stripes of four rows, column by
// column, into o (row stride os) as openjpeg's coefficients: magnitudes
// doubled, plus half the last plane decoded, halved toward zero
void j2k_t1(const uint8_t *d, const j2k_cb *b, int32_t *o, int os) {
  int w = b->w, h = b->h, S4 = (w + 2) * 4, bp = b->bps;
  uint16_t f[10 * 34 * 4], *F = f + S4;   // a stripe of padding each side
  int32_t v[32 * 32];
  uint8_t cx[19] = {4 << 1};
  const uint8_t *zc = ZC[(b->band & 3) == 3 ? 2 : (b->band & 3) == 1];
  mq m = {0x8000, 0, (uint64_t)d[0] << 48, d};
  cx[17] = 3 << 1, cx[18] = 46 << 1;
  memset(f, 0, ((h + 3) / 4 + 2) * S4 * 2), memset(v, 0, w * h * 4);
  mqin(&m), m.c <<= 7, m.ct -= 7;   // INITDEC
  for (unsigned i = 0, t = 2; i < b->pass && bp >= 1; i++) {
    int one = 1 << bp, half = one >> 1, oph = one | half;
    for (int y = 0; y < h; y += 4)
      for (int x = 0; x < w; x++) {
        uint16_t *p = F + (y >> 2) * S4 + (x + 1) * 4;
        int32_t *vp = v + y * w + x;
        int n = JMIN(h - y, 4), r = 0;
        uint64_t q;
        memcpy(&q, p, 8);
        if (t == 0) {   // significance propagation
          if (!(q & X4(255))) continue;
          for (; r < n; r++)
            if (!(p[r] & (SIG | VIS)) && p[r] & 255) {
              if (mqd(&m, cx + zc[p[r] & 255]))
                sig(&m, cx, p + r, r, S4, vp + r * w, oph);
              p[r] |= VIS;
            }
        } else if (t == 1) {   // magnitude refinement
          if (!(q & X4(SIG))) continue;
          for (; r < n; r++)
            if ((p[r] & (SIG | VIS)) == SIG) {
              int c = p[r] & REF ? 16 : p[r] & 255 ? 15 : 14;
              vp[r * w] += mqd(&m, cx + c) ^ (vp[r * w] < 0) ? half : -half;
              p[r] |= REF;
            }
        } else {   // cleanup, with a run-length mode for quiet columns
          if (n == 4 && !q) {
            if (!mqd(&m, cx + 17)) continue;
            r = mqd(&m, cx + 18) << 1, r |= mqd(&m, cx + 18);
            sig(&m, cx, p + r, r, S4, vp + r * w, oph), r++;
          }
          for (; r < n; r++)
            if (!(p[r] & (SIG | VIS)) && mqd(&m, cx + zc[p[r] & 255]))
              sig(&m, cx, p + r, r, S4, vp + r * w, oph);
          memcpy(&q, p, 8), q &= ~X4(VIS), memcpy(p, &q, 8);
        }
      }
    if (++t == 3) t = 0, bp--;
  }
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) o[y * os + x] = v[y * w + x] / 2;
}

// one level of the inverse 5/3 over positions [a, b), even ones low and
// odd ones high, n samples each at q[x]: for outputs [p0, p1), the evens
// beside them and then the odds, mirrored at the ends
#define MIR(x) ((x) < a ? 2 * a - (x) : (x) >= b ? 2 * b - 2 - (x) : (x))
static void lift(int32_t **q, int a, int b, int p0, int p1, int n) {
  int e = JMAX(p0 - 1, a);
  if (b - a == 1)
    for (int i = 0; a & 1 && i < n; i++) q[a][i] /= 2;
  for (e += e & 1; b - a > 1 && e < JMIN(p1 + 1, b); e += 2)
    for (int i = 0, *l = q[MIR(e - 1)], *r = q[MIR(e + 1)]; i < n; i++)
      q[e][i] -= (l[i] + r[i] + 2) >> 2;
  for (int x = p0 | 1; b - a > 1 && x < p1; x += 2)
    for (int i = 0, *l = q[MIR(x - 1)], *r = q[MIR(x + 1)]; i < n; i++)
      q[x][i] += (l[i] + r[i]) >> 1;
}

// the inverse dwt of a tile-component's coefficients a (row stride s) over
// the reach L, level by level: rows into b, then columns back into a, in
// openjpeg's order, which the lifting's rounding makes matter. q and tmp
// hold max(w, h) + 2 each, indexed by image position
static void idwt(const j2k *j, j2k_box t, const lev *L, int32_t *a,
                 int32_t *b, int32_t **q, int32_t *tmp) {
  int s = t.x1 - t.x0;
  for (int r = 1; r <= j->nl; r++) {
    j2k_box R = rbox(t, j->nl - r), Q = rbox(t, j->nl - r + 1), W = L[r].w;
    const lev *v = &L[r];
    int wl = Q.x1 - Q.x0, hl = Q.y1 - Q.y0, n = W.x1 - W.x0;
    if (n <= 0 || W.y1 <= W.y0) return;
    for (int x = R.x0; x < R.x1; x++) q[x] = tmp + x;
    for (int i = 0; i < 2; i++)   // the low rows, then the high ones
      for (int m = i ? v->hy0 : v->ly0; m < (i ? v->hy1 : v->ly1); m++) {
        int y = i ? hl + m - (R.y0 >> 1) : m - Q.y0;
        int32_t *row = a + (size_t)y * s;
        for (int x = v->lx0; x < v->lx1; x++) tmp[2 * x] = row[x - Q.x0];
        for (int x = v->hx0; x < v->hx1; x++)
          tmp[2 * x + 1] = row[wl + x - (R.x0 >> 1)];
        lift(q, R.x0, R.x1, W.x0, W.x1, 1);
        memcpy(b + (size_t)y * s + W.x0 - R.x0, tmp + W.x0, n * 4);
      }
    for (int m = v->ly0; m < v->ly1; m++)
      q[2 * m] = b + (size_t)(m - Q.y0) * s + W.x0 - R.x0;
    for (int m = v->hy0; m < v->hy1; m++)
      q[2 * m + 1] = b + (size_t)(hl + m - (R.y0 >> 1)) * s + W.x0 - R.x0;
    lift(q, R.y0, R.y1, W.y0, W.y1, n);
    for (int y = W.y0; y < W.y1; y++)
      memcpy(a + (size_t)(y - R.y0) * s + W.x0 - R.x0, q[y], n * 4);
  }
}

// samples of window [x0,x1)×[y0,y1) of tile k (the part inside it) from
// its coefficients a, nc tile-sized planes as tier-1 left them: the inverse
// dwt (in place), the RCT, the level shift and openjpeg's clamp, the first
// nc components into out[c·cs + (y - y0)·os + x - x0]
void j2k_samples(const j2k *j, int k, int x0, int y0, int x1, int y1,
                 int32_t *a, int nc, uint16_t *out, int os, size_t cs) {
  j2k_box t = tbox(j, k);
  j2k_box w = {JMAX(x0, t.x0), JMAX(y0, t.y0), JMIN(x1, t.x1), JMIN(y1, t.y1)};
  size_t s = t.x1 - t.x0, sh = s * (t.y1 - t.y0), m = JMAX(j->w, j->h) + 2;
  int32_t *b = malloc(4 * (sh + m)), **q = malloc(m * sizeof *q);
  int mx = (1 << j->prec) - 1;
  lev L[33];
  reach(j, t, w, L);
  for (int c = 0; c < j->nc; c++) idwt(j, t, L, a + c * sh, b, q, b + sh);
  for (int y = w.y0; y < w.y1; y++)
    for (int x = w.x0; x < w.x1; x++) {
      int32_t *p = a + (y - t.y0) * s + x - t.x0, v[4];
      for (int c = 0; c < j->nc; c++) v[c] = p[c * sh];
      if (j->mct) {
        int g = v[0] - ((v[1] + v[2]) >> 2);
        v[0] = v[2] + g, v[2] = v[1] + g, v[1] = g;
      }
      for (int c = 0; c < nc; c++) {
        int u = v[c] + (1 << (j->prec - 1));
        out[c * cs + (size_t)(y - y0) * os + x - x0] = u < 0 ? 0 : JMIN(u, mx);
      }
    }
  free(b), free(q);
}

// a parallel for, when the caller has threads to lend: f(a, i) for each i
// in [0, n), in any order
void (*j2k_spread)(void (*f)(void *, size_t), void *a, size_t n);

typedef struct { const j2k *j; j2k_box t; const j2k_cbs *o; int32_t *a; }
  t1job;

// code-block i, at its place in its plane: a band right of, below or
// right of and below the resolution beneath it, as openjpeg lays them out
static void t1one(void *p, size_t i) {
  const t1job *t = p;
  const j2k_cb *c = &t->o->cb[i];
  j2k_box Q = rbox(t->t, t->j->nl - (c->band >> 2) + !!(c->band >> 2));
  size_t s = t->t.x1 - t->t.x0, sh = s * (t->t.y1 - t->t.y0);
  int x = c->x + (c->band & 1 ? Q.x1 - Q.x0 : 0);
  int y = c->y + (c->band & 2 ? Q.y1 - Q.y0 : 0);
  j2k_t1(t->o->d + c->off, c, t->a + c->comp * sh + (size_t)y * s + x, s);
}

// the same from tile k's packets, through tier-2 and tier-1
const char *j2k_tile(const j2k *j, int k, const uint8_t *const *pk,
                     const uint32_t *pn, int x0, int y0, int x1, int y1,
                     int nc, uint16_t *out, int os, size_t cs) {
  j2k_box t = tbox(j, k);
  size_t s = t.x1 - t.x0, sh = s * (t.y1 - t.y0);
  j2k_cbs o = {0};
  const char *e = j2k_t2(j, k, pk, pn, x0, y0, x1, y1, 0, &o);
  int32_t *a = e ? NULL : malloc(4 * sh * j->nc);
  t1job job = {j, t, &o, a};
  if (!e && j2k_spread && o.n >= 1024) j2k_spread(t1one, &job, o.n);
  else for (size_t i = 0; !e && i < o.n; i++) t1one(&job, i);
  if (!e) j2k_samples(j, k, x0, y0, x1, y1, a, nc, out, os, cs);
  free(a), free(o.cb), free(o.d);
  return e;
}

// window [x0,x1)×[y0,y1) of the first nc components, comp-major, from a
// codestream, raw or in a JP2, with the tile-parts the window meets
const char *j2k_window(const uint8_t *p, size_t n, int x0, int y0, int x1,
                       int y1, int nc, uint16_t *out) {
  const uint8_t *s = p, *e = p + n;
  j2k j;
  while (s + 4 <= e && u32(s) != 0xff4fff51) s++;
  const char *err = j2k_main(&j, s, e - s);
  if (err) return err;
  if (nc > j.nc) return "too few components";
  const uint8_t **pk = malloc(j.mp * (sizeof *pk + 8));
  uint32_t *off = (uint32_t *)(pk + j.mp), *pn = off + j.mp;
  j2k_box w = {x0, y0, x1, y1};
  size_t len;
  int k;
  for (s += j.hlen; !err && s + 12 <= e && u16(s) == 0xff90; s += len) {
    len = u32(s + 6) ? u32(s + 6) : (size_t)(e - s), k = u16(s + 4);
    if (k < j.nt && meets(tbox(&j, k), w) &&
        !(err = j2k_part(&j, s, e - s, &k, &len, off, pn))) {
      for (int i = 0; i < j2k_need(&j, k, 0, 0, 0, 0, NULL); i++)
        pk[i] = s + off[i];
      err = j2k_tile(&j, k, pk, pn, x0, y0, x1, y1, nc, out, x1 - x0,
                     (size_t)(x1 - x0) * (y1 - y0));
    }
  }
  free(pk);
  return err;
}
