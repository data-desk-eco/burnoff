// sentinel-3 slstr's hotspots by night, straight off eodata's l1b (RBT)
// granules, for burnoff.c's host:
//   s3_detect(dir VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE
//             [, thresholds VARCHAR])
//   → STRUCT(sza DOUBLE, clear DOUBLE, error VARCHAR, hotspots STRUCT(lon,
//            lat, pixels, s5, s6, temperature, rh, confirmed, saturated)[],
//            squares STRUCT(lon, lat, pixels, clear)[])
// dir is a granule's .SEN3 directory, the box lon/lat degrees.
//
// the method is caseiro et al.'s (remote sens. 2018, 10:1118; essd 2020,
// 12:2137). by night only heat lights the swir. in each band a pixel is hot
// above the band's threshold: the lowest multiple of its step above the
// background that no pixel takes. S5's (1.61 µm, 500 m) hot pixels,
// 8-connected, are the hotspots; one is confirmed (their high accuracy
// class) when S6 (2.25 µm) or the mid-infrared, S7 or F1 (3.74 µm, 1 km),
// is hot under it too. its temperature is planck's through S5 and S6,
// over the background two pixels around it, and outside 500-5000 K it is
// spurious and dropped.
//
// why it is cheap: a granule is ~350 MB of netcdf-4 (hdf5) files, each
// variable deflated in a few chunks of up to 1201 by 1500. a job reads the
// heads of seven of them (24 KB each: the object headers and most chunk
// indices), the tie-point grid (1.7 MB, 16 km by 1 km), which puts the box
// in the image, then S5's chunks under it with their exception flags and
// the cloud mask; only if S5 holds a hot pixel, S6's and the hot pixels'
// geolocation, and S7's and F1's only for a hotspot S6 does not confirm.
// the thresholds are over the chunks read, a quarter of the granule or
// more, not over all of it. a small box takes four rounds: 3.8 MB of a
// night with nothing in it, 6-8 MB with a flare.
#include <zlib.h>

static const char *TK3[] = {"s5_gain", "s6_gain", "sza_min", "cloud_bits",
  "t_min", "t_max", "exact", "square"};
static const double TD3[] = {.89, .80, 90, 0x3fc0, 500, 5000, 1, .02};
enum { G5, G6, SZAMIN, CBITS, TMIN, TMAX, EXACT, SQ, NT3 };

// a file's head: superblock, object headers, heaps. geodetic_an's links lie
// past 27 KB, so 24 KB took a second round on every granule
static const int HEAD3[] = {24576, 24576, 24576, 24576, 24576, 24576, 40960};
#define TREE3 2616    // a v1 b-tree node of chunks, 2-d, k = 32
#define MARGIN 4      // the background's 2 pixels and the bands' offsets
#define APIX 2.5e5    // a pixel's m², the image grid's 500 m on the ground

// the granule's files, and the variables read from each
static const char *F3[] = {"geodetic_tx", "S5_radiance_an", "S6_radiance_an",
  "F1_BT_fn", "S7_BT_in", "flags_an", "geodetic_an"};
static const char *V3[] = {"latitude_tx", "longitude_tx", "S5_radiance_an",
  "S5_exception_an", "S6_radiance_an", "F1_BT_fn", "S7_BT_in", "cloud_an",
  "latitude_an", "longitude_an"};
static const int FV[] = {0, 0, 1, 1, 2, 3, 4, 5, 6, 6};
enum { LAT, LON, S5, X5, S6, F1, S7, CLD, LA5, LO5, NV, NF = 7 };

static long long le(const unsigned char *p, int n) {
  unsigned long long v = 0;
  while (n--) v = v << 8 | p[n];
  return v;
}

// an ieee float of n bytes at p, aligned or not
static double real(const unsigned char *p, int n) {
  double d;
  float f;
  return n == 8 ? memcpy(&d, p, 8), d : (memcpy(&f, p, 4), f);
}

// a flag raster's value, 0 where there is none
static int flag(float v) { return isnan(v) ? 0 : (int)v; }

// a netcdf-4 variable: shape, chunks, element type and packing, and each
// chunk's place in the file and origin in the array
typedef struct {
  long long bt, hp;
  int h, w, ch, cw, es, sg, fl, sh, nk, ok;
  double sc, of, fill;
  long long ka[64];
  int kn[64], kr[64], kc[64];
} var;

// one hotspot: its place, swir excess radiances summed, planck's
// temperature (K) and radiant heat (MW), and pixels
typedef struct {
  double lon, lat, s5, s6, temp, rh;
  int px, conf, sat;
} h3;

// a job's own: the granule, its variables, its grids' columns from the
// sub-satellite track, the window (in the 500 m grid, and each raster's
// own: rows, columns, origin), the bands' thresholds in dn, the hotspots
typedef struct sj {
  char *dir, *u[NF];
  double box[4], t[NT3], sza, clear, s;
  var v[NV];
  long long hn[NF];
  int to[NF], H, W, r0, r1, c0, c1, nc;
  int wr[NV], wc[NV], wh[NV], ww[NV];
  long th[NV];
  unsigned long long km[NV];   // the chunks wanted, if not all
  double *ll[2];
  float *b[NV];
  unsigned *hist[NV];
  int *cd, *at, *mb;   // candidates, and as clusters (s3clus)
  char *ok;            // each cluster confirmed in S6
  h3 *d;
  int nd, cap, in;
  int keep;            // another box of the granule follows: drop no file
  // the box's squares, `square` degrees on a grid from 0°, 0°: from the
  // square (qx, qy) at the box's south-west, qw by qh, each one's pixels
  // (qn) and the clear among them (qc), as `clear` counts the box's
  int *qn, *qc, qw, qh;
  long qx, qy;
} sj;

// a pixel at lon, lat into its square, clear or not; none past the grid
static void square(sj *x, double lon, double lat, int ok) {
  double q = x->t[SQ];
  long w = lround(360 / q), dx = ((long)floor(lon / q) - x->qx) % w,
       dy = (long)floor(lat / q) - x->qy;
  if (dx < 0) dx += w;
  if (!x->qn || dx >= x->qw || dy < 0 || dy >= x->qh) return;
  x->qn[dy * x->qw + dx]++, x->qc[dy * x->qw + dx] += ok;
}

// file f done with, unless another box of the granule will read it again
static void drop3(job *j, int f) {
  if (!j->x->keep) forget(j, j->x->u[f]);
}

