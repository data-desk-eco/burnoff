// Sentinel-2 L1C: cloud mask, B12 background and candidates, then B11 and
// B8A windows. Each stage queues its reads before decoding. Results retain
// the peak, radiance, hot-core pixels and each 640 m square's cloud share.
// Bounds are metres in the scene's UTM zone; other bands follow B12's URL.
#include "burnoff.h"
#include "j2k.c"

// the default compact-source gates
static const char *TK[] = {"b12_min", "b11_min", "peak_b12_min",
  "contrast_ratio", "background_floor", "peakedness_min", "saturation",
  "hot_floor", "max_pixels", "large_pixels", "large_b12_min",
  "warm_fraction", "warm_max_pixels", "single_pixel_min", "max_cloud_local",
  "nir_excess"};
static const double TD[] = {.30, .20, .50, 3, .15, 1.15, 1, .50, 80, 30, .70,
  .5, 100, .65, .75, .1};
enum { B12MIN, B11MIN, PEAKMIN, CONTRAST, BGFLOOR, PEAKED, SAT, HOT, MAXPX,
  LARGEPX, LARGEMIN, WARMF, WARMMAX, SINGLE, MAXCLOUD, NIR, NT };

// Fractions and counts have their natural domains; the other gates are
// nonnegative and may be raised to disable a test.
static const char *thresholds(const double *t) {
  for (int k = 0; k < NT; k++) if (t[k] < 0) return "negative threshold";
  if (t[WARMF] > 1 || t[MAXCLOUD] > 1) return "fraction outside 0..1";
  int counts[] = {MAXPX, LARGEPX, WARMMAX};
  for (int k = 0; k < 3; k++)
    if (t[counts[k]] != floor(t[counts[k]])) return "noninteger pixel count";
  return NULL;
}

#define CELL 320   // background cell: a quarter of a 640 px jp2 tile, or
                   // across 512 px tiles from baseline 05.13
// a jp2 decode costs ~0.2 ms however small its window (the packets it
// needs and the code-blocks those reach), as much as 2^11 more pixels
#define FIXED (1 << 11)
#define SUB 32     // a cloud square: 640 m, a tenth of a background cell
#define NP 64      // packets a tile-part may hold: 40 in a 640 px tile
// reads closer than this are one: a request costs about as much
#define GAP (32 << 10)
// a band's tile-parts are read whole, not their PLTs and then the packets
// wanted, while they come to this or less: a round saved for more bytes (a
// site's b12 needs 52% of a tile-part, b11's and b8a's 19%)
#define WHOLE (1 << 20)

// N0400+ radiometry: every band carries RADIO_ADD_OFFSET -1000 over a
// QUANTIFICATION_VALUE of 10000. older baselines have no raster cloud mask.
static double cal(int dn) { return dn ? (dn - 1000) / 10000. : 0; }

// a direct-mapped cache of file headers and cloud masks, a few KB each,
// shared by every worker
typedef struct { char *key; unsigned char *p; size_t n; long long aux; } slot;
static slot cache[4096];
static pthread_mutex_t ck = PTHREAD_MUTEX_INITIALIZER;

static slot *slotof(const char *key) {
  unsigned long h = 14695981039346656037ul;
  while (*key) h = (h ^ (unsigned char)*key++) * 1099511628211ul;
  return &cache[h % 4096];
}

static int recall(const char *key, buf *out, long long *aux) {
  pthread_mutex_lock(&ck);
  slot *s = slotof(key);
  int hit = s->key && !strcmp(s->key, key);
  if (hit) out->n = 0, append(out, s->p, s->n), *aux = s->aux;
  pthread_mutex_unlock(&ck);
  return hit;
}

static void keep(const char *key, const buf *b, long long aux) {
  unsigned char *c = malloc(b->n);
  char *k = strdup(key);
  memcpy(c, b->p, b->n);
  pthread_mutex_lock(&ck);
  slot *s = slotof(key);
  free(s->key), free(s->p);
  *s = (slot){k, c, b->n, aux};
  pthread_mutex_unlock(&ck);
}

static unsigned be(const unsigned char *p, int n) {
  unsigned v = 0;
  while (n--) v = v << 8 | *p++;
  return v;
}

// one band file: its main header, geometry and coding, and where its
// tile-parts are
typedef struct {
  j2k j;                       // its main header, parsed
  long long first, size;       // first SOT offset, file size
  int w, h_, tw, th, nx, nt;   // image, tile, tiles across, tile count
  int ok, tlm, round;          // parsed, indexed, search rounds made
  double ox, oy, res;          // upper-left corner and pixel size, metres
  long long at[256], len[256]; // tile-parts located in the file, 0 = unknown
} band;

// one detection; x y is the peak pixel's centre in the box's UTM metres,
// and pp its hot core's px pixels, each its row << 16 | column in the tile,
// then its b12
typedef struct {
  double x, y, max, avg, b11, ratio, pk, rad;
  int px, sat, *pp;
} det;
typedef struct { double x, y, cloud; } sq;   // an obscured square's centre
typedef struct { double clear; det *d; sq *q; int nd, cap, nq; } res;
typedef struct { int k, x0, y0, x1, y1; } win;   // [x0,x1)×[y0,y1) of tile k

// One queued window decode, from packet pointers (NULL where unread) into
// o at row stride ow from origin ox, oy. Decodes follow a stage's reads.
typedef struct {
  int b, k, x0, y0, x1, y1;
  uint32_t n[NP];
  const unsigned char *p[NP];
  unsigned short *o;
  int ow, ox, oy;
} dj;

// a job: the hotspots in a box of one scene, and its clear-sky share
typedef struct {
  job *io;
  const char *u[4];               // b12, b11, b8a, the cloud mask
  double box[4], t[NT];
  res r;
  const char *e;
  int budget, nq, qcap, nw;
  band bd[3];
  dj *dq;                         // the decodes queued
  win *wn;                        // the windows of the band at hand
  buf s, mk;                      // scratch, the mask
  int X0, Y0, X1, Y1, W, H, mc, cx0, cy0, cw, ch, gx0, gy0, ncx, nc;
  unsigned short *b12, *m, *v12, *v11, *v8a, *g12, *g8a;
  int *cnt, *cld, *idx, *par;
  double *ct, *bgm;
  char *ok, *sel;
} s2;

// the packets that decoding [x0,x1)×[y0,y1) of tile k reads (j2k.c's
// need), bit i for packet i, and their number in *n
static uint64_t need(const band *f, int k, int x0, int y0, int x1, int y1,
                     int *n) {
  char c[NP];
  uint64_t m = 0;
  *n = j2k_need(&f->j, k, x0, y0, x1, y1, c);
  for (int i = 0; i < *n; i++) m |= (uint64_t)c[i] << i;
  return m;
}

