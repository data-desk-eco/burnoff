// band: one band file of a sentinel-2 l1c scene (a jp2) over byte-range
// reads, for s2.c: its header, where its tile-parts lie (a TLM, or a
// search that learns), and the reads that decoding windows of it needs.
// it names reads on a job (burnoff.h) and parses with j2k.c; headers,
// masks and layouts are shared between jobs in the caches here.
#define NP 64      // packets a tile-part may hold: 40 in a 640 px tile
// reads closer than this are one: a request costs about as much
#define GAP (32 << 10)
// a band's tile-parts are read whole, not their PLTs and then the packets
// wanted, while they come to this or less: a round saved for more bytes (a
// site's b12 needs 52% of a tile-part, b11's and b8a's 19%)
#define WHOLE (1 << 20)

typedef struct { int k, x0, y0, x1, y1; } win;   // [x0,x1)×[y0,y1) of tile k

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
  buf s;                       // its header, as read or recalled
} band;

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
static const char *header(job *io, const char *url, band *f) {
  char key[64];
  const char *fn = strrchr(url, '/') ? strrchr(url, '/') + 1 : url;
  const char *bd = strrchr(fn, '_'), *nb = strstr(url, "_N");
  buf *b = &f->s;
  long long size = -1, lo = 0, hi = 16384;
  int own = 0, got_ = 0, n = 0;   // b is this file's own
  unsigned char *s, *sot, *q;
  if (f->ok) return NULL;
  snprintf(key, sizeof key, "%.6s%.12s%.6s", fn, bd ? bd : "", nb ? nb : "");
again:
  if (!recall(own ? url : key, b, &size)) {
    rd *r = got(io, url, lo, hi), *z = r && r->b.size < 0
                                       ? got(io, url, 0, -2) : r;
    if (!r) return want(io, url, lo, hi);
    if (!z) return want(io, url, 0, -2);   // no Content-Range (file://)
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
  else if (n && !got(io, url, 0, b->n)) {   // cached: tile 0's PLT is in it
    rd *r = add(io, url, 0, b->n);
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
static int pk(job *io, const char *url, band *f, int k, long long *o,
              uint32_t *l) {
  long long a = f->at[k], s = f->len[k];
  rd *r = got(io, url, a, a + s);
  uint32_t off[NP];
  size_t len;
  int t, n = j2k_need(&f->j, k, 0, 0, 0, 0, NULL);
  if (!r && !(r = got(io, url, a, a + (s = MIN(s, 512))))) return 0;
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
static const char *scan(job *io, const char *url, band *f) {
  for (rd *r = io->rq; r < io->rq + io->nr; r++) {
    if (r->sc || strcmp(r->url, url) || !(r->ok || r->e == PAST)) continue;
    r->sc = 1, f->size = r->b.size > 0 ? r->b.size : f->size;
    if (r->e) return want(io, url, 0, 1);
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
static const char *parts(job *io, int budget, const char *url, band *f,
                         const win *w, int n) {
  uint64_t m[256] = {0};
  long long o[NP], *q, a, b, z = 0;
  uint32_t l[NP];
  int c, nq = 0, miss = 0, look = 0;
  size_t qc = (size_t)NP * f->nt;
  const char *e = f->tlm ? NULL : scan(io, url, f);
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
    z += m[k] && f->tlm && f->at[k] && !pk(io, url, f, k, o, l) ? f->len[k] : 0;
  q = mem(16 * qc);
  for (int k = 0; k < f->nt; k++) {
    if (!m[k] || ((a = f->at[k]) && got(io, url, a, b = a + f->len[k])))
      continue;
    if (miss++, !a) { seek(f, &L, k, q + 2 * nq++), look = 1; continue; }
    need(f, k, 0, 0, f->w, f->h_, &c);
    int np = !f->tlm || budget || m[k] == (c < 64 ? (1ull << c) - 1 : ~0ull)
           ? -2 : pk(io, url, f, k, o, l);
    if (np == -1 || np > 0 ? np != c : 0)
      return unmem(q), "malformed tile-part header";
    if (!np && z <= WHOLE) np = -2;
    if (np < 0) q[2 * nq] = a, q[2 * nq++ + 1] = b;
    else if (!np) q[2 * nq] = a, q[2 * nq++ + 1] = a + MIN(f->len[k], 512);
    else for (int i = 0; i < np; i++)
      if (m[k] >> i & 1 && !got(io, url, o[i], o[i] + l[i]))
        q[2 * nq] = o[i], q[2 * nq++ + 1] = o[i] + l[i];
  }
  // without a TLM and much of the band wanted: the whole codestream
  if (!f->tlm && budget && miss > f->nt / 4)
    q[0] = f->first, q[1] = -1, nq = 1;
  else nq = merge(q, nq, io->gap, budget);
  if (look && ++f->round > 12) e = "tile-part not found";
  for (int i = 0; i < nq && (!e || e == LACK); i++)
    e = want(io, url, q[2 * i], q[2 * i + 1]);
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