// an attribute message's value, if it is named nm: v1 pads its parts to 8
// bytes, v2 does not, v3 adds an encoding byte
static int attr(const unsigned char *a, const unsigned char *end,
                const char *nm, double *x) {
  int v = a[0], ns = le(a + 2, 2), ts = le(a + 4, 2), ss = le(a + 6, 2);
  const unsigned char *p = a + (v == 3 ? 9 : 8), *t, *s, *d;
#define PAD(n) (v == 1 ? ((n) + 7) & ~7 : (n))
  if (v < 1 || v > 3 || p + ns > end || strlen(nm) + 1 != (size_t)ns ||
      memcmp(p, nm, ns))
    return 0;
  t = p + PAD(ns), s = t + PAD(ts), d = s + PAD(ss);
#undef PAD
  if (t + 8 > end) return 0;
  int c = t[0] & 15, sz = le(t + 4, 4);
  if (d + sz > end || c > 1 || sz > 8) return 0;
  if (c) *x = real(d, sz);
  else {
    long long u = le(d, sz);
    *x = t[1] & 8 && sz < 8 && u >> (8 * sz - 1) ? u - (1ll << 8 * sz) : u;
  }
  return 1;
}

// a global attribute, wherever the head holds it (netcdf keeps them dense,
// in a fractal heap): its name, null-terminated, as a message frames it
static int gattr(const unsigned char *p, size_t n, const char *nm, double *x) {
  size_t l = strlen(nm) + 1;
  for (size_t i = 9; i + l < n; i++)
    if (!memcmp(p + i, nm, l) &&
        ((p[i - 9] == 3 && attr(p + i - 9, p + n, nm, x)) ||
         (p[i - 8] < 3 && attr(p + i - 8, p + n, nm, x))))
      return 1;
  return 0;
}

// an attribute message's packing of v, if it is one
static void pack(const unsigned char *d, const unsigned char *e, var *v) {
  if (!attr(d, e, "scale_factor", &v->sc) &&
      !attr(d, e, "add_offset", &v->of))
    attr(d, e, "_FillValue", &v->fill);
}

// one message of a variable's object header
static const char *msg(int t, const unsigned char *d, const unsigned char *e,
                       var *v) {
  if (t == 1) {   // dataspace
    int k = d[0] == 1 ? 8 : 4;
    if (d[1] != 2) return "not a 2-d variable";
    v->h = le(d + k, 8), v->w = le(d + k + 8, 8);
  } else if (t == 3) {   // datatype
    v->fl = (d[0] & 15) == 1, v->sg = d[1] & 8, v->es = le(d + 4, 4);
    if ((d[0] & 15) > 1 || v->es > 8) return "not a number";
  } else if (t == 8) {   // layout: v3, chunked, a v1 b-tree
    if (d[0] != 3 || d[1] != 2 || d[2] != 3) return "not chunked";
    v->bt = le(d + 3, 8), v->ch = le(d + 11, 4), v->cw = le(d + 15, 4);
  } else if (t == 11) {   // filters: shuffle and deflate alone
    int ver = d[0], o = ver == 1 ? 8 : 2;
    for (int f = 0; f < d[1]; f++) {
      int id = le(d + o, 2), nm = ver == 1 || id >= 256,
          nl = nm ? le(d + o + 2, 2) : 0, nv = le(d + o + (nm ? 6 : 4), 2);
      o += ver == 1 ? 8 + ((nl + 7) & ~7) + ((4 * nv + 7) & ~7)
                    : (nm ? 8 : 6) + nl + 4 * nv;
      if (id == 2) v->sh = 1;
      else if (id != 1) return "an unknown filter";
    }
  } else if (t == 12) pack(d, e, v);
  else if (t == 21) v->hp = le(d + 2 + (d[1] & 1 ? 2 : 0), 8);   // dense
  return NULL;
}

// variable nm from a head of n bytes: its hard link (netcdf's are compact,
// in the root group's header or, with many, its heap: the name's length,
// the name, the address; a head without it is read twice as far),
// then its object header (v2) and continuation blocks. 0, or the head's
// size it needs, or -1 with *e set
static long long h5var(const unsigned char *p, size_t n, const char *nm,
                       var *v, const char **e) {
  size_t l = strlen(nm);
  long long a = -1, q[16];
  int nq = 0;
  for (size_t i = 1, b; a < 0 && i + l + 8 <= n; i++)
    if (p[i - 1] == l && !memcmp(p + i, nm, l) &&
        (b = le(p + i + l, 8)) < (size_t)1 << 40 &&
        (b + 4 > n || !memcmp(p + b, "OHDR", 4)))
      a = b;
  if (a < 0 && n < 1 << 20) return 2 * n;   // the links lie further in
  if (a < 0) return *e = "variable not found", -1;
  if (a + 64 > (long long)n) return a + 4096;
  if (p[a + 4] != 2) return *e = "an hdf5 header older than v2", -1;
  int fl = p[a + 5], o = 6 + (fl & 32 ? 16 : 0) + (fl & 16 ? 4 : 0);
  q[0] = a + o + (1 << (fl & 3)), q[1] = q[0] + le(p + a + o, 1 << (fl & 3));
  *v = (var){.sc = 1, .fill = NAN}, nq = 2;
  for (int b = 0; b < nq; b += 2) {
    if (q[b + 1] + 4 > (long long)n) return q[b + 1] + 4096;
    for (long long k = q[b]; k + 4 <= q[b + 1];) {
      int t = p[k], s = le(p + k + 1, 2);
      k += 4 + (fl & 4 ? 2 : 0);
      if (k + s > q[b + 1]) break;
      if (t == 16 && nq < 16)   // a continuation: OCHK, messages, checksum
        q[nq] = le(p + k, 8) + 4, q[nq + 1] = q[nq] - 8 + le(p + k + 8, 8),
        nq += 2;
      if ((*e = msg(t, p + k, p + q[b + 1], v))) return -1;
      k += s;
    }
  }
  // more attributes than fit lie in a fractal heap of one direct block
  if (v->hp > 0) {   // all ones: none
    long long a = v->hp, r, z;
    if (a + 160 > (long long)n) return a + 4096;
    if (memcmp(p + a, "FRHP", 4) || le(p + a + 140, 2))
      return *e = "attributes in an indirect heap", -1;
    r = le(p + a + 132, 8), z = le(p + a + 112, 8);
    if (r + z > (long long)n) return r + z + 4096;
    for (long long i = r; i < r + z - 9; i++) pack(p + i, p + r + z, v);
  }
  if (!v->bt || !v->es) return *e = "variable not chunked", -1;
  return 0;
}