// a band's header. it is the same on every date of one MGRS tile, band and
// processing baseline (only kakadu's comments differ), so one read serves
// them all, and the file's size, until a read gives it, is that file's. a
// newer file's header also carries a TLM, the offset of each of its own
// tile-parts: of each such file only the codestream's header is read, to
// a KB past where the tile's puts the first tile-part (its PLT within),
// after the jp2 boxes the tile's header gives. the tile-parts are then
// read exactly where its TLM puts them
static const char *header(s2 *j, const char *url, band *f) {
  char key[64];
  const char *fn = strrchr(url, '/') ? strrchr(url, '/') + 1 : url;
  const char *bd = strrchr(fn, '_'), *nb = strstr(url, "_N");
  buf *b = &j->s;
  long long size = -1, lo = 0, hi = 16384;
  int own = 0, got_ = 0, n = 0;   // b is this file's own
  unsigned char *s, *sot, *q;
  if (f->ok) return NULL;
  snprintf(key, sizeof key, "%.6s%.12s%.6s", fn, bd ? bd : "", nb ? nb : "");
again:
  if (!recall(own ? url : key, b, &size)) {
    rd *r = got(j->io, url, lo, hi), *z = r && r->b.size < 0
                                       ? got(j->io, url, 0, -2) : r;
    if (!r) return want(j->io, url, lo, hi);
    if (!z) return want(j->io, url, 0, -2);   // no Content-Range (file://)
    if ((size = z->b.size) < 0) return "unknown file size";
    b->n = lo, append(b, r->b.p + lo - r->lo,
                       MIN(r->lo + (long long)r->b.n, hi) - lo);
    own = got_ = 1;
  }
  // the main header's markers, to the first SOT
  s = memmem(b->p, b->n, "\xff\x4f\xff\x51", 4), sot = NULL;
  for (q = s ? s + 2 : NULL; q && !sot && q + 4 <= b->p + b->n;
       q += 2 + be(q + 2, 2))
    if (be(q, 2) == 0xff90) sot = q;
  if (lo && (s != b->p + lo || !sot)) {   // not where the tile's put it
    lo = 0, hi = 16384;
    goto again;
  }
  if (!sot || be(s + 4, 2) < 41 || be(s + 40, 2) != 1 ||
      be(s + 16, 4) | be(s + 20, 4) | be(s + 32, 4) | be(s + 36, 4))
    return "no single-component, origin-anchored codestream header";
  // the GMLJP2 box ahead of the codestream: pixel (1,1)'s centre, then the
  // pixel size as the first offset vector
  char *g = memmem(b->p, s - b->p, "<gml:pos>", 9);
  char *o = g ? memmem(g, s - (unsigned char *)g, "<gml:offsetVector", 17) : 0;
  if (!o || !(o = memchr(o, '>', 128)) ||
      sscanf(g + 9, "%lf %lf", &f->ox, &f->oy) != 2 ||
      sscanf(o + 1, "%lf", &f->res) != 1 || f->res <= 0)
    return "no GMLJP2 georeferencing";
  f->ox -= f->res / 2, f->oy += f->res / 2;
  f->w = be(s + 8, 4), f->h_ = be(s + 12, 4);
  f->tw = be(s + 24, 4), f->th = be(s + 28, 4);
  f->nx = (f->w + f->tw - 1) / f->tw;
  f->nt = f->nx * ((f->h_ + f->th - 1) / f->th);
  if (f->nt > 256) return "more than 256 jp2 tiles";
  // the coding, which j2k.c refuses unless packets stand alone (one layer,
  // no SOP or EPH, ...), and the TLM, whose entries are a tile (of st bytes,
  // or in turn) and a length (of sp)
  long long at = sot - b->p;
  const char *e = j2k_main(&f->j, s, sot - s);
  if (e) return e;
  if (f->j.mp > NP) return "too many packets";
  memset(f->at, 0, sizeof f->at);
  for (q = s + 2; q + 4 <= sot; q += 2 + be(q + 2, 2)) {
    int L = be(q + 2, 2), st = q[5] >> 4 & 3, sp = q[5] & 64 ? 4 : 2;
    if (q[1] != 0x55) continue;
    if (!own) {
      own = 1, lo = s - b->p, hi = sot - b->p + 1024;
      goto again;
    }
    else for (int i = 6; i + st + sp <= L + 2; i += st + sp, n++) {
      int t = st ? (int)be(q + i, st) : n;
      if (t < f->nt) f->at[t] = at, f->len[t] = be(q + i + st, sp);
      at += be(q + i + st, sp);
    }
  }
  if (got_) keep(key, b, size);
  if (got_ && n) keep(url, b, size);
  else if (n && !got(j->io, url, 0, b->n)) {   // cached: tile 0's PLT is in it
    rd *r = add(j->io, url, 0, b->n);
    append(&r->b, b->p, b->n), r->b.size = size, r->ok = 1;
  }
  f->first = sot - b->p, f->size = size, f->tlm = n > 0, f->ok = 1;
  return NULL;
}

// a tile-part header: SOT, Lsot = 10, a tile index in range, the only part
static int sot(const unsigned char *p, int nt, int *k, long long *len) {
  if (p[0] != 0xff || p[1] != 0x90 || be(p + 2, 2) != 10) return 0;
  *k = be(p + 4, 2), *len = be(p + 6, 4);
  return *k < nt && !p[10] && p[11] <= 1 && *len >= 14;
}

// tile-part k's packets, by j2k.c from the PLT in its header (512 bytes
// hold one of NP lengths), or with the tile-part in hand by its packet
// headers: their offsets o in the file and lengths l, and their number; 0
// while that header is not in hand, -1 if it is malformed or its packets
// do not fill it
static int pk(s2 *j, const char *url, band *f, int k, long long *o,
              uint32_t *l) {
  long long a = f->at[k], s = f->len[k];
  rd *r = got(j->io, url, a, a + s);
  uint32_t off[NP];
  size_t len;
  int t, n = j2k_need(&f->j, k, 0, 0, 0, 0, NULL);
  if (!r && !(r = got(j->io, url, a, a + (s = MIN(s, 512))))) return 0;
  if (j2k_part(&f->j, r->b.p + (a - r->lo), s, &t, &len, off, l) || t != k ||
      (long long)len != f->len[k] || off[n - 1] + l[n - 1] != len)
    return -1;
  for (int i = 0; i < n; i++) o[i] = a + off[i];
  return n;
}

// without a TLM: the tile-parts of url found by any job, merged into f and
// f's into them (in the cache), so the next job reads them as exactly as
// a TLM allows
static void share(const char *url, band *f) {
  char key[4200];
  long long c[512] = {0}, s;
  buf b = {0};
  int d = 0;
  snprintf(key, sizeof key, "%s#t", url);
  if (recall(key, &b, &s) && b.n == sizeof c) memcpy(c, b.p, sizeof c);
  for (int k = 0; k < f->nt; k++)
    if (!f->at[k]) f->at[k] = c[k], f->len[k] = c[256 + k];
    else if (f->at[k] != c[k]) c[k] = f->at[k], c[256 + k] = f->len[k], d = 1;
  if (d) keep(key, &(buf){.p = (unsigned char *)c, .n = sizeof c}, 0);
  drop(&b);
}

// without a TLM: the tile-parts in each read of url not yet scanned, by
// their SOT markers, and those other jobs found. a read past the end of the
// file, whose size was another date's, asks for its size
static const char *scan(s2 *j, const char *url, band *f) {
  for (rd *r = j->io->rq; r < j->io->rq + j->io->nr; r++) {
    if (r->sc || strcmp(r->url, url) || !(r->ok || r->e == PAST)) continue;
    r->sc = 1, f->size = r->b.size > 0 ? r->b.size : f->size;
    if (r->e) return want(j->io, url, 0, 1);
    for (const unsigned char *p = r->b.p, *z = p + r->b.n;
         (p = memchr(p, 0xff, z - p)) && z - p >= 12; p++) {
      long long len, at = r->lo + (p - r->b.p);
      int k;
      if (sot(p, f->nt, &k, &len) && at + len <= f->size)
        f->at[k] = at, f->len[k] = len;
    }
  }
  return share(url, f), NULL;
}