// a leaf of the chunk b-tree: each chunk's size, filter mask, origin, place
static const char *btree(const unsigned char *p, var *v) {
  if (memcmp(p, "TREE", 4) || p[4] != 1) return "not a chunk index";
  if (p[5]) return "a chunk index deeper than a leaf";
  if ((v->nk = le(p + 6, 2)) > 64) return "too many chunks";
  for (int i = 0, k = 24; i < v->nk; i++, k += 40) {
    if (le(p + k + 4, 4)) return "a chunk left unfiltered";
    v->kn[i] = le(p + k, 4), v->kr[i] = le(p + k + 8, 8);
    v->kc[i] = le(p + k + 16, 8), v->ka[i] = le(p + k + 32, 8);
  }
  return v->ok = 1, NULL;
}

// a chunk inflated and unshuffled, held while another box of the granule
// follows: boxes a few km apart share the chunks under them, and inflating
// them is most of a box's time once its reads are shared
typedef struct s3k {
  struct s3k *next;
  long long at;   // the chunk's place in its file
  int k;          // and its variable
  unsigned char *b;
  unsigned *h;    // its count of dn, for a band's threshold
  int counted;    // once h is made
} s3k;

static void s3kfree(job *j) {
  for (s3k *c = j->k3, *n; c; c = n)
    n = c->next, free(c->b), free(c->h), free(c);
  j->k3 = NULL;
}

// chunk i of v (variable k) from its bytes z into raster o (rows [r0, r1),
// columns [c0, c1)), unpacked, its fill NAN; and, with h, a count of the
// chunk's dn (as unsigned shorts), all of it, for the band's threshold
static const char *unchunk(job *j, int k, const var *v, int i,
                           const unsigned char *z, float *o, int r0, int r1,
                           int c0, int c1, unsigned *h) {
  uLongf n = (uLongf)v->ch * v->cw * v->es, m = n / v->es;
  const char *e = NULL;
  unsigned char *a = NULL, *b = NULL;
  s3k *held = j->k3;
  while (held && (held->k != k || held->at != v->ka[i])) held = held->next;
  if (held) b = held->b;
  else {
    a = malloc(n), b = v->sh ? malloc(n) : a;
    e = uncompress(a, &n, z, v->kn[i]) != Z_OK || n != m * v->es
        ? "a chunk did not inflate" : NULL;
    if (!e && v->sh)   // byte k of every element, then byte k + 1
      for (size_t q = 0; q < m; q++)
        for (int c = 0; c < v->es; c++) b[q * v->es + c] = a[c * m + q];
    if (!e && j->x->keep) {
      s3k *c = malloc(sizeof *c);
      *c = (s3k){j->k3, v->ka[i], k, b, h ? calloc(65536, sizeof *h) : NULL,
                 0};
      j->k3 = held = c;
      if (b != a) free(a);
      a = NULL;
    }
  }
  // a held chunk's count is made once: after it, only the window is read
  int whole = h && !(held && held->counted), rh = MIN(v->ch,
      v->h - v->kr[i]), cw = MIN(v->cw, v->w - v->kc[i]);
  unsigned *hc = held && held->h ? held->h : h;
  if (h && held && held->h && !whole)
    for (int q = 0; q < 65536; q++) h[q] += held->h[q];
  int ra = whole ? 0 : MAX(r0 - v->kr[i], 0), rb = whole ? rh
         : MIN(r1 - v->kr[i], rh), ca = whole ? 0 : MAX(c0 - v->kc[i], 0),
      cb = whole ? cw : MIN(c1 - v->kc[i], cw);
  for (int r = ra; !e && r < rb; r++)
    for (int c = ca; c < cb; c++) {
      const unsigned char *s = b + ((size_t)r * v->cw + c) * v->es;
      long long u = v->fl ? 0 : le(s, v->es);
      double x = v->fl ? real(s, v->es)
               : v->sg && v->es < 8 && u >> (8 * v->es - 1)
                 ? u - (1ll << 8 * v->es) : u;
      int y = r + v->kr[i], w = c + v->kc[i];
      if (whole && x != v->fill) hc[(unsigned short)u]++;
      if (y >= r0 && y < r1 && w >= c0 && w < c1)
        o[(size_t)(y - r0) * (c1 - c0) + w - c0] =
          x == v->fill ? NAN : x * v->sc + v->of;
    }
  if (whole && hc != h) {   // counted into the held chunk: then to h
    for (int q = 0; q < 65536; q++) h[q] += hc[q];
    held->counted = 1;
  }
  if (a) {   // not held
    if (b != a) free(b);
    free(a);
  }
  return e;
}

// v (variable k of file f) over rows [r0, r1) and columns [c0, c1) into
// its raster, clipped to v: LACK until the chunks under it, read as runs,
// are in hand
static const char *grab(job *j, int k, int r0, int r1, int c0, int c1) {
  sj *x = j->x;
  var *v = &x->v[k];
  const char *e = NULL, *u = x->u[FV[k]];
  long long q[128];
  int n = 0;
  r0 = MAX(r0, 0), r1 = MIN(r1, v->h), c0 = MAX(c0, 0), c1 = MIN(c1, v->w);
  if (r0 >= r1 || c0 >= c1) r1 = r0, c1 = c0;
#define UNDER(i) (v->kr[i] < r1 && v->kr[i] + v->ch > r0 && \
                  v->kc[i] < c1 && v->kc[i] + v->cw > c0 && \
                  (!x->km[k] || x->km[k] >> i & 1))
  for (int i = 0; i < v->nk; i++)
    if (UNDER(i)) q[2 * n] = v->ka[i], q[2 * n + 1] = v->ka[i] + v->kn[i], n++;
  n = merge(q, n, j->gap, 0);
  for (int i = 0; i < n; i++)
    if (!got(j, u, q[2 * i], q[2 * i + 1]) &&
        (e = want(j, u, q[2 * i], q[2 * i + 1])) != LACK)
      return e;
  if (e == LACK) return e;
  size_t m = (size_t)(r1 - r0) * (c1 - c0);
  x->wr[k] = r0, x->wc[k] = c0, x->wh[k] = r1 - r0, x->ww[k] = c1 - c0;
  x->b[k] = malloc((m ? m : 1) * sizeof *x->b[k]);
  for (size_t i = 0; i < m; i++) x->b[k][i] = NAN;
  if (k == S5 || k == S6 || k == F1 || k == S7)
    x->hist[k] = calloc(65536, sizeof *x->hist[k]);
  for (int i = 0; i < v->nk; i++)
    if (UNDER(i)) {
      rd *r = got(j, u, v->ka[i], v->ka[i] + v->kn[i]);
      if ((e = unchunk(j, k, v, i, r->b.p + v->ka[i] - r->lo, x->b[k], r0,
                       r1, c0, c1, x->hist[k])))
        return e;
    }