// learned layouts: where each tile-part sat, as fractions of file size, per
// MGRS tile, band and tile grid, from a search or a TLM. the land/sea/cloud
// mix that sizes a tile changes little between dates, so after one file the
// next is read in one request per tile
typedef struct { char key[24]; float at[256], len[256]; } layout;
static layout lay[4096];
static int nlay;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;

// T13SFR_20250519T172859_B11.jp2 of 81 tiles → T13SFR_B11.jp281, or with
// band, _B12.jp281
static layout *learned(const char *url, const char *band, int nt) {
  const char *f = strrchr(url, '/') ? strrchr(url, '/') + 1 : url;
  const char *b = strrchr(f, '_');
  char key[24];
  snprintf(key, sizeof key, "%.6s%.10s%d", f, band ? band : b ? b : "", nt);
  for (int i = 0; i < nlay; i++)
    if (!strcmp(lay[i].key, key)) return &lay[i];
  if (nlay == 4096) return NULL;
  memset(&lay[nlay], 0, sizeof *lay);
  return strcpy(lay[nlay].key, key), &lay[nlay++];
}

// where to look for tile-part k, in q: first where the layout puts it (the
// expected length sizing the read), or evenly spread; then from where the
// tile-part before it ends, or between the nearest found either side, the
// whole gap once it is small and otherwise where k should sit within it
static void seek(const band *f, const layout *l, int k, long long *q) {
  long long s = f->size, p, W, A = s;
  if (!f->round) {
    long long w = l->at[k] ? l->len[k] * s : 0, M = w ? 64 << 10 : 256 << 10;
    p = (l->at[k] ? (long long)(l->at[k] * s)
                  : f->first + (long long)((double)k * (s - f->first) /
                                           f->nt)) - M;
    W = 2 * M + (w ? w + w / 8 : 512 << 10);
  } else {
    int a = k, b = k;
    while (--a >= 0 && !f->at[a]);
    while (++b < f->nt && !f->at[b]);
    long long B = a < 0 ? f->first : f->at[a] + f->len[a], g;
    A = b < f->nt ? f->at[b] : s, g = A - B;
    W = a == k - 1 ? 1 << 20 : MIN(g, 4 << 20);
    p = a == k - 1 || g <= 4 << 20 ? B
      : B + g * (k - a - 1) / (b - a - 1) - W / 2;
  }
  q[0] = MAX(MIN(p, s - W), f->first), q[1] = MIN(q[0] + W, A);
}

// band f's reads for decode windows w[0..n), as runs: each tile-part whole
// where it is wanted whole, as without a TLM or under a request budget, or
// while those whose PLT is not in hand come to WHOLE or less (a round
// sooner than the PLT allows, for about twice a site's bytes), else the PLT
// in its header and then the packets the windows need. LACK until all are
// in hand
static const char *parts(s2 *j, const char *url, band *f, const win *w,
                         int n) {
  uint64_t m[256] = {0};
  long long o[NP], *q, a, b, z = 0;
  uint32_t l[NP];
  int c, nq = 0, miss = 0, look = 0;
  size_t qc = (size_t)NP * f->nt;
  const char *e = f->tlm ? NULL : scan(j, url, f);
  layout L = {0}, *g;
  if (e) return e;
  for (int i = 0; i < n; i++)
    m[w[i].k] |= need(f, w[i].k, w[i].x0, w[i].y0, w[i].x1, w[i].y1, &c);
  // a band not yet seen on this MGRS tile borrows b12's layout, which the
  // same date's b12 read has just taught
  pthread_mutex_lock(&lk);
  if (!f->tlm && (g = learned(url, NULL, f->nt))) L = *g;
  g = f->tlm ? NULL : learned(url, "_B12.jp2", f->nt);
  for (int k = 0; g && k < 256; k++)
    if (!L.at[k]) L.at[k] = g->at[k], L.len[k] = g->len[k];
  pthread_mutex_unlock(&lk);
  // z: the bytes of the tile-parts wanted whose PLT is not in hand
  for (int k = 0; k < f->nt; k++)
    z += m[k] && f->tlm && f->at[k] && !pk(j, url, f, k, o, l) ? f->len[k] : 0;
  q = mem(16 * qc);
  for (int k = 0; k < f->nt; k++) {
    if (!m[k] || ((a = f->at[k]) && got(j->io, url, a, b = a + f->len[k])))
      continue;
    if (miss++, !a) { seek(f, &L, k, q + 2 * nq++), look = 1; continue; }
    need(f, k, 0, 0, f->w, f->h_, &c);
    int np = !f->tlm || j->budget || m[k] == (c < 64 ? (1ull << c) - 1 : ~0ull)
           ? -2 : pk(j, url, f, k, o, l);
    if (np == -1 || np > 0 ? np != c : 0)
      return unmem(q), "malformed tile-part header";
    if (!np && z <= WHOLE) np = -2;
    if (np < 0) q[2 * nq] = a, q[2 * nq++ + 1] = b;
    else if (!np) q[2 * nq] = a, q[2 * nq++ + 1] = a + MIN(f->len[k], 512);
    else for (int i = 0; i < np; i++)
      if (m[k] >> i & 1 && !got(j->io, url, o[i], o[i] + l[i]))
        q[2 * nq] = o[i], q[2 * nq++ + 1] = o[i] + l[i];
  }
  // without a TLM and much of the band wanted: the whole codestream
  if (!f->tlm && j->budget && miss > f->nt / 4)
    q[0] = f->first, q[1] = -1, nq = 1;
  else nq = merge(q, nq, j->io->gap, j->budget);
  if (look && ++f->round > 12) e = "tile-part not found";
  for (int i = 0; i < nq && (!e || e == LACK); i++)
    e = want(j->io, url, q[2 * i], q[2 * i + 1]);
  unmem(q);
  if (e) return e;
  pthread_mutex_lock(&lk);
  if ((g = learned(url, NULL, f->nt)))
    for (int k = 0; k < f->nt; k++)
      if (f->at[k])
        g->at[k] = (double)f->at[k] / f->size,
        g->len[k] = (double)f->len[k] / f->size;
  pthread_mutex_unlock(&lk);
  return NULL;
}

// one decode, by j2k.c from its packets, unread ones NULL: the one place
// another decoder goes
static const char *dodec(s2 *j, dj *d) {
  const char *e = j2k_tile(&j->bd[d->b].j, d->k, d->p, d->n, d->x0, d->y0,
                           d->x1, d->y1, 1, d->o + (size_t)(d->y0 - d->oy) *
                                            d->ow + d->x0 - d->ox, d->ow, 0);
  return e;
}

// the decodes of windows w[0..n) of band b, into o: each window with the
// packets of its tile in hand
static const char *decs(s2 *j, const char *url, int b, const win *w, int n,
                        unsigned short *o) {
  band *f = j->bd + b;
  long long q[NP];
  for (int i = 0, c; i < n; i++) {
    if (j->nq == j->qcap)
      j->dq = remem(j->dq, (j->qcap = 2 * j->qcap + 16) * sizeof *j->dq);
    dj *d = &j->dq[j->nq++];
    *d = (dj){b, w[i].k, w[i].x0, w[i].y0, w[i].x1, w[i].y1, {0}, {0},
              o, j->W, j->X0, j->Y0};
    need(f, d->k, 0, 0, f->w, f->h_, &c);
    if (pk(j, url, f, d->k, q, d->n) != c)
      return "malformed tile-part header";
    for (int p = 0; p < c; p++) {
      rd *r = got(j->io, url, q[p], q[p] + d->n[p]);
      d->p[p] = r ? r->b.p + (q[p] - r->lo) : NULL;
    }
  }
  return NULL;
}

// position of box index v among the sorted candidate indices, or -1
static int at(const int *a, int n, int v) {
  int lo = 0, hi = n;
  while (lo < hi) {
    int m = (lo + hi) / 2;
    if (a[m] < v) lo = m + 1; else hi = m;
  }
  return lo < n && a[lo] == v ? lo : -1;
}

static long area(const win *w) {
  return (long)(w->x1 - w->x0) * (w->y1 - w->y0);
}

// the brightest data pixel of raster within RING of candidate j that is not
// a candidate: its surroundings at their brightest, in dn, or 0
#define RING 3
static int ring(const unsigned short *raster, const int *idx, int mc, int j,
                int W, int H) {
  int x = idx[j] % W, y = idx[j] / W, m = 0;
  for (int v = MAX(y - RING, 0); v <= MIN(y + RING, H - 1); v++)
    for (int u = MAX(x - RING, 0); u <= MIN(x + RING, W - 1); u++)
      if (raster[v * W + u] > m && at(idx, mc, v * W + u) < 0)
        m = raster[v * W + u];
  return m;
}

static int cloudy(const s2 *j, int row, int col) {
  size_t i = (size_t)((j->Y0 + row) / 3 - j->cy0) * j->cw +
             (j->X0 + col) / 3 - j->cx0;
  return j->m[i] || j->m[(size_t)j->cw * j->ch + i];
}

// the mask, whole (a few KB): opaque cloud and cirrus layers
static const char *mask(s2 *j) {
  char key[4200];
  long long aux;
  rd *r;
  if (!j->u[3] || j->mk.n) return NULL;
  snprintf(key, sizeof key, "%s#c", j->u[3]);
  if (recall(key, &j->mk, &aux)) return NULL;
  if (!(r = got(j->io, j->u[3], 0, -1))) return want(j->io, j->u[3], 0, -1);
  append(&j->mk, r->b.p, r->b.n), keep(key, &j->mk, 0);
  return NULL;
}

static int grid(const band *g, const band *f) {
  return g->w == f->w && g->h_ == f->h_ && g->tw == f->tw && g->ox == f->ox &&
         g->oy == f->oy;
}

// stage 0, the headers and the mask: the box in pixels, its background
// cells, cloud first, and b12's windows: each jp2 tile is decoded over the
// bounding box of its clear cells, and one with none is never fetched. b11's
// and b8a's headers are asked for too, so that b12's round can bring their
// PLTs or tile-parts (under a request budget, b12's round brings them)
static const char *heads(s2 *j) {
  band *f = j->bd;
  const char *nb = strstr(j->u[0], "_N"), *e, *m;
  if (!nb || atoi(nb + 2) < 400) return "needs baseline N0400 or later";
  if (!j->u[1] || !j->u[2] || !j->u[3]) return "b12 url not in SAFE form";
  e = header(j, j->u[0], f), m = mask(j);
  if (!j->budget) header(j, j->u[1], j->bd + 1), header(j, j->u[2], j->bd + 2);
  if (e) return e;
  double v[4] = {floor((j->box[0] - f->ox) / f->res),
                 floor((f->oy - j->box[3]) / f->res),
                 ceil((j->box[2] - f->ox) / f->res),
                 ceil((f->oy - j->box[1]) / f->res)};
  int lim[4] = {f->w, f->h_, f->w, f->h_}, p[4], tb[256][4];
  char need[256] = {0};
  for (int i = 0; i < 4; i++)
    p[i] = v[i] < 0 ? 0 : v[i] > lim[i] ? lim[i] : v[i];
  int X0 = j->X0 = p[0], Y0 = j->Y0 = p[1], X1 = j->X1 = p[2],
      Y1 = j->Y1 = p[3], W = j->W = X1 - X0, H = j->H = Y1 - Y0;
  if (W <= 0 || H <= 0) return FIN;   // the box misses this tile
  if (m) return m;
  int cx0 = j->cx0 = X0 / 3, cy0 = j->cy0 = Y0 / 3;
  int cw = j->cw = (X1 + 2) / 3 - cx0, ch = j->ch = (Y1 + 2) / 3 - cy0;
  j->m = mem((size_t)2 * cw * ch * 2);
  if ((e = j2k_window(j->mk.p, j->mk.n, cx0, cy0, cx0 + cw, cy0 + ch, 2,
                      j->m)))
    return e;
  int gx0 = j->gx0 = X0 / CELL, gy0 = j->gy0 = Y0 / CELL;
  int ncx = j->ncx = (X1 - 1) / CELL - gx0 + 1;
  int nc = j->nc = ncx * ((Y1 - 1) / CELL - gy0 + 1);
  int *cnt = j->cnt = mem(nc * sizeof *cnt),
      *cld = j->cld = mem(nc * sizeof *cld);
  for (int y = Y0; y < Y1; y++) {
    unsigned short *m0 = j->m + (y / 3 - cy0) * cw, *m1 = m0 + cw * ch;
    int *cn = cnt + (y / CELL - gy0) * ncx, *cd = cld + (cn - cnt);
    for (int xx = X0; xx < X1; xx++)
      cn[xx / CELL - gx0]++, cd[xx / CELL - gx0] += m0[xx / 3 - cx0] ||
                                                   m1[xx / 3 - cx0];
  }
  for (int c = 0; c < nc; c++) {
    int gx = gx0 + c % ncx, gy = gy0 + c / ncx;
    int x0 = MAX(gx * CELL, X0), y0 = MAX(gy * CELL, Y0);
    int x1 = MIN(gx * CELL + CELL, X1), y1 = MIN(gy * CELL + CELL, Y1);
    if (cld[c] > j->t[MAXCLOUD] * cnt[c]) continue;
    // a cell can straddle jp2 tiles (512 px from N0513): each gets its part
    for (int ty = y0 / f->th; ty <= (y1 - 1) / f->th; ty++)
      for (int tx = x0 / f->tw; tx <= (x1 - 1) / f->tw; tx++) {
        int k = ty * f->nx + tx, *b = tb[k];
        int a0 = MAX(x0, tx * f->tw), a1 = MAX(y0, ty * f->th);
        int a2 = MIN(x1, tx * f->tw + f->tw), a3 = MIN(y1, ty * f->th + f->th);
        if (!need[k]) b[0] = a0, b[1] = a1, b[2] = a2, b[3] = a3, need[k] = 1;
        b[0] = MIN(b[0], a0), b[1] = MIN(b[1], a1);
        b[2] = MAX(b[2], a2), b[3] = MAX(b[3], a3);
      }
  }
  j->wn = mem(256 * sizeof *j->wn), j->nw = 0;
  for (int k = 0; k < f->nt; k++)
    if (need[k])
      j->wn[j->nw++] = (win){k, tb[k][0], tb[k][1], tb[k][2], tb[k][3]};
  j->b12 = mem((size_t)W * H * 2);
  return NULL;
}