#undef UNDER
  // the band's threshold: the least dn above the commonest that no pixel
  // holds. the chunks read hold 1/w of the granule, so the least at which
  // w levels in a row are empty: as likely, where the counts are poisson,
  // as one empty level over the granule. caseiro et al. start from the
  // 1000th brightest pixel, which can lie among a gulf's flares
  unsigned *h = x->hist[k];
  long t = v->sg && v->es == 2 ? -32768 : 0, md = t, z = 0;
  double all = 0;
  for (long i = t; h && i < t + 65536; i++)
    all += h[i & 65535], md = h[i & 65535] > h[md & 65535] ? i : md;
  int w = h ? ceil((double)v->h * v->w / MAX(all, 1)) : 0;
  long top = v->sg && v->es == 2 ? 32767 : 65535;
  for (t = md; h && t <= top && z < w; t++) z = h[t & 65535] ? 0 : z + 1;
  x->th[k] = !h ? 0 : z < w ? top : t - w;   // no gap: nothing is hot
  return NULL;
}

// a raster's value at its band's row r, column c, or NAN off it
static float px(const sj *x, int k, int r, int c) {
  r -= x->wr[k], c -= x->wc[k];
  return x->b[k] && r >= 0 && c >= 0 && r < x->wh[k] && c < x->ww[k]
           ? x->b[k][(size_t)r * x->ww[k] + c] : NAN;
}

// whether a value of variable k is above its band's threshold in dn
static int hot(const sj *x, int k, float y) {
  return y > x->th[k] * x->v[k].sc + x->v[k].of;
}

// a box's width in degrees, east from w: past 180° when e < w
static double span(const double *b) {
  return b[2] > b[0] ? b[2] - b[0] : b[2] - b[0] + 360;
}

// the sun's zenith angle (degrees) at lon/lat, unix time s: the
// astronomical almanac's low-precision formulae, to a few hundredths
#define R3 (M_PI / 180)
static double zenith(double lon, double lat, double s) {
  double d = s / 86400 - 10957.5, g = (357.529 + .98560028 * d) * R3,
         q = 280.459 + .98564736 * d,
         l = (q + 1.915 * sin(g) + .020 * sin(2 * g)) * R3,
         e = (23.439 - 3.6e-7 * d) * R3, ra = atan2(cos(e) * sin(l), cos(l)),
         dc = asin(sin(e) * sin(l)),
         h = fmod(280.46061837 + 360.98564736629 * d + lon, 360) * R3 - ra;
  return acos(sin(lat * R3) * sin(dc) + cos(lat * R3) * cos(dc) * cos(h)) /
         R3;
}

// the granule's middle, in unix seconds, from its name
static double sensed(const char *d) {
  const char *p = strstr(d, "_SL_1_RBT____");
  struct tm t = {0};
  if (!p || sscanf(p + 13, "%4d%2d%2dT%2d%2d%2d", &t.tm_year, &t.tm_mon,
                   &t.tm_mday, &t.tm_hour, &t.tm_min, &t.tm_sec) != 6)
    return NAN;
  t.tm_year -= 1900, t.tm_mon--;
  return timegm(&t) + 90;   // a granule is three minutes
}

// stage 0: the sun, then each file's head, its variables' headers, and its
// grid's offsets
static const char *s3heads(job *j) {
  sj *x = j->x;
  const char *e = NULL;
  double *b = x->box, s = sensed(x->dir);
  if (isnan(s)) return "not an SL_1_RBT granule";
  // by day the swir is sunlight: the sun at the box's middle, and for a
  // large box at the middle of the window too (s3window)
  x->sza = zenith(b[0] + span(b) / 2, (b[1] + b[3]) / 2, x->s = s);
  if (x->sza < x->t[SZAMIN] && span(b) < 10 && b[3] - b[1] < 10) return FIN;
  for (int f = 0; f < NF; f++)
    if (!got(j, x->u[f], 0, x->hn[f]) &&
        (e = want(j, x->u[f], 0, x->hn[f])) != LACK) {
      if (f != 3 || x->in || !strcmp(e, "fetch failed after retries"))
        return e;
      // before baseline 004 F1 is on the 1 km 'in' grid, beside S7
      free(x->u[3]), x->u[3] = swap(x->u[4], "S7_BT_in.nc", "F1_BT_in.nc");
      x->in = 1, f--, e = NULL;
    }
  if (e == LACK) return e;
  for (int k = 0, f; k < NV; k++) {
    rd *r = got(j, x->u[f = FV[k]], 0, x->hn[FV[k]]);
    long long need = h5var(r->b.p, r->b.n, k == F1 && x->in ? "F1_BT_in"
                           : V3[k], &x->v[k], &e);
    if (need > 0) return x->hn[f] = need, want(j, x->u[f], 0, need);
    if (need < 0) return e;
  }
  for (int f = 0; f < NF; f++) {
    rd *r = got(j, x->u[f], 0, x->hn[f]);
    double to;
    if (!gattr(r->b.p, r->b.n, "track_offset", &to)) return "no track offset";
    x->to[f] = to;
  }
  x->H = x->v[S5].h, x->W = x->v[S5].w;
  return NULL;
}

// stage 1: every chunk index, and the tie-point grid (whose index the head
// nearly always holds), as doubles
static const char *s3trees(job *j) {
  sj *x = j->x;
  const char *e = NULL, *l = NULL;
  for (int k = 0; k < NV; k++) {
    var *v = &x->v[k];
    rd *r = got(j, x->u[FV[k]], v->bt, v->bt + TREE3);
    if (!r) e = want(j, x->u[FV[k]], v->bt, v->bt + TREE3);
    else if (!v->ok) e = btree(r->b.p + v->bt - r->lo, v);
    if (e && e != LACK) return e;
    l = l ? l : e, e = NULL;
  }
  for (int k = LAT; k <= LON; k++)
    if (x->v[k].ok && !x->ll[k]) {
      if ((e = grab(j, k, 0, x->v[k].h, 0, x->v[k].w)) == LACK) l = e;
      else if (e) return e;
      else {
        size_t m = (size_t)x->wh[k] * x->ww[k];
        x->ll[k] = malloc(m * sizeof *x->ll[k]);
        for (size_t i = 0; i < m; i++) x->ll[k][i] = x->b[k][i];
      }
    }
  return l;
}