// stage 1: b12's tile-parts or packets, and its decodes. while b12 lacks
// reads, the PLTs of b11 and b8a in its tiles come with them, so that the
// packets around candidates are a round trip away once b12 is decoded
// (under a request budget, their headers, for their tile-parts). their
// tile-parts whole would spare a site that round, for 10-60% more bytes and
// no time that 10 runs over 4 sets of jobs could show
static const char *b12(s2 *j) {
  const char *e = parts(j, j->u[0], j->bd, j->wn, j->nw);
  for (int i = 0; e == LACK && i < 2 * j->nw; i++) {
    band *g = j->bd + 1 + i % 2;
    const char *u = j->u[1 + i % 2];
    int k = j->wn[i / 2].k;
    long long a = g->ok && g->tlm ? g->at[k] : 0, b = a + MIN(g->len[k], 512);
    if (j->budget) header(j, u, g);
    else if (a && !got(j->io, u, a, b)) want(j->io, u, a, b);
  }
  return e ? e : decs(j, j->u[0], 0, j->wn, j->nw, j->b12);
}

// the 640 m squares of the box, row by row, from each one's pixels and
// obscured ones, s[2q] and s[2q + 1]
static void squares(s2 *j, const uint32_t *s) {
  band *f = j->bd;
  res *r = &j->r;
  int qx0 = j->X0 / SUB, qy0 = j->Y0 / SUB, nx = (j->X1 - 1) / SUB - qx0 + 1;
  r->q = malloc((r->nq = nx * ((j->Y1 - 1) / SUB - qy0 + 1)) * sizeof *r->q);
  for (int q = 0; q < r->nq; q++)
    r->q[q] = (sq){f->ox + ((qx0 + q % nx) * SUB + SUB / 2.) * f->res,
                   f->oy - ((qy0 + q / nx) * SUB + SUB / 2.) * f->res,
                   (double)s[2 * q + 1] / s[2 * q]};
}

// over the b12 raster alone: per cell the background (no data counts as
// obscured; the median of the dim pixels, below b12_min, from a histogram
// of their counts) and its contrast threshold, the clear share, the
// obscured share of each 640 m square, and the candidates: pixels above
// b12_min and their cell's threshold, in raster order. whether a peak of
// peak_b12_min is among them, which a detection needs
static int screen(s2 *j) {
  const double *t = j->t;
  const unsigned short *b12 = j->b12;
  int X0 = j->X0, Y0 = j->Y0, X1 = j->X1, Y1 = j->Y1, W = j->W, H = j->H;
  int gx0 = j->gx0, gy0 = j->gy0, ncx = j->ncx, nc = j->nc, *cnt = j->cnt;
  int *cld = j->cld, seen = W * H, clear = 0, hot = 0, cap = 0;
  double *ct = j->ct = mem(nc * sizeof *ct);
  double *bgm = j->bgm = mem(nc * sizeof *bgm);
  int cut = (int)MIN(ceil(1000 + t[B12MIN] * 10000), 65536),
      *hist = mem(cut * 4);
  for (int c = 0; c < nc; c++) clear += cnt[c] - cld[c];
  for (int c = 0; c < nc; c++) {
    int gx = gx0 + c % ncx, gy = gy0 + c / ncx, nbg = 0, nd = 0, ndc = 0;
    int ax = MAX(gx * CELL - X0, 0), ay = MAX(gy * CELL - Y0, 0);
    int bx = MIN(gx * CELL + CELL - X0, W), by = MIN(gy * CELL + CELL - Y0, H);
    ct[c] = INFINITY;
    if (cld[c] > t[MAXCLOUD] * cnt[c]) continue;
    memset(hist, 0, cut * 4);
    for (int r0 = ay; r0 < by; r0++)
      for (int c0 = ax; c0 < bx; c0++) {
        int dn = b12[(size_t)r0 * W + c0];
        if (!dn) nd++, ndc += !cloudy(j, r0, c0);
        else if (dn < cut && cal(dn) < t[B12MIN]) hist[dn]++, nbg++;
      }
    seen -= nd, clear -= ndc;
    if (cld[c] + ndc > t[MAXCLOUD] * cnt[c] || nbg < 10) continue;
    int i = 0;
    for (int s = 0; (s += hist[i]) <= nbg / 2; i++);
    double med = bgm[c] = cal(i);
    ct[c] = (med > t[BGFLOOR] ? med : t[BGFLOOR]) * t[CONTRAST];
  }
  unmem(hist);
  if (seen > 0) j->r.clear = (double)clear / seen;
  int qx0 = X0 / SUB, qy0 = Y0 / SUB, nqx = (X1 - 1) / SUB - qx0 + 1;
  uint32_t *s = mem(2 * nqx * ((Y1 - 1) / SUB - qy0 + 1) * 4);
  for (int r0 = 0; r0 < H; r0++)
    for (int c0 = 0; c0 < W; c0++) {
      int gx = X0 + c0, gy = Y0 + r0;
      int c = (gy / CELL - gy0) * ncx + gx / CELL - gx0;
      uint32_t *q = s + 2 * ((gy / SUB - qy0) * nqx + gx / SUB - qx0);
      q[0]++, q[1] += cld[c] > t[MAXCLOUD] * cnt[c] || cloudy(j, r0, c0) ||
                      !b12[(size_t)r0 * W + c0];
    }
  squares(j, s), unmem(s);
  for (int r0 = 0; r0 < H; r0++)
    for (int c0 = 0; c0 < W; c0++) {
      double v = cal(b12[(size_t)r0 * W + c0]);
      int c = ((Y0 + r0) / CELL - gy0) * ncx + (X0 + c0) / CELL - gx0;
      if (v <= t[B12MIN] || v <= ct[c]) continue;
      if (j->mc == cap)
        j->idx = remem(j->idx, (cap = cap ? 2 * cap : 256) * 4);
      j->idx[j->mc++] = r0 * W + c0, hot |= v >= t[PEAKMIN];
    }
  return hot;
}

// the windows around the selected candidates: each component's box of them
// in each jp2 tile, merged while the union costs less than a second decode.
// each box is RING wider, so that with bg each candidate's ring() is decoded
// too
static void wins(s2 *j) {
  band *f = j->bd;
  int mc = j->mc, *idx = j->idx, *par = j->par, X0 = j->X0, Y0 = j->Y0;
  int W = j->W, H = j->H, *bb = mem((size_t)mc * 16), nw = 0, cap = 0;
  win *wn = NULL;
  for (int k = 0; k < mc; k++)
    bb[4 * k] = bb[4 * k + 1] = INT32_MAX, bb[4 * k + 2] = bb[4 * k + 3] = -1;
  for (int k = 0; k < mc; k++) {
    int *b = bb + 4 * find(par, k), gx = X0 + idx[k] % W, gy = Y0 + idx[k] / W;
    if (!j->sel[k]) continue;
    b[0] = MIN(b[0], MAX(gx - RING, X0));
    b[1] = MIN(b[1], MAX(gy - RING, Y0));
    b[2] = MAX(b[2], MIN(gx + RING + 1, X0 + W));
    b[3] = MAX(b[3], MIN(gy + RING + 1, Y0 + H));
  }
  for (int l = 0; l < mc; l++) {
    int *b = bb + 4 * l;
    if (b[2] < 0) continue;
    for (int ty = b[1] / f->th; ty <= (b[3] - 1) / f->th; ty++)
      for (int tx = b[0] / f->tw; tx <= (b[2] - 1) / f->tw; tx++) {
        if (nw == cap) wn = remem(wn, (cap = 2 * cap + 16) * sizeof *wn);
        wn[nw++] = (win){ty * f->nx + tx, MAX(b[0], tx * f->tw),
                         MAX(b[1], ty * f->th), MIN(b[2], tx * f->tw + f->tw),
                         MIN(b[3], ty * f->th + f->th)};
      }
  }
  unmem(bb);
  for (int i = 0; i < nw; i++)
    for (int k = i + 1; k < nw; k++) {
      win *a = &wn[i], *b = &wn[k];
      win v = {a->k, MIN(a->x0, b->x0), MIN(a->y0, b->y0), MAX(a->x1, b->x1),
               MAX(a->y1, b->y1)};
      if (a->k != b->k || area(&v) > area(a) + area(b) + FIXED) continue;
      *a = v, wn[k] = wn[--nw], k = i;   // and look again from i
    }
  unmem(j->wn), j->wn = wn, j->nw = nw;
}

#define V(k) cal(j->v12[k])

// stage 2, after b12's decodes: the screen, then components of the
// candidates; only those holding a possible peak need b11. a component can
// hold a detection only if one pixel is both a possible peak and bright in
// b11, and b8a then decides those of its pixels that saturation does not,
// and how hot its peak is
static const char *back(s2 *j) {
  forget(j->io, j->u[0]);
  if (!screen(j)) return FIN;
  int mc = j->mc, *idx = j->idx, W = j->W, *par;
  par = j->par = mem(mc * 4), j->ok = mem(mc), j->sel = mem(mc);
  j->v12 = mem(mc * 2), j->v11 = mem(mc * 2), j->v8a = mem(mc * 2);
  j->g8a = mem(mc * 2), j->g12 = mem(mc * 2);
  for (int k = 0; k < mc; k++) j->v12[k] = j->b12[idx[k]];
  for (int k = 0; k < mc; k++) {
    int i = idx[k], n;
    par[k] = k;
    if (i % W && k && idx[k - 1] == i - 1) par[find(par, k)] = find(par, k - 1);
    if (i >= W && (n = at(idx, k, i - W)) >= 0)
      par[find(par, k)] = find(par, n);
  }
  for (int k = 0; k < mc; k++)
    if (V(k) >= j->t[PEAKMIN]) j->ok[find(par, k)] = 1;
  for (int k = 0; k < mc; k++)
    if ((j->sel[k] = j->ok[find(par, k)]))
      j->g12[k] = ring(j->b12, idx, mc, k, W, j->H);
  return wins(j), NULL;
}

// stage 3: b11's reads and decodes, into the b12 raster, whose values are
// kept where they are wanted. b8a's reads over the same windows come with
// them: its own windows, a subset, need the same packets (measured on 13SFR,
// to the byte), so this saves a round trip for nothing
static const char *b11(s2 *j) {
  band *f = j->bd, *g = j->bd + 1, *h = j->bd + 2;
  const char *e = j->nw ? header(j, j->u[1], g) : NULL;
  if (!e && j->nw && !grid(g, f)) e = "bands on different grids";
  if (!e && j->nw) e = parts(j, j->u[1], g, j->wn, j->nw);
  if (j->nw && !header(j, j->u[2], h) && grid(h, f))
    parts(j, j->u[2], h, j->wn, j->nw);
  return e ? e : decs(j, j->u[1], 1, j->wn, j->nw, j->b12);
}

// stage 4: b11 at the candidates, those still selected, and b8a's windows
static const char *pick(s2 *j) {
  int mc = j->mc;
  forget(j->io, j->u[1]);
  for (int k = 0; k < mc; k++)
    if (j->sel[k]) j->v11[k] = j->b12[j->idx[k]];
  memset(j->ok, 0, mc);
  for (int k = 0; k < mc; k++)
    if (j->sel[k] && V(k) >= j->t[PEAKMIN] && cal(j->v11[k]) > j->t[B11MIN])
      j->ok[find(j->par, k)] = 1;
  for (int k = 0; k < mc; k++)
    j->sel[k] = j->sel[k] && j->ok[find(j->par, k)] &&
                cal(j->v11[k]) > j->t[B11MIN];
  return wins(j), NULL;
}

// stage 5: b8a's reads and decodes
static const char *b8a(s2 *j) {
  band *f = j->bd, *h = j->bd + 2;
  const char *e = j->nw ? header(j, j->u[2], h) : NULL;
  if (!e && j->nw && !grid(h, f)) e = "bands on different grids";
  if (!e && j->nw) e = parts(j, j->u[2], h, j->wn, j->nw);
  return e ? e : decs(j, j->u[2], 2, j->wn, j->nw, j->b12);
}

// stage 6: b8a at the candidates and around them; the spectral mask, its
// components, and per component the count, the sum and the lowest-index
// peak; the detections
static const char *dets(s2 *j) {
  int mc = j->mc, *idx = j->idx, *par = j->par, W = j->W, H = j->H;
  int X0 = j->X0, Y0 = j->Y0, *n_ = mem(mc * 4), *pk = mem(mc * 4);
  int *pq = mem(mc * 4);
  const double *t = j->t;
  double *sum = mem(mc * 8);
  char *ok = j->ok, *vis = mem(mc);
  band *f = j->bd;
  res *r = &j->r;
  for (int k = 0; k < mc; k++)
    if (j->sel[k])
      j->v8a[k] = j->b12[idx[k]], j->g8a[k] = ring(j->b12, idx, mc, k, W, H);
  for (int k = 0; k < mc; k++) {
    double a = cal(j->v11[k]), c = cal(j->v8a[k]);
    ok[k] = j->sel[k] &&
            (a > t[SAT] || V(k) > t[SAT] || (a + c > .01 && a > c));
  }
  for (int k = 0; k < mc; k++) {
    int i = idx[k], n;
    par[k] = k;
    if (!ok[k]) continue;
    if (i % W && k && idx[k - 1] == i - 1 && ok[k - 1])
      par[find(par, k)] = find(par, k - 1);
    if (i >= W && (n = at(idx, k, i - W)) >= 0 && ok[n])
      par[find(par, k)] = find(par, n);
  }
  for (int k = 0; k < mc; k++) {
    if (!ok[k]) continue;
    int l = find(par, k);
    if (!n_[l]++ || V(k) > V(pk[l])) pk[l] = k;
    sum[l] += V(k);
  }
  for (int l = 0; l < mc; l++) {
    if (!n_[l]) continue;
    double np = n_[l], p = V(pk[l]), avg = sum[l] / np;
    if (np > t[MAXPX] || p < t[PEAKMIN]) continue;
    if (np > t[LARGEPX] && p < t[LARGEMIN]) continue;
    if (n_[l] > 1 && p < t[PEAKED] * avg && avg < t[SAT]) continue;
    if (n_[l] == 1 && p < t[SINGLE]) continue;
    // heat, not light: the peak's rise in b8a over its surroundings at
    // their brightest is under nir_excess of its rise in b12. a fire
    // barely lifts b8a (3% of b12 at 1800 K, in reflectance); sunlight off
    // a roof, glass or a car lifts all three bands alike. a solar panel,
    // whose silicon absorbs b8a, passes
    if (cal(j->v8a[pk[l]]) - cal(j->g8a[pk[l]]) >=
        t[NIR] * (p - cal(j->g12[pk[l]])))
      continue;
    // the hot core: contiguous from the peak within this component, above
    // max(peak·warm_fraction, hot_floor), capped at warm_max_pixels
    // and its integrated excess radiance, Σ(b12 − the cell's background)
    int pi = idx[pk[l]], hd = 0, tl = 1, size = 0;
    double th = p * t[WARMF] > t[HOT] ? p * t[WARMF] : t[HOT], rad = 0;
    double bg = j->bgm[((Y0 + pi / W) / CELL - j->gy0) * j->ncx +
                       (X0 + pi % W) / CELL - j->gx0];
    vis[pq[0] = pk[l]] = 1;
    while (hd < tl) {
      int k = pq[hd++], i = idx[k], nb4[4], c = 0;
      size++, rad += V(k) > bg ? V(k) - bg : 0;
      if (size > t[WARMMAX]) break;
      if (i >= W) nb4[c++] = at(idx, mc, i - W);
      if (i + W < W * H) nb4[c++] = at(idx, mc, i + W);
      if (i % W) nb4[c++] = k > 0 && idx[k - 1] == i - 1 ? k - 1 : -1;
      if ((i + 1) % W) nb4[c++] = k + 1 < mc && idx[k + 1] == i + 1 ? k + 1
                                                                    : -1;
      for (int z = 0; z < c; z++) {
        int q = nb4[z];
        if (q >= 0 && !vis[q] && ok[q] && find(par, q) == l && V(q) > th)
          vis[pq[tl++] = q] = 1;
      }
    }
    for (int z = 0; z < tl; z++) vis[pq[z]] = 0;
    if (size > t[WARMMAX]) continue;
    double a = cal(j->v11[pk[l]]);
    int *pp = malloc(tl * 2 * sizeof *pp);
    for (int z = 0, i; z < tl; z++)
      i = idx[pq[z]], pp[2 * z + 1] = j->v12[pq[z]],
      pp[2 * z] = (Y0 + i / W) << 16 | (X0 + i % W);
    if (r->nd == r->cap) r->d = realloc(r->d, (r->cap = 2 * r->cap + 8) *
                                                  sizeof *r->d);
    r->d[r->nd++] = (det){f->ox + (X0 + pi % W + .5) * f->res,
                          f->oy - (Y0 + pi / W + .5) * f->res, p, avg, a,
                          a > 1e-6 ? p / a : INFINITY, p / avg, rad, size,
                          p >= t[SAT], pp};
  }
  unmem(n_), unmem(pk), unmem(pq), unmem(sum), unmem(vis);
  return NULL;
}