// a 500 m pixel's lon/lat on the ellipsoid, bilinear in the tie-point
// grid: row i is tie row i/2 and column j tie column j/32 from their track
// offsets. a few hundred metres off on flat ground, the terrain's parallax
// more over hills: for the window alone
static void place(const sj *x, double i, double j, double *lon,
                  double *lat) {
  int th = x->v[LAT].h, tw = x->v[LAT].w;
  double r = i / 2, c = x->to[0] - (x->to[1] - j) / 32;
  int a = MIN(MAX((int)floor(r), 0), th - 2),
      b = MIN(MAX((int)floor(c), 0), tw - 2);
  double u = r - a, v = c - b, *la = x->ll[0], *lo = x->ll[1],
         o = lo[a * tw + b];
  double w[4] = {(1 - u) * (1 - v), (1 - u) * v, u * (1 - v), u * v};
  *lat = *lon = 0;
  for (int z = 0; z < 4; z++) {
    int q = (a + z / 2) * tw + b + z % 2;
    *lat += w[z] * la[q];
    *lon += w[z] * (lo[q] - o - 360 * round((lo[q] - o) / 360));
  }
  *lon = fmod(*lon + o + 540, 360) - 180;
}

static int inbox(const double *b, double lon, double lat) {
  return lat >= b[1] && lat < b[3] &&
         (b[0] <= b[2] ? lon >= b[0] && lon < b[2]
                       : lon >= b[0] || lon < b[2]);
}

// file f's 1 km row and column under 500 m pixel i, j
static void km(const sj *x, int f, int i, int j, int *r, int *c) {
  *r = (int)floor(i / 2.);
  *c = x->to[f] - (int)floor((x->to[1] - j + 1) / 2.);
}

// stage 2: the box in the image, from the tie-point cells over it, widened
// for the background; S5, its exception flags and the cloud mask over it
static const char *s3window(job *j) {
  sj *x = j->x;
  int th = x->v[LAT].h, tw = x->v[LAT].w;
  drop3(j, 0);   // each stage drops the files it is done with
  if (!x->r1) {
    double *la = x->ll[0], *lo = x->ll[1], *b = x->box;
    int r0 = x->H, r1 = 0, c0 = x->W, c1 = 0;
    for (int r = 0; r + 1 < th; r++)
      for (int c = 0; c + 1 < tw; c++) {
        double a = 90, z = -90, w = 1e9, e = -1e9, o = lo[r * tw + c];
        for (int k = 0; k < 4; k++) {
          int q = (r + k / 2) * tw + c + k % 2;
          double d = lo[q] - o - 360 * round((lo[q] - o) / 360);
          a = MIN(a, la[q]), z = MAX(z, la[q]), w = MIN(w, d), e = MAX(e, d);
        }
        double bw = b[0] - o - 360 * round((b[0] - o) / 360),
               be_ = bw + span(b);
        if (isnan(a + z + w + e) || z < b[1] || a > b[3] ||
            ((e < bw || w > be_) && (e < bw - 360 || w > be_ - 360)))
          continue;
        int i0 = 2 * r, j0 = x->to[1] - 32 * (x->to[0] - c);
        r0 = MIN(r0, i0), r1 = MAX(r1, i0 + 3), c0 = MIN(c0, j0),
        c1 = MAX(c1, j0 + 33);
      }
    x->r0 = MAX(r0 - MARGIN, 0), x->r1 = MIN(r1 + MARGIN, x->H);
    x->c0 = MAX(c0 - MARGIN, 0), x->c1 = MIN(c1 + MARGIN, x->W);
    if (x->r0 >= x->r1 || x->c0 >= x->c1) return FIN;   // not over the box
    double lon, lat;
    place(x, (x->r0 + x->r1) / 2., (x->c0 + x->c1) / 2., &lon, &lat);
    if ((x->sza = zenith(lon, lat, x->s)) < x->t[SZAMIN]) return FIN;
  }
  const char *l = NULL, *e;
  int ks[] = {S5, X5, CLD};
  for (int k = 0; k < 3; k++)
    if (!x->b[ks[k]] &&
        (e = grab(j, ks[k], x->r0, x->r1, x->c0, x->c1)) && (l = e) != LACK)
      return e;
  return l;
}

#define SAT5 16   // S5's exception for a saturated pixel
#define ABSENT 2  // and for one absent, filled with a neighbour's value

// stage 3: S5's hot pixels, absent ones not, saturated ones too, and the
// box's clear share: of the rest, those where no cloud test of cloud_bits
// fired (the night's mid-infrared tests take most hot pixels for cloud);
// then, if any are hot, S6 and the pixels' places
static const char *s3cands(job *j) {
  sj *x = j->x;
  int ww = x->c1 - x->c0;
  size_t m = (size_t)(x->r1 - x->r0) * ww;
  float *s5 = x->b[S5], *xc = x->b[X5], *cl = x->b[CLD];
  drop3(j, 1), drop3(j, 5);
  if (!x->cd) {
    double lon, lat;
    long in = 0, clr = 0;
    x->cd = malloc(m * sizeof *x->cd);
    if (x->t[SQ] > 0) {   // at most 4M squares: a 0.02° grid over 40°
      double q = x->t[SQ], *b = x->box;
      x->qx = floor(b[0] / q), x->qy = floor(b[1] / q);
      x->qw = (long)floor((b[0] + span(b)) / q) - x->qx + 1;
      x->qh = (long)floor(b[3] / q) - x->qy + 1;
      if ((double)x->qw * x->qh <= 1 << 22)
        x->qn = calloc((size_t)x->qw * x->qh, sizeof *x->qn),
        x->qc = calloc((size_t)x->qw * x->qh, sizeof *x->qc);
    }
    for (size_t i = 0; i < m; i++) {
      int r = x->r0 + i / ww, c = x->c0 + i % ww, f = flag(xc[i]);
      if (f & ABSENT) s5[i] = NAN;
      if (!(f & ABSENT) && (f & SAT5 || hot(x, S5, s5[i]))) x->cd[x->nc++] = i;
      else if (isfinite(s5[i]) && (place(x, r, c, &lon, &lat),
                                   inbox(x->box, lon, lat))) {
        int ok = !(flag(cl[i]) & (int)x->t[CBITS]);
        in++, clr += ok, square(x, lon, lat, ok);
      }
    }
    x->clear = in ? (double)clr / in : NAN;
    free(x->b[CLD]), x->b[CLD] = NULL;
    if (!x->nc) return FIN;
  }
  const char *l = NULL, *e;
  for (int k = LA5; k <= LO5; k++)   // the place: the candidates' chunks
    for (int i = 0, q; i < x->nc && !x->b[k]; i++)
      for (q = 0; q < x->v[k].nk; q++) {
        int r = x->r0 + x->cd[i] / ww - x->v[k].kr[q],
            c = x->c0 + x->cd[i] % ww - x->v[k].kc[q];
        if (r >= 0 && r < x->v[k].ch && c >= 0 && c < x->v[k].cw)
          x->km[k] |= 1ull << q;
      }
  int c0 = ww, c1 = 0;
  for (int i = 0; i < x->nc; i++)
    c0 = MIN(c0, x->cd[i] % ww), c1 = MAX(c1, x->cd[i] % ww + 1);
  for (int k = S6; k <= LO5; k++) {
    int a = x->r0, b = x->r1, c = x->c0, d = x->c1;
    if (k >= LA5)   // over the candidates alone
      a += x->cd[0] / ww, b = x->r0 + x->cd[x->nc - 1] / ww + 1, c += c0,
      d = x->c0 + c1;
    if ((k == S6 || (k >= LA5 && x->t[EXACT])) && !x->b[k] &&
        (e = grab(j, k, a, b, c, d)) && (l = e) != LACK)
      return e;
  }
  return l;
}

// planck's radiance, W m-2 sr-1 µm-1, at l µm and t K
static double planck(double l, double t) {
  return 1.191042e8 / pow(l, 5) / expm1(1.4387752e4 / (l * t));
}

#define L5 1.613
#define L6 2.256

static int fcmp(const void *a, const void *b) {
  return (*(float *)a > *(float *)b) - (*(float *)a < *(float *)b);
}

// the median of the finite values of a[0..n)
static double median(float *a, int n) {
  int k = 0;
  for (int i = 0; i < n; i++)
    if (isfinite(a[i])) a[k++] = a[i];
  return k ? qsort(a, k, sizeof *a, fcmp), a[k / 2] : NAN;
}

// stage 4: the hot pixels' 8-connected clusters, each one's members
// together (x->mb[x->at[l]..x->at[l + 1]) for root l). one is confirmed if
// it is saturated or S6 is hot within a pixel of it; else S7 (F1 where S7
// saturates) is read over the window, to be hot within a 1 km pixel
static const char *s3clus(job *j) {
  sj *x = j->x;
  int nc = x->nc, *cd = x->cd, ww = x->c1 - x->c0, need = 0;
  if (!x->mb) {
    int *par = malloc(nc * 4), *p;
    for (int f = 0; f < NF; f++) drop3(j, f);
    for (int k = 0; k < nc; k++) {
      par[k] = k;
      for (int q = k - 1; q >= 0 && cd[k] - cd[q] <= ww + 1; q--)
        if (cd[k] / ww - cd[q] / ww <= 1 && abs(cd[k] % ww - cd[q] % ww) <= 1)
          par[find(par, k)] = find(par, q);
    }
    x->at = calloc(nc + 1, 4), x->mb = malloc(nc * 4), x->ok = calloc(nc, 1);
    for (int k = 0; k < nc; k++) x->at[find(par, k) + 1]++;
    for (int k = 0; k < nc; k++) x->at[k + 1] += x->at[k];
    p = memcpy(malloc(nc * 4), x->at, nc * 4);
    for (int k = 0; k < nc; k++) x->mb[p[find(par, k)]++] = cd[k];
    free(p), free(par);
    for (int l = 0; l < nc; l++)
      for (int q = x->at[l]; q < x->at[l + 1]; q++) {
        int i = x->r0 + x->mb[q] / ww, c = x->c0 + x->mb[q] % ww;
        x->ok[l] |= flag(x->b[X5][x->mb[q]]) & SAT5;
        for (int di = -1; di <= 1; di++)
          for (int dj = -1; dj <= 1; dj++)
            x->ok[l] |= hot(x, S6, px(x, S6, i + di, c + dj));
      }
  }
  for (int l = 0; l < nc; l++) need |= x->at[l + 1] > x->at[l] && !x->ok[l];
  const char *e, *r = NULL;
  for (int k = F1; need && k <= S7; k++) {
    int a, b, c, d;
    km(x, FV[k], x->r0, x->c0, &a, &c), km(x, FV[k], x->r1, x->c1, &b, &d);
    if (!x->b[k] && (e = grab(j, k, a - 2, b + 2, c - 2, d + 2)) &&
        (r = e) != LACK)
      return e;
  }
  return r;
}

// stage 5: each cluster's place, and over its background (the median of
// what lies two pixels beyond its box) its swir sums, whose ratio gives
// planck's temperature, and S6 at that temperature the fire's area and so
// its radiant heat
static const char *s3dets(job *j) {
  sj *x = j->x;
  int ww = x->c1 - x->c0;
  for (int l = 0; l < x->nc; l++) {
    int n = x->at[l + 1] - x->at[l], *m = x->mb + x->at[l], sat = 0, h = 0,
        i0 = 1 << 30, i1 = -1, j0 = 1 << 30, j1 = -1, r, c;
    double w = 0, wi = 0, wj = 0, ga = 0, gl = 0, gw = 0, o = NAN, lon, lat;
    for (int q = 0; q < n; q++) {
      int i = x->r0 + m[q] / ww, jj = x->c0 + m[q] % ww;
      float y = x->b[S5][m[q]], la = px(x, LA5, i, jj), lo = px(x, LO5, i, jj);
      double e = (isfinite(y) ? MAX(y, 0) : 0) + 1e-9;
      sat |= flag(x->b[X5][m[q]]) & SAT5;
      w += e, wi += e * i, wj += e * jj;
      i0 = MIN(i0, i), i1 = MAX(i1, i), j0 = MIN(j0, jj), j1 = MAX(j1, jj);
      // the mid-infrared, if read: S7 hot under it, or F1 where S7 is
      // past 306 K, its linear range, and F1 within its own (300-480 K)
      for (int di = -2; !x->ok[l] && di <= 2; di += 2)
        for (int dj = -2; dj <= 2; dj += 2) {
          km(x, 4, i + di, jj + dj, &r, &c);
          float s7 = px(x, S7, r, c), f1;
          km(x, 3, i + di, jj + dj, &r, &c), f1 = px(x, F1, r, c);
          h |= s7 < 306 ? hot(x, S7, s7)
                        : hot(x, F1, f1) && f1 >= 300 && f1 <= 480;
        }
      if (!isfinite(la + lo)) continue;
      if (isnan(o)) o = lo;
      ga += e * la, gl += e * (lo - o - 360 * round((lo - o) / 360)), gw += e;
    }
    if (!n) continue;
    // the place: the excess-weighted mean of the pixels' own, which hold
    // the terrain's parallax, or from the tie points without them
    if (gw > 0) lat = ga / gw, lon = fmod(gl / gw + o + 540, 360) - 180;
    else place(x, wi / w, wj / w, &lon, &lat);
    if (!inbox(x->box, lon, lat)) continue;
    int nb = (i1 - i0 + 5) * (j1 - j0 + 5), b = 0;
    float *r5 = malloc(nb * 4), *r6 = malloc(nb * 4);
    for (int i = i0 - 2; i <= i1 + 2; i++)
      for (int jj = j0 - 2; jj <= j1 + 2; jj++)
        if (i < i0 || i > i1 || jj < j0 || jj > j1)
          r5[b] = px(x, S5, i, jj), r6[b++] = px(x, S6, i, jj);
    double bg5 = median(r5, b), bg6 = median(r6, b), a5 = 0, a6 = 0;
    free(r5), free(r6);
    for (int q = 0; q < n; q++) {
      int i = x->r0 + m[q] / ww, jj = x->c0 + m[q] % ww;
      float y5 = px(x, S5, i, jj), y6 = px(x, S6, i, jj);
      a5 += isfinite(y5) ? y5 - bg5 : 0, a6 += isfinite(y6) ? y6 - bg6 : 0;
    }
    a5 *= x->t[G5], a6 *= x->t[G6];
    // T where B(L5, T) / B(L6, T) is the sums' ratio, by bisection, and
    // spurious outside t_min-t_max K; a saturated cluster has none
    double lo = x->t[TMIN], hi = x->t[TMAX], t = NAN, rt = a5 / a6;
    if (!sat) {
      if (!(a6 > 0 && rt > planck(L5, lo) / planck(L6, lo) &&
            rt < planck(L5, hi) / planck(L6, hi)))
        continue;
      for (int z = 0; z < 40; z++)
        t = (lo + hi) / 2,
        *(planck(L5, t) / planck(L6, t) < rt ? &lo : &hi) = t;
    }
    if (x->nd == x->cap)
      x->d = realloc(x->d, (x->cap = 2 * x->cap + 8) * sizeof *x->d);
    x->d[x->nd++] = (h3){lon, lat, a5, a6, t,
      5.670374e-8 * pow(t, 4) * a6 / planck(L6, t) * APIX / 1e6, n,
      x->ok[l] || h, !!sat};
  }
  return NULL;
}