static const char *(*const stage[])(s2 *) = {heads, b12, back, b11, pick,
                                             b8a, dets};

// a job over a box of b12's url. eodata
// allows 5000 requests a minute for each key, and in region a request costs
// more than a MB: its tile-parts are read whole, joined within a MB, at most
// 20 reads to a band (without a TLM, the whole codestream once a quarter of
// its tile-parts are wanted). elsewhere a request costs its round trip
static void start(s2 *j, const char *url, const double *box,
                  const double *t) {
  j->u[0] = url;
  j->u[1] = swap(url, "B12.jp2", "B11.jp2");
  j->u[2] = swap(url, "B12.jp2", "B8A.jp2");
  j->u[3] = swap(url, "/IMG_DATA/", "/QI_DATA/MSK_CLASSI_B00.jp2");
  memcpy(j->box, box, sizeof j->box);
  memcpy(j->t, t, sizeof j->t);
  j->budget = strncmp(url, "s3://", 5) ? 0 : 20;
  j->io->gap = j->budget ? 1 << 20 : GAP, j->r.clear = NAN;
}

typedef struct {
  double box[4], th[NT], org[3];
  res r;
} s2_row;

static void s2_work(row *w, job *io) {
  if (w->e) return;
  s2_row *r = w->data;
  s2 j = {.io = io};
  start(&j, w->url, r->box, r->th);
  for (size_t st = 0; !j.e && st < sizeof stage / sizeof *stage;) {
    const char *e = stage[st](&j);
    if (e == LACK) { read_round(io); continue; }
    if (e == FIN) break;
    if (e) { j.e = e; break; }
    for (int i = 0; i < j.nq && !j.e; i++) j.e = dodec(&j, &j.dq[i]);
    j.nq = 0;
    st++;
  }
  w->e = j.e, r->r = j.r;
  r->org[0] = j.bd->ox, r->org[1] = j.bd->oy, r->org[2] = j.bd->res;
}