static const char *s3stage(job *j) {
  static const char *(*const s[NS3])(job *) = {s3heads, s3trees, s3window,
                                               s3cands, s3clus, s3dets};
  return s[j->st](j);
}

static void s3start(job *j, sj *x) {
  j->x = x, j->gap = 1 << 20, x->clear = x->sza = NAN;
  for (int f = 0; f < NF; f++)
    if (x->hn[f] = HEAD3[f], asprintf(&x->u[f], "%s/%s.nc", x->dir, F3[f]) < 0)
      x->u[f] = NULL;
}

// all but its result and granule, once it is done
static void s3end(sj *x) {
  for (int f = 0; f < NF; f++) free(x->u[f]), x->u[f] = NULL;
  for (int k = 0; k < NV; k++)
    free(x->b[k]), free(x->hist[k]), x->b[k] = NULL, x->hist[k] = NULL;
  free(x->ll[0]), free(x->ll[1]), free(x->cd), free(x->at), free(x->mb);
  free(x->ok);
  x->ll[0] = x->ll[1] = NULL, x->cd = x->at = x->mb = NULL, x->ok = NULL;
}

// rows by granule, then by place in the chunk; a null row last
static __thread row *qrs;
static int bydir(const void *a, const void *b) {
  idx_t i = *(const idx_t *)a, k = *(const idx_t *)b;
  const char *u = qrs[i].url, *v = qrs[k].url;
  int c = !u || !v ? !u - !v : strcmp(u, v);
  return c ? c : (i > k) - (i < k);
}