static void s2_detect(duckdb_function_info info, duckdb_data_chunk in,
                      duckdb_vector out) {
  idx_t n = duckdb_data_chunk_get_size(in), cols =
    duckdb_data_chunk_get_column_count(in), total = 0;
  duckdb_vector v[6];
  row *rs = calloc(n ? n : 1, sizeof *rs);
  s2_row *xs = calloc(n ? n : 1, sizeof *xs);
  (void)info;
  for (idx_t k = 0; k < cols; k++) v[k] = duckdb_data_chunk_get_vector(in, k);
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    s2_row *r = &xs[i];
    int null = 0;
    for (idx_t k = 0; k < 5; k++) null |= !valid(v[k], i);
    if (null) continue;
    w->url = str(v[0], i), w->data = r, w->work = s2_work;
    for (int k = 0; k < 4; k++)
      r->box[k] = ((double *)duckdb_vector_get_data(v[k + 1]))[i];
    memcpy(r->th, TD, sizeof r->th);
    if (cols > 5 && valid(v[5], i)) {
      char *p = str(v[5], i);
      w->e = params(p, r->th, TK, NT);
      free(p);
    }
    if (!w->e) w->e = thresholds(r->th);
    for (int k = 0; k < 4; k++)
      if (!isfinite(r->box[k])) w->e = "nonfinite box";
    if (!w->e && (r->box[2] <= r->box[0] || r->box[3] <= r->box[1]))
      w->e = "empty box";
  }
  run(rs, n);

  // clear, error and the hotspots list; a null input row is a null result
  duckdb_vector vc = duckdb_struct_vector_get_child(out, 0),
                ve = duckdb_struct_vector_get_child(out, 1),
                vl = duckdb_struct_vector_get_child(out, 2),
                vq = duckdb_struct_vector_get_child(out, 3);
  duckdb_vector_ensure_validity_writable(out);
  duckdb_vector_ensure_validity_writable(vc);
  duckdb_vector_ensure_validity_writable(ve);
  duckdb_vector_ensure_validity_writable(vl);
  duckdb_vector_ensure_validity_writable(vq);
  uint64_t *mo = duckdb_vector_get_validity(out),
           *mc = duckdb_vector_get_validity(vc),
           *me = duckdb_vector_get_validity(ve),
           *ml = duckdb_vector_get_validity(vl),
           *mq = duckdb_vector_get_validity(vq);
  idx_t tq = 0, oq = 0;
  for (idx_t i = 0; i < n; i++) tq += rs[i].e ? 0 : xs[i].r.nq;
  duckdb_list_vector_reserve(vq, tq);
  duckdb_list_vector_set_size(vq, tq);
  duckdb_list_entry *lq = duckdb_vector_get_data(vq);
  double *dq[3];
  for (int k = 0; k < 3; k++)
    dq[k] = duckdb_vector_get_data(duckdb_struct_vector_get_child(
      duckdb_list_vector_get_child(vq), k));
  for (idx_t i = 0; i < n; i++) total += rs[i].e ? 0 : xs[i].r.nd;
  duckdb_list_vector_reserve(vl, total);
  duckdb_list_vector_set_size(vl, total);
  duckdb_vector f = duckdb_list_vector_get_child(vl), fc[11];
  for (int k = 0; k < 11; k++) fc[k] = duckdb_struct_vector_get_child(f, k);
  // each hotspot's pixels: their centres, in the box's metres, and b12
  idx_t tp = 0, op = 0;
  for (idx_t i = 0; i < n; i++)
    for (int j = 0; !rs[i].e && j < xs[i].r.nd; j++) tp += xs[i].r.d[j].px;
  duckdb_list_vector_reserve(fc[10], tp);
  duckdb_list_vector_set_size(fc[10], tp);
  duckdb_list_entry *lp = duckdb_vector_get_data(fc[10]);
  double *dp[3];
  for (int k = 0; k < 3; k++)
    dp[k] = duckdb_vector_get_data(duckdb_struct_vector_get_child(
      duckdb_list_vector_get_child(fc[10]), k));
  duckdb_list_entry *le = duckdb_vector_get_data(vl);
  double *clear = duckdb_vector_get_data(vc), *d[8];
  int *px = duckdb_vector_get_data(fc[7]);
  bool *sat = duckdb_vector_get_data(fc[9]);
  int dk[8] = {0, 1, 2, 3, 4, 5, 6, 8};
  for (int k = 0; k < 8; k++) d[k] = duckdb_vector_get_data(fc[dk[k]]);
  idx_t o = 0;
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    s2_row *r = &xs[i];
    le[i] = (duckdb_list_entry){o, 0}, lq[i] = (duckdb_list_entry){oq, 0};
    if (!w->url) {   // its fields null too: duckdb reads a field alone
      uint64_t *ms[] = {mo, mc, me, ml, mq};
      for (int k = 0; k < 5; k++) duckdb_validity_set_row_invalid(ms[k], i);
      continue;
    }
    if (isnan(r->r.clear)) duckdb_validity_set_row_invalid(mc, i);
    else clear[i] = r->r.clear;
    if (w->e) duckdb_vector_assign_string_element(ve, i, w->e);
    else duckdb_validity_set_row_invalid(me, i);
    if (w->e) duckdb_validity_set_row_invalid(ml, i),
              duckdb_validity_set_row_invalid(mq, i);
    for (int j = 0; !w->e && j < r->r.nq; j++, oq++) {
      sq *q = &r->r.q[j];
      dq[0][oq] = q->x, dq[1][oq] = q->y, dq[2][oq] = q->cloud;
    }
    lq[i].length = oq - lq[i].offset;
    for (int j = 0; !w->e && j < r->r.nd; j++, o++) {
      det *x = &r->r.d[j];
      double vals[8] = {x->x, x->y, x->max, x->avg, x->b11, x->ratio, x->pk,
                        x->rad};
      for (int k = 0; k < 8; k++) d[k][o] = vals[k];
      px[o] = x->px, sat[o] = x->sat, lp[o] = (duckdb_list_entry){op, x->px};
      for (int k = 0; k < x->px; k++, op++)
        dp[0][op] = r->org[0] + ((x->pp[2 * k] & 65535) + .5) * r->org[2],
        dp[1][op] = r->org[1] - ((x->pp[2 * k] >> 16) + .5) * r->org[2],
        dp[2][op] = cal(x->pp[2 * k + 1]);
    }
    le[i].length = o - le[i].offset;
    for (int j = 0; j < r->r.nd; j++) free(r->r.d[j].pp);
    free(w->url), free(r->r.d), free(r->r.q);
  }
  free(rs), free(xs);
}

// the default source: eodata when its key is set, else google's mirror
static void s2_source(duckdb_function_info info, duckdb_data_chunk in,
                      duckdb_vector out) {
  const char *s = getenv("AWS_ACCESS_KEY_ID") ? "eodata" : "gcp";
  for (idx_t i = 0, n = duckdb_data_chunk_get_size(in); i < n; i++)
    duckdb_vector_assign_string_element(out, i, s);
}

duckdb_state s2_register(duckdb_connection con) {
  j2k_spread = spread;
  const char *fn[] = {"x", "y", "max_b12", "avg_b12", "peak_b11", "ratio",
                      "peakedness", "pixels", "radiance", "saturated", "px"};
  const char *sn[] = {"clear", "error", "hotspots", "cells"},
             *qn[] = {"x", "y", "cloud"}, *pn[] = {"x", "y", "b12"};
  duckdb_logical_type ft[11], st[4], qt[3], dbl = type(DUCKDB_TYPE_DOUBLE),
                      vc = type(DUCKDB_TYPE_VARCHAR);
  for (int k = 0; k < 10; k++)
    ft[k] = type(k == 7 ? DUCKDB_TYPE_INTEGER
                 : k == 9 ? DUCKDB_TYPE_BOOLEAN : DUCKDB_TYPE_DOUBLE);
  for (int k = 0; k < 3; k++) qt[k] = dbl;
  duckdb_logical_type qs = duckdb_create_struct_type(qt, qn, 3),
                      ps = duckdb_create_struct_type(qt, pn, 3);
  ft[10] = duckdb_create_list_type(ps);
  duckdb_logical_type fs = duckdb_create_struct_type(ft, fn, 11);
  st[0] = dbl, st[1] = vc, st[2] = duckdb_create_list_type(fs);
  st[3] = duckdb_create_list_type(qs);
  duckdb_logical_type ret = duckdb_create_struct_type(st, sn, 4);
  duckdb_scalar_function_set set = duckdb_create_scalar_function_set(
    "s2_detect");
  for (int extra = 0; extra < 2; extra++) {
    duckdb_scalar_function f = duckdb_create_scalar_function();
    duckdb_scalar_function_set_name(f, "s2_detect");
    duckdb_scalar_function_add_parameter(f, vc);
    for (int k = 0; k < 4; k++) duckdb_scalar_function_add_parameter(f, dbl);
    if (extra) duckdb_scalar_function_add_parameter(f, vc);
    duckdb_scalar_function_set_return_type(f, ret);
    duckdb_scalar_function_set_special_handling(f);   // nulls are ours
    duckdb_scalar_function_set_volatile(f);   // one evaluation per row
    duckdb_scalar_function_set_function(f, s2_detect);
    duckdb_add_scalar_function_to_set(set, f);
    duckdb_destroy_scalar_function(&f);
  }
  duckdb_state ok = duckdb_register_scalar_function_set(con, set);
  duckdb_destroy_scalar_function_set(&set);
  for (int k = 0; k < 11; k++) duckdb_destroy_logical_type(&ft[k]);
  duckdb_destroy_logical_type(&fs), duckdb_destroy_logical_type(&st[2]);
  duckdb_destroy_logical_type(&qs), duckdb_destroy_logical_type(&st[3]);
  duckdb_destroy_logical_type(&ps);
  duckdb_destroy_logical_type(&ret), duckdb_destroy_logical_type(&dbl);
  duckdb_scalar_function f = duckdb_create_scalar_function();
  duckdb_scalar_function_set_name(f, "s2_source");
  duckdb_scalar_function_set_return_type(f, vc);
  duckdb_scalar_function_set_function(f, s2_source);
  if (ok == DuckDBSuccess) ok = duckdb_register_scalar_function(con, f);
  duckdb_destroy_scalar_function(&f);
  duckdb_destroy_logical_type(&vc);
  return ok;
}