#define NH 9   // a hotspot's fields
#define NQ 4   // a square's
static void s3_detect(duckdb_function_info info, duckdb_data_chunk in,
                      duckdb_vector out) {
  idx_t n = duckdb_data_chunk_get_size(in), cols =
    duckdb_data_chunk_get_column_count(in), t = 0, o = 0;
  duckdb_vector v[6];
  row *rs = calloc(n ? n : 1, sizeof *rs);
  sj *xs = calloc(n ? n : 1, sizeof *xs);
  (void)info;
  for (idx_t k = 0; k < cols; k++) v[k] = duckdb_data_chunk_get_vector(in, k);
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    sj *x = &xs[i];
    int null = 0;
    for (idx_t k = 0; k < 5; k++) null |= !valid(v[k], i);
    if (null) continue;
    w->url = str(v[0], i), x->dir = strdup(w->url), w->x = x;
    for (int k = 0; k < 4; k++)
      x->box[k] = ((double *)duckdb_vector_get_data(v[k + 1]))[i];
    memcpy(x->t, TD3, sizeof x->t);
    if (cols > 5 && valid(v[5], i)) {
      char *p = str(v[5], i);
      w->e = params(p, x->t, TK3, NT3);
      free(p);
    }
    if (!w->e && x->box[3] <= x->box[1]) w->e = "empty box";
  }
  // the rows of one granule run as one job on one worker, each box after
  // the last, so the heads, the tie-point grid and any chunk two boxes share
  // are read once: rows in the granule's order chain as they come
  idx_t *ix = malloc((n ? n : 1) * sizeof *ix);
  for (idx_t i = 0; i < n; i++) ix[i] = i;
  qrs = rs, qsort(ix, n, sizeof *ix, bydir);
  for (idx_t i = 1; i < n; i++) {
    row *a = &rs[ix[i - 1]], *b = &rs[ix[i]];
    if (a->url && b->url && !strcmp(a->url, b->url))
      a->same = b, b->follow = 1, a->x->keep = 1;
  }
  free(ix);
  run(rs, n);
  // sza, clear, error, the hotspots and the squares; a null input row is a
  // null result
  duckdb_vector c[5];
  uint64_t *mo, *mc[5];
  duckdb_vector_ensure_validity_writable(out);
  mo = duckdb_vector_get_validity(out);
  for (int k = 0; k < 5; k++)
    c[k] = duckdb_struct_vector_get_child(out, k),
    duckdb_vector_ensure_validity_writable(c[k]),
    mc[k] = duckdb_vector_get_validity(c[k]);
  for (idx_t i = 0; i < n; i++) t += rs[i].e ? 0 : xs[i].nd;
  duckdb_list_vector_reserve(c[3], t);
  duckdb_list_vector_set_size(c[3], t);
  duckdb_vector f = duckdb_list_vector_get_child(c[3]);
  duckdb_list_entry *le = duckdb_vector_get_data(c[3]);
  void *d[NH];
  for (int k = 0; k < NH; k++)
    d[k] = duckdb_vector_get_data(duckdb_struct_vector_get_child(f, k));
  // the squares a pixel fell in
  idx_t tq = 0, oq = 0;
  for (idx_t i = 0; i < n; i++)
    for (long k = 0; !rs[i].e && xs[i].qn && k < (long)xs[i].qw * xs[i].qh;
         k++)
      tq += xs[i].qn[k] > 0;
  duckdb_list_vector_reserve(c[4], tq);
  duckdb_list_vector_set_size(c[4], tq);
  duckdb_vector fq = duckdb_list_vector_get_child(c[4]);
  duckdb_list_entry *lq = duckdb_vector_get_data(c[4]);
  void *dq[NQ];
  for (int k = 0; k < NQ; k++)
    dq[k] = duckdb_vector_get_data(duckdb_struct_vector_get_child(fq, k));
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    sj *x = &xs[i];
    le[i] = (duckdb_list_entry){o, 0}, lq[i] = (duckdb_list_entry){oq, 0};
    if (!w->url) {   // its fields null too: duckdb reads a field alone
      duckdb_validity_set_row_invalid(mo, i);
      for (int k = 0; k < 5; k++) duckdb_validity_set_row_invalid(mc[k], i);
      continue;
    }
    double s[2] = {x->sza, x->clear};
    for (int k = 0; k < 2; k++)
      if (isnan(s[k])) duckdb_validity_set_row_invalid(mc[k], i);
      else ((double *)duckdb_vector_get_data(c[k]))[i] = s[k];
    if (w->e) duckdb_vector_assign_string_element(c[2], i, w->e),
              duckdb_validity_set_row_invalid(mc[3], i),
              duckdb_validity_set_row_invalid(mc[4], i);
    else duckdb_validity_set_row_invalid(mc[2], i);
    for (long k = 0; !w->e && x->qn && k < (long)x->qw * x->qh; k++)
      if (x->qn[k]) {
        double q = x->t[SQ], lon = (x->qx + k % x->qw) * q;
        // its south-west corner, to 1e-6°, off the float noise of k × q
        ((double *)dq[0])[oq] = round((fmod(lon + 540, 360) - 180) * 1e6) / 1e6;
        ((double *)dq[1])[oq] = round((x->qy + k / x->qw) * q * 1e6) / 1e6;
        ((int32_t *)dq[2])[oq] = x->qn[k];
        ((double *)dq[3])[oq++] = (double)x->qc[k] / x->qn[k];
      }
    lq[i].length = oq - lq[i].offset;
    free(x->qn), free(x->qc);
    for (int k = 0; !w->e && k < x->nd; k++, o++) {
      h3 *h = &x->d[k];
      double y[] = {h->lon, h->lat, h->s5, h->s6, h->temp, h->rh};
      for (int z = 0, q = 0; z < NH; z++)
        if (z == 2) ((int32_t *)d[z])[o] = h->px;
        else if (z >= 7) ((bool *)d[z])[o] = z == 7 ? h->conf : h->sat;
        else ((double *)d[z])[o] = y[q++];
    }
    le[i].length = o - le[i].offset;
    free(w->url), free(x->d), free(x->dir);
  }
  // a nan (no temperature, as when saturated) is a null
  for (int z = 5; z < 7; z++) {
    duckdb_vector g = duckdb_struct_vector_get_child(f, z);
    duckdb_vector_ensure_validity_writable(g);
    for (idx_t q = 0; q < t; q++)
      if (isnan(((double *)d[z])[q]))
        duckdb_validity_set_row_invalid(duckdb_vector_get_validity(g), q);
  }
  free(rs), free(xs);
}

static duckdb_state s3_register(duckdb_connection con) {
  const char *hn[] = {"lon", "lat", "pixels", "s5", "s6", "temperature", "rh",
                      "confirmed", "saturated"},
             *sn[] = {"sza", "clear", "error", "hotspots", "squares"},
             *qn[] = {"lon", "lat", "pixels", "clear"};
  duckdb_logical_type ht[NH], st[5], qt[NQ], dbl = type(DUCKDB_TYPE_DOUBLE),
                      vc = type(DUCKDB_TYPE_VARCHAR);
  for (int k = 0; k < NQ; k++)
    qt[k] = type(k == 2 ? DUCKDB_TYPE_INTEGER : DUCKDB_TYPE_DOUBLE);
  duckdb_logical_type qs = duckdb_create_struct_type(qt, qn, NQ);
  for (int k = 0; k < NH; k++)
    ht[k] = type(k == 2 ? DUCKDB_TYPE_INTEGER
                 : k >= 7 ? DUCKDB_TYPE_BOOLEAN : DUCKDB_TYPE_DOUBLE);
  duckdb_logical_type hs = duckdb_create_struct_type(ht, hn, NH);
  st[0] = st[1] = dbl, st[2] = vc, st[3] = duckdb_create_list_type(hs);
  st[4] = duckdb_create_list_type(qs);
  duckdb_logical_type ret = duckdb_create_struct_type(st, sn, 5);
  duckdb_scalar_function_set set = duckdb_create_scalar_function_set(
    "s3_detect");
  for (int extra = 0; extra < 2; extra++) {
    duckdb_scalar_function f = duckdb_create_scalar_function();
    duckdb_scalar_function_set_name(f, "s3_detect");
    duckdb_scalar_function_add_parameter(f, vc);
    for (int k = 0; k < 4; k++) duckdb_scalar_function_add_parameter(f, dbl);
    if (extra) duckdb_scalar_function_add_parameter(f, vc);
    duckdb_scalar_function_set_return_type(f, ret);
    duckdb_scalar_function_set_special_handling(f);
    duckdb_scalar_function_set_volatile(f);
    duckdb_scalar_function_set_function(f, s3_detect);
    duckdb_add_scalar_function_to_set(set, f);
    duckdb_destroy_scalar_function(&f);
  }
  duckdb_state ok = duckdb_register_scalar_function_set(con, set);
  duckdb_destroy_scalar_function_set(&set);
  for (int k = 0; k < NH; k++) duckdb_destroy_logical_type(&ht[k]);
  duckdb_destroy_logical_type(&hs), duckdb_destroy_logical_type(&st[3]);
  for (int k = 0; k < NQ; k++) duckdb_destroy_logical_type(&qt[k]);
  duckdb_destroy_logical_type(&qs), duckdb_destroy_logical_type(&st[4]);
  duckdb_destroy_logical_type(&ret), duckdb_destroy_logical_type(&dbl);
  duckdb_destroy_logical_type(&vc);
  return ok;
}
