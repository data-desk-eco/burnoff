// burnoff: sentinel-2 l1c swir flare detection, straight off the jp2 archive,
// as a duckdb extension:
//   s2_flares(b12 VARCHAR, xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE
//             [, thresholds VARCHAR])
//   → STRUCT(clear DOUBLE, error VARCHAR, flares STRUCT(x, y, max_b12,
//            avg_b12, peak_b11, ratio, peakedness, pixels, radiance,
//            saturated)[])
// the box is in metres of the tile's own UTM zone; b11, b8a and the
// MSK_CLASSI cloud mask are found beside b12 by the SAFE naming convention.
// urls are s3:// (signed with AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY against
// AWS_S3_ENDPOINT), https:// or file://. thresholds is 'name=value,...' over
// the defaults. each chunk's rows run at once on a worker pool, and a failed
// row carries its error rather than failing the query.
//
// why it is fast:
// - sentinel-2 jp2s carry no tile index (TLM) before baseline 05.12, so a
//   reader walks every earlier tile-part header to reach tile k, one range
//   request each. 0xff90 never occurs inside entropy-coded data, so a guess
//   at tile k's offset plus a scan for its SOT marker finds it instead, and a
//   learned per-MGRS layout makes the guess right first time. a box that
//   needs much of a band takes the whole codestream in one request.
// - a tile-part behind the file's own main header is a complete codestream,
//   and openjpeg decodes just a window of it. decoding is nearly all the
//   cost, so b12 is decoded only over clear background cells, and b11 and
//   b8a only over windows around candidate flares.
// - the 60 m cloud mask (a few KB) is read first: jp2 tiles under cloud are
//   never fetched. headers and masks are cached across rows, so many sites
//   on one scene read them once.
//
// a compact-source flare detector, run over the box in one pass:
// a background median per 320 px cell, the spectral mask, its 4-connected
// components, the morphological gates and the hot core grown from each peak.
#define _GNU_SOURCE
#define DUCKDB_EXTENSION_NAME burnoff
#define DUCKDB_EXTENSION_API_VERSION_MAJOR 1
#define DUCKDB_EXTENSION_API_VERSION_MINOR 2
#define DUCKDB_EXTENSION_API_VERSION_PATCH 0
#include "duckdb_extension.h"
#include <curl/curl.h>
#include <math.h>
#include <openjpeg.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
DUCKDB_EXTENSION_EXTERN

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

// the default compact-source gates
static const char *TK[] = {"b12_min", "b11_min", "peak_b12_min",
  "contrast_ratio", "background_floor", "peakedness_min", "saturation",
  "hot_floor", "max_pixels", "large_pixels", "large_b12_min",
  "warm_fraction", "warm_max_pixels", "single_pixel_min", "max_cloud_local"};
static const double TD[] = {.30, .20, .50, 3, .15, 1.15, 1, .50, 80, 30, .70,
  .5, 100, .65, .75};
enum { B12MIN, B11MIN, PEAKMIN, CONTRAST, BGFLOOR, PEAKED, SAT, HOT, MAXPX,
  LARGEPX, LARGEMIN, WARMF, WARMMAX, SINGLE, MAXCLOUD, NT };
#define CELL 320   // background cell, a quarter of a 640 px jp2 tile
// a jp2 decode costs ~4 ms however small its window (the tile's packet
// headers are parsed whole), about as much as 2^14 more pixels
#define FIXED (1 << 14)

// "name=value,name=value" over t
static const char *params(const char *s, double *t) {
  while (s && *s) {
    const char *eq = strchr(s, '='), *end = strchr(s, ',');
    int k = 0;
    if (!eq || (end && eq > end)) return "expected name=value";
    while (k < NT && (strlen(TK[k]) != (size_t)(eq - s) ||
                      strncmp(TK[k], s, eq - s)))
      k++;
    if (k == NT) return "unknown threshold";
    t[k] = atof(eq + 1);
    s = end ? end + 1 : NULL;
  }
  return NULL;
}

// N0400+ radiometry: every band carries RADIO_ADD_OFFSET -1000 over a
// QUANTIFICATION_VALUE of 10000. older baselines have no raster cloud mask.
static double cal(int dn) { return dn ? (dn - 1000) / 10000. : 0; }

// bytes read: where they start in the file, the file's size when known, and
// the seconds a 429 asked us to wait
typedef struct {
  unsigned char *p;
  size_t n, cap;
  long long off, size;
  int wait;
} buf;

static size_t wr(char *d, size_t s, size_t n, void *u) {
  buf *b = u;
  if (b->n + s * n > b->cap)
    b->p = realloc(b->p, b->cap = 2 * (b->n + s * n));
  memcpy(b->p + b->n, d, s * n);
  return b->n += s * n, s * n;
}

static void drop(buf *b) { free(b->p), *b = (buf){0}; }

static size_t hd(char *d, size_t s, size_t n, void *u) {
  buf *b = u;
  char *slash = memchr(d, '/', s * n);
  if (!strncasecmp(d, "content-range:", 14) && slash)
    b->size = atoll(slash + 1);
  if (!strncasecmp(d, "x-ratelimit-reset:", 18)) b->wait = atoi(d + 18);
  if (!strncasecmp(d, "retry-after:", 12)) b->wait = atoi(d + 12);
  return s * n;
}

// bytes [lo, hi) or, with hi < 0, from lo to the end. a range past the end
// is PAST, which eodata answers with a 404 rather than a 416. transient
// failures (network errors, 429, 5xx) retry: a 429 after the wait it names,
// as eodata allows 5000 requests a minute for each key, and the rest with a
// backoff, as cdse sheds load with 503s
static const char PAST[] = "range past the end of the file";

static const char *get(CURL *c, const char *url, long long lo, long long hi,
                       buf *b) {
  char range[48], u[4096];
  const char *s3 = getenv("AWS_S3_ENDPOINT");
  if (!strncmp(url, "s3://", 5))
    snprintf(u, sizeof u, "https://%s/%s",
             s3 ? s3 : "eodata.dataspace.copernicus.eu", url + 5);
  else
    snprintf(u, sizeof u, "%s", url);
  if (hi < 0) snprintf(range, sizeof range, "%lld-", lo);
  else snprintf(range, sizeof range, "%lld-%lld", lo, hi - 1);
  curl_easy_setopt(c, CURLOPT_URL, u);
  curl_easy_setopt(c, CURLOPT_RANGE, lo || hi >= 0 ? range : NULL);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, b);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, b);
  for (int i = 0; i < 8; i++) {
    long code = 0;
    b->n = 0, b->size = -1, b->wait = 0;
    CURLcode e = curl_easy_perform(c);
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
    if (!e && (code == 416 || (code == 404 && lo))) return PAST;
    if (!e && code < 400) {
      b->off = code == 200 ? 0 : lo;   // a server that ignored the range
      if (b->size < 0 && (hi < 0 || code == 200)) b->size = b->off + b->n;
      return NULL;
    }
    if (!e && code != 429 && code < 500) return "http error";
    if (e == CURLE_FILE_COULDNT_READ_FILE || e == CURLE_URL_MALFORMAT ||
        e == CURLE_UNSUPPORTED_PROTOCOL || e == CURLE_LOGIN_DENIED)
      return curl_easy_strerror(e);
    sleep(code == 429 && b->wait > 0 ? MIN(b->wait, 60)
                                     : 1 << (i < 5 ? i : 5));
  }
  return "fetch failed after retries";
}

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
  if (hit) out->n = 0, wr((char *)s->p, 1, s->n, out), *aux = s->aux;
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

// one band file: main header, geometry, and its tile-parts as read
typedef struct {
  buf h, d;                    // main header (SOC to first SOT), tile-parts
  long long first, size;       // first SOT offset, file size
  int w, h_, tw, th, nx, nt;   // image, tile, tiles across, tile count
  double ox, oy, res;          // upper-left corner and pixel size, metres
  long long at[256], len[256]; // tile-parts located in the file, 0 = unknown
  size_t tp[256];              // where tile-part k sits in d
  char have[256];
} band;

typedef struct { CURL *c; buf b, s; band bd[3]; unsigned short *px; } ctx;

// a band's header. it is the same on every date of one MGRS tile, band and
// processing baseline (only kakadu's comments differ), so one read serves
// them all, and the file's size, until a read gives it, is that file's
static const char *header(ctx *x, const char *url, band *f) {
  char key[64];
  const char *fn = strrchr(url, '/') ? strrchr(url, '/') + 1 : url;
  const char *bd = strrchr(fn, '_'), *nb = strstr(url, "_N");
  buf *b = &x->b;
  long long size = -1;
  snprintf(key, sizeof key, "%.6s%.12s%.6s", fn, bd ? bd : "", nb ? nb : "");
  if (!recall(key, b, &size)) {
    const char *e = get(x->c, url, 0, 16384, b);
    if (e) return e;
    if ((size = b->size) < 0) {   // no Content-Range (file://)
      curl_off_t n = -1;
      curl_easy_setopt(x->c, CURLOPT_NOBODY, 1L);
      curl_easy_perform(x->c);
      curl_easy_getinfo(x->c, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &n);
      curl_easy_setopt(x->c, CURLOPT_NOBODY, 0L);
      curl_easy_setopt(x->c, CURLOPT_HTTPGET, 1L);
      if ((size = n) < 0) return "unknown file size";
    }
    keep(key, b, size);
  }
  unsigned char *s = memmem(b->p, b->n, "\xff\x4f\xff\x51", 4);
  unsigned char *sot = s ? memmem(s, b->p + b->n - s, "\xff\x90", 2) : 0;
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
  if (f->nt > 256 || f->tw % CELL || f->th % CELL)
    return "unexpected tiling";
  f->h.n = 0, wr((char *)s, 1, sot - s, &f->h);
  f->first = sot - b->p, f->size = size, f->d.n = 0;
  memset(f->at, 0, sizeof f->at), memset(f->have, 0, sizeof f->have);
  return NULL;
}

// a tile-part header: SOT, Lsot = 10, a tile index in range, the only part
static int sot(const unsigned char *p, int nt, int *k, long long *len) {
  if (p[0] != 0xff || p[1] != 0x90 || be(p + 2, 2) != 10) return 0;
  *k = be(p + 4, 2), *len = be(p + 6, 4);
  return *k < nt && !p[10] && p[11] <= 1 && *len >= 14;
}

// tile-part k: fetch around a predicted offset (the expected length, when
// known, sizing the read) and scan for SOT markers. tile-parts are in tile
// order, so those found bracket k: the next read starts where k - 1 ends,
// takes the whole bracket once it is small, and otherwise interpolates
// within it
static const char *tile(ctx *x, const char *url, band *f, const char *need,
                        int k, long long pred, long long want) {
  long long M = want ? 64 << 10 : 256 << 10, lo = pred - M, len;
  long long W = 2 * M + (want ? want + want / 8 : 512 << 10);
  long long B = f->first, A = 0;   // k lies in [B, A), or [B, size)
  int kb = -1, ka = f->nt, j;
  buf *b = &x->b;
  for (int i = 0; i < 12; i++) {
    lo = MAX(MIN(lo, f->size - W), f->first);
    const char *e = get(x->c, url, lo, lo + W, b);
    if (e == PAST) e = get(x->c, url, 0, 1, b), b->n = 0;   // learn the size
    if (e) return e;
    f->size = b->size > 0 ? b->size : f->size;
    for (size_t q = 0; q + 12 <= b->n; q++) {
      if (b->p[q] != 0xff || !sot(b->p + q, f->nt, &j, &len)) continue;
      long long at = b->off + q;
      if (at + len > f->size) continue;
      f->at[j] = at, f->len[j] = len;
      if (need[j] && !f->have[j] && q + len <= b->n)   // k, or one wanted
        f->tp[j] = f->d.n, f->have[j] = 1, wr((char *)b->p + q, 1, len, &f->d);
      else if (j == k) {   // k runs past the read
        if ((e = get(x->c, url, at, at + len, b))) return e;
        if (b->n != (size_t)len) return "short tile-part";
        f->tp[k] = f->d.n, f->have[k] = 1;
        return wr((char *)b->p, 1, len, &f->d), NULL;
      }
      if (j < k && j > kb) kb = j, B = at + len;
      if (j > k && j < ka) ka = j, A = at;
    }
    if (f->have[k]) return NULL;
    long long gap = (ka < f->nt ? A : f->size) - B;
    W = kb == k - 1 ? MAX(W, 512 << 10) : MIN(gap, 4 << 20);
    lo = kb == k - 1 || gap <= 4 << 20
       ? B : B + gap * (k - kb - 1) / (ka - kb - 1) - W / 2;
  }
  return "tile-part not found";
}

// learned layouts: where each tile-part sat, as fractions of file size, per
// MGRS tile and band. the land/sea/cloud mix that sizes a tile changes little
// between dates, so after one file the next is read in one request per tile
typedef struct { char key[16]; float at[256], len[256]; } layout;
static layout lay[4096];
static int nlay;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;

// T13SFR_20250519T172859_B11.jp2 → T13SFR_B11.jp2, or with band, _B12.jp2
static layout *learned(const char *url, const char *band) {
  const char *f = strrchr(url, '/') ? strrchr(url, '/') + 1 : url;
  const char *b = strrchr(f, '_');
  char key[16];
  snprintf(key, sizeof key, "%.6s%.10s", f, band ? band : b ? b : "");
  for (int i = 0; i < nlay; i++)
    if (!strcmp(lay[i].key, key)) return &lay[i];
  if (nlay == 4096) return NULL;
  memset(&lay[nlay], 0, sizeof *lay);
  return strcpy(lay[nlay].key, key), &lay[nlay++];
}

// every tile-part in need[]: the whole codestream in one request when much
// of the band is wanted, else one at a time
static const char *parts(ctx *x, const char *url, band *f, const char *need) {
  int miss = 0;
  for (int k = 0; k < f->nt; k++) miss += need[k] && !f->have[k];
  if (!miss) return NULL;
  if (miss > f->nt / 4) {
    const char *e = get(x->c, url, f->first, -1, &f->d);
    long long len;
    int k;
    if (e) return e;
    f->size = f->d.size;
    for (size_t q = 0; q + 12 <= f->d.n && sot(f->d.p + q, f->nt, &k, &len) &&
                       q + len <= f->d.n; q += len)
      f->tp[k] = q, f->at[k] = f->first + q, f->len[k] = len, f->have[k] = 1;
  }
  // a band not yet seen on this MGRS tile borrows b12's layout, which the
  // same date's b12 read has just taught
  layout l = {0}, *g;
  pthread_mutex_lock(&lk);
  if ((g = learned(url, NULL))) l = *g;
  for (int k = 0; (g = learned(url, "_B12.jp2")) && k < 256; k++)
    if (!l.at[k]) l.at[k] = g->at[k], l.len[k] = g->len[k];
  pthread_mutex_unlock(&lk);
  // one read takes k and the wanted tile-parts that the layout puts within
  // 1 MB after it, as a request costs more than a MB in region
  for (int k = 0; k < f->nt; k++) {
    if (!need[k] || f->have[k]) continue;
    long long p = l.at[k]
      ? (long long)(l.at[k] * f->size)
      : f->first + (long long)((double)k * (f->size - f->first) / f->nt);
    long long end = p + (long long)(l.len[k] * f->size);
    for (int j = k + 1; l.at[k] && j < f->nt; j++)
      if (need[j] && !f->have[j] && l.at[j] &&
          (long long)(l.at[j] * f->size) - end < 1 << 20)
        end = (long long)((l.at[j] + l.len[j]) * f->size);
    const char *e = tile(x, url, f, need, k, p, l.at[k] ? end - p : 0);
    if (e) return e;
  }
  pthread_mutex_lock(&lk);
  if ((g = learned(url, NULL)))
    for (int k = 0; k < f->nt; k++)
      if (f->at[k])
        g->at[k] = (double)f->at[k] / f->size,
        g->len[k] = (double)f->len[k] / f->size;
  pthread_mutex_unlock(&lk);
  return NULL;
}

typedef struct { const unsigned char *p; size_t n, i; } mem;
static OPJ_SIZE_T mr(void *d, OPJ_SIZE_T n, void *u) {
  mem *m = u;
  if (m->i >= m->n) return (OPJ_SIZE_T)-1;
  n = n < m->n - m->i ? n : m->n - m->i;
  memcpy(d, m->p + m->i, n);
  return m->i += n, n;
}
static OPJ_OFF_T ms(OPJ_OFF_T n, void *u) {
  mem *m = u;
  n = n < (OPJ_OFF_T)(m->n - m->i) ? n : (OPJ_OFF_T)(m->n - m->i);
  return m->i += n, n;
}
static OPJ_BOOL mk(OPJ_OFF_T n, void *u) {
  mem *m = u;
  return n <= (OPJ_OFF_T)m->n ? (m->i = n, 1) : 0;
}

// rows in flight and cores: a large decode with cores to spare, as when
// the last rows of a query run alone, spreads its code-blocks over them
static int busy, ncpu;

// decode window [x0,x1)×[y0,y1) of every component into out, comp-major
static const char *decode(const buf *s, OPJ_CODEC_FORMAT fmt, int x0, int y0,
                          int x1, int y1, int nc, unsigned short *out) {
  opj_codec_t *c = opj_create_decompress(fmt);
  opj_stream_t *st = opj_stream_default_create(1);
  opj_dparameters_t d;
  opj_image_t *im = NULL;
  mem m = {s->p, s->n, 0};
  opj_set_default_decoder_parameters(&d);
  opj_stream_set_user_data(st, &m, NULL);
  opj_stream_set_user_data_length(st, s->n);
  opj_stream_set_read_function(st, mr);
  opj_stream_set_skip_function(st, ms);
  opj_stream_set_seek_function(st, mk);
  int n = ncpu / MAX(__atomic_load_n(&busy, __ATOMIC_RELAXED), 1);
  int ok = opj_setup_decoder(c, &d) &&
           (n < 2 || (x1 - x0) * (y1 - y0) < 1 << 16 ||
            opj_codec_set_threads(c, n)) &&
           opj_read_header(st, c, &im) &&
           (int)im->numcomps >= nc &&
           opj_set_decode_area(c, im, x0, y0, x1, y1) &&
           opj_decode(c, st, im) && opj_end_decompress(c, st);
  for (int k = 0, n = (x1 - x0) * (y1 - y0); ok && k < nc; k++)
    if (im->comps[k].w * im->comps[k].h != (unsigned)n) ok = 0;
    else for (int i = 0; i < n; i++) out[k * n + i] = im->comps[k].data[i];
  opj_image_destroy(im), opj_stream_destroy(st), opj_destroy_codec(c);
  return ok ? NULL : "jp2 decode failed";
}

// tile k's pixels under image window [x0,x1)×[y0,y1), clipped to the tile,
// into out (row stride ow, origin ox0,oy0)
static const char *dec(ctx *x, band *f, int k, int x0, int y0, int x1, int y1,
                       unsigned short *out, int ow, int ox0, int oy0) {
  int tx = k % f->nx * f->tw, ty = k / f->nx * f->th;
  x0 = MAX(x0, tx), y0 = MAX(y0, ty);
  x1 = MIN(x1, tx + f->tw), y1 = MIN(y1, ty + f->th);
  if (x1 <= x0 || y1 <= y0) return NULL;
  x->s.n = 0, wr((char *)f->h.p, 1, f->h.n, &x->s);
  wr((char *)f->d.p + f->tp[k], 1, f->len[k], &x->s);
  wr("\xff\xd9", 1, 2, &x->s);
  x->px = realloc(x->px, (size_t)(x1 - x0) * (y1 - y0) * 2);
  const char *e = decode(&x->s, OPJ_CODEC_J2K, x0, y0, x1, y1, 1, x->px);
  for (int y = y0; !e && y < y1; y++)
    memcpy(out + (size_t)(y - oy0) * ow + x0 - ox0,
           x->px + (size_t)(y - y0) * (x1 - x0), (x1 - x0) * 2);
  return e;
}

static char *swap(const char *url, const char *from, const char *to) {
  const char *p = strstr(url, from);
  char *r = malloc(strlen(url) + strlen(to) + 1);
  if (!p) return free(r), NULL;
  sprintf(r, "%.*s%s", (int)(p - url), url, to);
  return r;
}

// one detection; x y is the peak pixel's centre in the box's UTM metres
typedef struct {
  double x, y, max, avg, b11, ratio, pk, rad;
  int px, sat;
} det;
typedef struct { double clear; det *d; int nd, cap; } res;
typedef struct { int k, x0, y0, x1, y1; } win;   // [x0,x1)×[y0,y1) of tile k

static int find(int *p, int i) {
  while (p[i] != i) i = p[i] = p[p[i]];
  return i;
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

// band g's values at the selected candidates (box pixel indices idx) into
// dst, decoded into the box-sized raster over windows: each component's box
// of them in each jp2 tile, merged while the union costs less than a second
// decode
static const char *side(ctx *x, const char *url, band *g, const band *f,
                        const int *idx, int mc, int *par, const char *sel,
                        int X0, int Y0, int W, unsigned short *raster,
                        unsigned short *dst) {
  int *bb = malloc((size_t)mc * 16), nw = 0;
  char need[256] = {0};
  const char *e = NULL;
  win *wn = NULL;
  for (int j = 0; j < mc; j++)
    bb[4 * j] = bb[4 * j + 1] = INT32_MAX, bb[4 * j + 2] = bb[4 * j + 3] = -1;
  for (int j = 0; j < mc; j++) {
    int *b = bb + 4 * find(par, j), gx = X0 + idx[j] % W, gy = Y0 + idx[j] / W;
    if (!sel[j]) continue;
    b[0] = MIN(b[0], gx), b[1] = MIN(b[1], gy);
    b[2] = MAX(b[2], gx + 1), b[3] = MAX(b[3], gy + 1);
  }
  for (int l = 0, cap = 0; l < mc; l++) {
    int *b = bb + 4 * l;
    if (b[2] < 0) continue;
    for (int ty = b[1] / f->th; ty <= (b[3] - 1) / f->th; ty++)
      for (int tx = b[0] / f->tw; tx <= (b[2] - 1) / f->tw; tx++) {
        if (nw == cap) wn = realloc(wn, (cap = 2 * cap + 16) * sizeof *wn);
        wn[nw++] = (win){ty * f->nx + tx, MAX(b[0], tx * f->tw),
                         MAX(b[1], ty * f->th), MIN(b[2], tx * f->tw + f->tw),
                         MIN(b[3], ty * f->th + f->th)};
      }
  }
  free(bb);
  for (int i = 0; i < nw; i++)
    for (int j = i + 1; j < nw; j++) {
      win *a = &wn[i], *b = &wn[j];
      win v = {a->k, MIN(a->x0, b->x0), MIN(a->y0, b->y0), MAX(a->x1, b->x1),
               MAX(a->y1, b->y1)};
      if (a->k != b->k || area(&v) > area(a) + area(b) + FIXED) continue;
      *a = v, wn[j] = wn[--nw], j = i;   // and look again from i
    }
  for (int i = 0; i < nw; i++) need[wn[i].k] = 1;
  if (nw && !(e = header(x, url, g)) &&
      (g->w != f->w || g->h_ != f->h_ || g->tw != f->tw || g->ox != f->ox ||
       g->oy != f->oy))
    e = "bands on different grids";
  if (nw && !e) e = parts(x, url, g, need);
  for (int i = 0; i < nw && !e; i++)
    e = dec(x, g, wn[i].k, wn[i].x0, wn[i].y0, wn[i].x1, wn[i].y1, raster, W,
            X0, Y0);
  for (int j = 0; j < mc && !e; j++)
    if (sel[j]) dst[j] = raster[idx[j]];
  free(wn), drop(&g->d);
  return e;
}

// one job: the flares in a box of one scene, and its clear-sky share
static const char *run(ctx *x, const char *url, const double *box,
                       const double *t, res *r) {
  band *f = x->bd;
  const char *nb = strstr(url, "_N"), *e = NULL;
  r->nd = 0, r->clear = NAN;
  if (!nb || atoi(nb + 2) < 400) return "needs baseline N0400 or later";
  char *u[3] = {swap(url, "B12.jp2", "B11.jp2"),
                swap(url, "B12.jp2", "B8A.jp2"),
                swap(url, "/IMG_DATA/", "/QI_DATA/MSK_CLASSI_B00.jp2")};
  unsigned short *b12 = NULL, *m = NULL, *v12 = NULL, *v11 = NULL,
                 *v8a = NULL;
  int *cnt = NULL, *cld = NULL, *idx = NULL, *par = NULL, *pq = NULL;
  double *ct = NULL, *bgm = NULL;
  char need[256] = {0}, *ok = NULL, *sel = NULL;
  int X0, Y0, X1, Y1, W, H, mc = 0;
  if (!u[0] || !u[1] || !u[2]) { e = "b12 url not in SAFE form"; goto out; }
  if ((e = header(x, url, f))) goto out;
  {
    double v[4] = {floor((box[0] - f->ox) / f->res),
                   floor((f->oy - box[3]) / f->res),
                   ceil((box[2] - f->ox) / f->res),
                   ceil((f->oy - box[1]) / f->res)};
    int lim[4] = {f->w, f->h_, f->w, f->h_}, p[4];
    for (int i = 0; i < 4; i++)
      p[i] = v[i] < 0 ? 0 : v[i] > lim[i] ? lim[i] : v[i];
    X0 = p[0], Y0 = p[1], X1 = p[2], Y1 = p[3], W = X1 - X0, H = Y1 - Y0;
  }
  if (W <= 0 || H <= 0) goto out;   // the box misses this tile

  // the 60 m mask, whole (a few KB): opaque cloud and cirrus layers
  char key[4200];
  long long aux;
  int cx0 = X0 / 3, cy0 = Y0 / 3, cw = (X1 + 2) / 3 - cx0;
  int ch = (Y1 + 2) / 3 - cy0;
  snprintf(key, sizeof key, "%s#c", u[2]);
  if (!recall(key, &x->s, &aux)) {
    if ((e = get(x->c, u[2], 0, -1, &x->s))) goto out;
    keep(key, &x->s, 0);
  }
  m = malloc((size_t)2 * cw * ch * 2);
  if ((e = decode(&x->s, OPJ_CODEC_JP2, cx0, cy0, cx0 + cw, cy0 + ch, 2, m)))
    goto out;
#define CLOUDY(row, col)                                                    \
  (m[((Y0 + (row)) / 3 - cy0) * cw + (X0 + (col)) / 3 - cx0] ||            \
   m[cw * ch + ((Y0 + (row)) / 3 - cy0) * cw + (X0 + (col)) / 3 - cx0])

  // background cells, cloud first: each jp2 tile is decoded over the
  // bounding box of its clear cells, and one with none is never fetched
  int gx0 = X0 / CELL, gy0 = Y0 / CELL, ncx = (X1 - 1) / CELL - gx0 + 1;
  int nc = ncx * ((Y1 - 1) / CELL - gy0 + 1), seen = W * H, clear = 0;
  int tb[256][4];
  cnt = calloc(nc, sizeof *cnt), cld = calloc(nc, sizeof *cld);
  ct = malloc(nc * sizeof *ct), bgm = malloc(nc * sizeof *bgm);
  for (int y = Y0; y < Y1; y++) {
    unsigned short *m0 = m + (y / 3 - cy0) * cw, *m1 = m0 + cw * ch;
    int *cn = cnt + (y / CELL - gy0) * ncx, *cd = cld + (cn - cnt);
    for (int xx = X0; xx < X1; xx++) {
      int cl = m0[xx / 3 - cx0] || m1[xx / 3 - cx0];
      cn[xx / CELL - gx0]++, cd[xx / CELL - gx0] += cl, clear += !cl;
    }
  }
  for (int c = 0; c < nc; c++) {
    int gx = gx0 + c % ncx, gy = gy0 + c / ncx, *b;
    int k = gy * CELL / f->th * f->nx + gx * CELL / f->tw;
    int x0 = MAX(gx * CELL, X0), y0 = MAX(gy * CELL, Y0);
    int x1 = MIN(gx * CELL + CELL, X1), y1 = MIN(gy * CELL + CELL, Y1);
    if (cld[c] > t[MAXCLOUD] * cnt[c]) continue;
    b = tb[k];
    if (!need[k]) b[0] = x0, b[1] = y0, b[2] = x1, b[3] = y1, need[k] = 1;
    b[0] = MIN(b[0], x0), b[1] = MIN(b[1], y0);
    b[2] = MAX(b[2], x1), b[3] = MAX(b[3], y1);
  }
  b12 = calloc((size_t)W * H, 2);
  if ((e = parts(x, url, f, need))) goto out;
  for (int k = 0; k < f->nt; k++)
    if (need[k] && (e = dec(x, f, k, tb[k][0], tb[k][1], tb[k][2], tb[k][3],
                            b12, W, X0, Y0)))
      goto out;
  drop(&f->d);

  // per cell: no data counts as obscured; the median of the dim pixels
  // (below b12_min) is the background, from a histogram of their counts
  int cut = (int)ceil(1000 + t[B12MIN] * 10000), *hist = calloc(cut, 4);
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
        if (!dn) nd++, ndc += !CLOUDY(r0, c0);
        else if (dn < cut && cal(dn) < t[B12MIN]) hist[dn]++, nbg++;
      }
    seen -= nd, clear -= ndc;
    if (cld[c] + ndc > t[MAXCLOUD] * cnt[c] || nbg < 10) continue;
    int i = 0;
    for (int s = 0; (s += hist[i]) <= nbg / 2; i++);
    double med = bgm[c] = cal(i);
    ct[c] = (med > t[BGFLOOR] ? med : t[BGFLOOR]) * t[CONTRAST];
  }
  free(hist);
  if (seen > 0) r->clear = (double)clear / seen;

  // candidates: b12 alone passes (above b12_min and the cell's contrast),
  // in raster order. the spectral mask is a subset, and a detection needs
  // a peak of peak_b12_min, so a box without one is done
  int hot = 0, cap = 0;
  for (int r0 = 0; r0 < H; r0++)
    for (int c0 = 0; c0 < W; c0++) {
      double v = cal(b12[(size_t)r0 * W + c0]);
      int c = ((Y0 + r0) / CELL - gy0) * ncx + (X0 + c0) / CELL - gx0;
      if (v <= t[B12MIN] || v <= ct[c]) continue;
      if (mc == cap) idx = realloc(idx, (cap = cap ? 2 * cap : 256) * 4);
      idx[mc++] = r0 * W + c0, hot |= v >= t[PEAKMIN];
    }
  if (!hot) goto out;
  v12 = malloc(mc * 2);
  for (int j = 0; j < mc; j++) v12[j] = b12[idx[j]];
#define V(j) cal(v12[j])

  // components of the candidates; only those holding a possible peak need
  // b11. a component can hold a detection only if one pixel is both a
  // possible peak and bright in b11, and b8a then decides those of its
  // pixels that saturation does not
  par = malloc(mc * 4), ok = calloc(mc, 1), sel = malloc(mc);
  v11 = calloc(mc, 2), v8a = calloc(mc, 2);
  for (int j = 0; j < mc; j++) {
    int i = idx[j], n;
    par[j] = j;
    if (i % W && j && idx[j - 1] == i - 1) par[find(par, j)] = find(par, j - 1);
    if (i >= W && (n = at(idx, j, i - W)) >= 0)
      par[find(par, j)] = find(par, n);
  }
  for (int j = 0; j < mc; j++)
    if (V(j) >= t[PEAKMIN]) ok[find(par, j)] = 1;
  for (int j = 0; j < mc; j++) sel[j] = ok[find(par, j)];
  if ((e = side(x, u[0], x->bd + 1, f, idx, mc, par, sel, X0, Y0, W, b12,
                v11)))
    goto out;
  memset(ok, 0, mc);
  for (int j = 0; j < mc; j++)
    if (sel[j] && V(j) >= t[PEAKMIN] && cal(v11[j]) > t[B11MIN])
      ok[find(par, j)] = 1;
  for (int j = 0; j < mc; j++)
    sel[j] = sel[j] && ok[find(par, j)] && cal(v11[j]) > t[B11MIN];
  for (int j = 0; j < mc; j++)
    ok[j] = sel[j] && cal(v11[j]) <= t[SAT] && V(j) <= t[SAT];
  if ((e = side(x, u[1], x->bd + 2, f, idx, mc, par, ok, X0, Y0, W, b12,
                v8a)))
    goto out;

  // the spectral mask, its components, and per component the count, the sum
  // and the lowest-index peak
  for (int j = 0; j < mc; j++) {
    double a = cal(v11[j]), c = cal(v8a[j]);
    ok[j] = sel[j] && (!ok[j] || (a + c > .01 && a > c));
  }
  for (int j = 0; j < mc; j++) {
    int i = idx[j], n;
    par[j] = j;
    if (!ok[j]) continue;
    if (i % W && j && idx[j - 1] == i - 1 && ok[j - 1])
      par[find(par, j)] = find(par, j - 1);
    if (i >= W && (n = at(idx, j, i - W)) >= 0 && ok[n])
      par[find(par, j)] = find(par, n);
  }
  int *n_ = calloc(mc, 4), *pk = malloc(mc * 4);
  double *sum = calloc(mc, 8);
  char *vis = calloc(mc, 1);
  pq = malloc(mc * 4);
  for (int j = 0; j < mc; j++) {
    if (!ok[j]) continue;
    int l = find(par, j);
    if (!n_[l]++ || V(j) > V(pk[l])) pk[l] = j;
    sum[l] += V(j);
  }
  for (int l = 0; l < mc; l++) {
    if (!n_[l]) continue;
    double np = n_[l], p = V(pk[l]), avg = sum[l] / np;
    if (np > t[MAXPX] || p < t[PEAKMIN]) continue;
    if (np > t[LARGEPX] && p < t[LARGEMIN]) continue;
    if (n_[l] > 1 && p < t[PEAKED] * avg && avg < t[SAT]) continue;
    if (n_[l] == 1 && p < t[SINGLE]) continue;
    // the hot core: contiguous from the peak within this component, above
    // max(peak·warm_fraction, hot_floor), capped at warm_max_pixels
    // and its integrated excess radiance, Σ(b12 − the cell's background)
    int pi = idx[pk[l]], hd = 0, tl = 1, size = 0;
    double th = p * t[WARMF] > t[HOT] ? p * t[WARMF] : t[HOT], rad = 0;
    double bg = bgm[((Y0 + pi / W) / CELL - gy0) * ncx +
                    (X0 + pi % W) / CELL - gx0];
    vis[pq[0] = pk[l]] = 1;
    while (hd < tl) {
      int j = pq[hd++], i = idx[j], nb4[4], k = 0;
      size++, rad += V(j) > bg ? V(j) - bg : 0;
      if (size > t[WARMMAX]) break;
      if (i >= W) nb4[k++] = at(idx, mc, i - W);
      if (i + W < W * H) nb4[k++] = at(idx, mc, i + W);
      if (i % W) nb4[k++] = j > 0 && idx[j - 1] == i - 1 ? j - 1 : -1;
      if ((i + 1) % W) nb4[k++] = j + 1 < mc && idx[j + 1] == i + 1 ? j + 1
                                                                    : -1;
      for (int z = 0; z < k; z++) {
        int q = nb4[z];
        if (q >= 0 && !vis[q] && ok[q] && find(par, q) == l && V(q) > th)
          vis[pq[tl++] = q] = 1;
      }
    }
    for (int z = 0; z < tl; z++) vis[pq[z]] = 0;
    if (size > t[WARMMAX]) continue;
    double a = cal(v11[pk[l]]);
    if (r->nd == r->cap) r->d = realloc(r->d, (r->cap = 2 * r->cap + 8) *
                                                  sizeof *r->d);
    r->d[r->nd++] = (det){f->ox + (X0 + pi % W + .5) * f->res,
                          f->oy - (Y0 + pi / W + .5) * f->res, p, avg, a,
                          a > 1e-6 ? p / a : INFINITY, p / avg, rad, size,
                          p >= t[SAT]};
  }
  free(n_), free(pk), free(sum), free(vis);
out:
  free(u[0]), free(u[1]), free(u[2]), free(b12), free(m), free(v12);
  free(v11), free(v8a), free(cnt), free(cld), free(idx), free(par), free(pq);
  free(ct), free(bgm), free(ok), free(sel);
  // a whole codestream is tens of MB: nothing outlives the band's use
  for (int i = 0; i < 3; i++) drop(&x->bd[i].d);
  drop(&x->b), drop(&x->s);
  return e;
}

// a pool of workers, each with its own connection, running queued rows
typedef struct row {
  struct row *next;
  char *url;
  double box[4], th[NT];
  res r;
  const char *e;
  int *left;
  pthread_mutex_t *m;
  pthread_cond_t *c;
} row;
static row *qh, *qt;
static pthread_mutex_t qm = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t qc = PTHREAD_COND_INITIALIZER;

static void *worker(void *_) {
  ctx x = {0};
  const char *id = getenv("AWS_ACCESS_KEY_ID"),
             *secret = getenv("AWS_SECRET_ACCESS_KEY"),
             *region = getenv("AWS_REGION");
  char sig[64], *cred = NULL;
  (void)_;
  x.c = curl_easy_init();
  snprintf(sig, sizeof sig, "aws:amz:%s:s3", region ? region : "us-east-1");
  if (id && secret && asprintf(&cred, "%s:%s", id, secret) > 0) {
    curl_easy_setopt(x.c, CURLOPT_AWS_SIGV4, sig);
    curl_easy_setopt(x.c, CURLOPT_USERPWD, cred);
  }
  // openssl 3 parses a whole CA bundle per connection, ~30 ms of a core;
  // debian's hashed directory is read lazily, one certificate per chain
  if (!access("/etc/ssl/certs/ca-certificates.crt", R_OK))
    curl_easy_setopt(x.c, CURLOPT_CAINFO, NULL),
    curl_easy_setopt(x.c, CURLOPT_CAPATH, "/etc/ssl/certs");
  curl_easy_setopt(x.c, CURLOPT_WRITEFUNCTION, wr);
  curl_easy_setopt(x.c, CURLOPT_HEADERFUNCTION, hd);
  curl_easy_setopt(x.c, CURLOPT_CONNECTTIMEOUT, 15L);
  curl_easy_setopt(x.c, CURLOPT_LOW_SPEED_LIMIT, 1024L);   // a stalled
  curl_easy_setopt(x.c, CURLOPT_LOW_SPEED_TIME, 30L);      // read retries
  for (;;) {
    pthread_mutex_lock(&qm);
    while (!qh) pthread_cond_wait(&qc, &qm);
    row *w = qh;
    if (!(qh = w->next)) qt = NULL;
    pthread_mutex_unlock(&qm);
    __atomic_add_fetch(&busy, 1, __ATOMIC_RELAXED);
    w->e = w->e ? w->e : run(&x, w->url, w->box, w->th, &w->r);
    __atomic_sub_fetch(&busy, 1, __ATOMIC_RELAXED);
    pthread_mutex_lock(w->m);
    if (!--*w->left) pthread_cond_signal(w->c);
    pthread_mutex_unlock(w->m);
  }
  return NULL;
}

// BURNOFF_THREADS workers, by default four per core: decoding is the cost,
// and more rows in flight only hold more memory
static void init(void) {
  const char *n = getenv("BURNOFF_THREADS");
  int jobs = n ? atoi(n) : 4 * (ncpu = sysconf(_SC_NPROCESSORS_ONLN));
  pthread_t th;
  curl_global_init(CURL_GLOBAL_ALL);
  for (int i = 0; i < MAX(jobs, 1); i++)
    pthread_create(&th, NULL, worker, NULL), pthread_detach(th);
}

static int valid(duckdb_vector v, idx_t i) {
  uint64_t *m = duckdb_vector_get_validity(v);
  return !m || duckdb_validity_row_is_valid(m, i);
}

static char *str(duckdb_vector v, idx_t i) {
  duckdb_string_t *s = (duckdb_string_t *)duckdb_vector_get_data(v) + i;
  return strndup(duckdb_string_t_data(s), duckdb_string_t_length(*s));
}

static void s2_flares(duckdb_function_info info, duckdb_data_chunk in,
                      duckdb_vector out) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  idx_t n = duckdb_data_chunk_get_size(in), cols =
    duckdb_data_chunk_get_column_count(in), total = 0;
  duckdb_vector v[6];
  row *rs = calloc(n ? n : 1, sizeof *rs);
  int left = 0;
  pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t c = PTHREAD_COND_INITIALIZER;
  (void)info;
  pthread_once(&once, init);
  for (idx_t k = 0; k < cols; k++) v[k] = duckdb_data_chunk_get_vector(in, k);
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    int null = 0;
    for (idx_t k = 0; k < 5; k++) null |= !valid(v[k], i);
    if (null) continue;
    w->url = str(v[0], i);
    for (int k = 0; k < 4; k++)
      w->box[k] = ((double *)duckdb_vector_get_data(v[k + 1]))[i];
    memcpy(w->th, TD, sizeof w->th);
    if (cols > 5 && valid(v[5], i)) {
      char *p = str(v[5], i);
      w->e = params(p, w->th);
      free(p);
    }
    if (!w->e && (w->box[2] <= w->box[0] || w->box[3] <= w->box[1]))
      w->e = "empty box";
    w->left = &left, w->m = &m, w->c = &c, left++;
  }
  pthread_mutex_lock(&qm);
  for (idx_t i = 0; i < n; i++)
    if (rs[i].url) {
      if (qt) qt->next = &rs[i]; else qh = &rs[i];
      qt = &rs[i];
    }
  pthread_cond_broadcast(&qc);
  pthread_mutex_unlock(&qm);
  pthread_mutex_lock(&m);
  while (left) pthread_cond_wait(&c, &m);
  pthread_mutex_unlock(&m);

  // clear, error and the flares list; a null input row is a null result
  duckdb_vector vc = duckdb_struct_vector_get_child(out, 0),
                ve = duckdb_struct_vector_get_child(out, 1),
                vl = duckdb_struct_vector_get_child(out, 2);
  duckdb_vector_ensure_validity_writable(out);
  duckdb_vector_ensure_validity_writable(vc);
  duckdb_vector_ensure_validity_writable(ve);
  duckdb_vector_ensure_validity_writable(vl);
  uint64_t *mo = duckdb_vector_get_validity(out),
           *mc = duckdb_vector_get_validity(vc),
           *me = duckdb_vector_get_validity(ve),
           *ml = duckdb_vector_get_validity(vl);
  for (idx_t i = 0; i < n; i++) total += rs[i].e ? 0 : rs[i].r.nd;
  duckdb_list_vector_reserve(vl, total);
  duckdb_list_vector_set_size(vl, total);
  duckdb_vector f = duckdb_list_vector_get_child(vl), fc[10];
  for (int k = 0; k < 10; k++) fc[k] = duckdb_struct_vector_get_child(f, k);
  duckdb_list_entry *le = duckdb_vector_get_data(vl);
  double *clear = duckdb_vector_get_data(vc), *d[8];
  int *px = duckdb_vector_get_data(fc[7]);
  bool *sat = duckdb_vector_get_data(fc[9]);
  int dk[8] = {0, 1, 2, 3, 4, 5, 6, 8};
  for (int k = 0; k < 8; k++) d[k] = duckdb_vector_get_data(fc[dk[k]]);
  idx_t o = 0;
  for (idx_t i = 0; i < n; i++) {
    row *w = &rs[i];
    le[i] = (duckdb_list_entry){o, 0};
    if (!w->url) {
      duckdb_validity_set_row_invalid(mo, i);
      continue;
    }
    if (isnan(w->r.clear)) duckdb_validity_set_row_invalid(mc, i);
    else clear[i] = w->r.clear;
    if (w->e) duckdb_vector_assign_string_element(ve, i, w->e);
    else duckdb_validity_set_row_invalid(me, i);
    if (w->e) duckdb_validity_set_row_invalid(ml, i);
    for (int j = 0; !w->e && j < w->r.nd; j++, o++) {
      det *x = &w->r.d[j];
      double vals[8] = {x->x, x->y, x->max, x->avg, x->b11, x->ratio, x->pk,
                        x->rad};
      for (int k = 0; k < 8; k++) d[k][o] = vals[k];
      px[o] = x->px, sat[o] = x->sat;
    }
    le[i].length = o - le[i].offset;
    free(w->url), free(w->r.d);
  }
  free(rs);
}

static duckdb_logical_type type(duckdb_type t) {
  return duckdb_create_logical_type(t);
}

// burnoff.sql, as a string literal made by make
static const char *macros =
#include "burnoff.sql.h"
;

DUCKDB_EXTENSION_ENTRYPOINT(duckdb_connection con, duckdb_extension_info info,
                            struct duckdb_extension_access *access) {
  const char *fn[] = {"x", "y", "max_b12", "avg_b12", "peak_b11", "ratio",
                      "peakedness", "pixels", "radiance", "saturated"};
  const char *sn[] = {"clear", "error", "flares"};
  duckdb_logical_type ft[10], st[3], dbl = type(DUCKDB_TYPE_DOUBLE),
                      vc = type(DUCKDB_TYPE_VARCHAR);
  for (int k = 0; k < 10; k++)
    ft[k] = type(k == 7 ? DUCKDB_TYPE_INTEGER
                 : k == 9 ? DUCKDB_TYPE_BOOLEAN : DUCKDB_TYPE_DOUBLE);
  duckdb_logical_type fs = duckdb_create_struct_type(ft, fn, 10);
  st[0] = dbl, st[1] = vc, st[2] = duckdb_create_list_type(fs);
  duckdb_logical_type ret = duckdb_create_struct_type(st, sn, 3);
  duckdb_scalar_function_set set = duckdb_create_scalar_function_set(
    "s2_flares");
  for (int extra = 0; extra < 2; extra++) {
    duckdb_scalar_function f = duckdb_create_scalar_function();
    duckdb_scalar_function_set_name(f, "s2_flares");
    duckdb_scalar_function_add_parameter(f, vc);
    for (int k = 0; k < 4; k++) duckdb_scalar_function_add_parameter(f, dbl);
    if (extra) duckdb_scalar_function_add_parameter(f, vc);
    duckdb_scalar_function_set_return_type(f, ret);
    duckdb_scalar_function_set_special_handling(f);   // nulls are ours
    duckdb_scalar_function_set_volatile(f);   // one evaluation per row
    duckdb_scalar_function_set_function(f, s2_flares);
    duckdb_add_scalar_function_to_set(set, f);
    duckdb_destroy_scalar_function(&f);
  }
  duckdb_state ok = duckdb_register_scalar_function_set(con, set);
  duckdb_destroy_scalar_function_set(&set);
  for (int k = 0; k < 10; k++) duckdb_destroy_logical_type(&ft[k]);
  duckdb_destroy_logical_type(&fs), duckdb_destroy_logical_type(&st[2]);
  duckdb_destroy_logical_type(&ret), duckdb_destroy_logical_type(&dbl);
  duckdb_destroy_logical_type(&vc);
  if (ok == DuckDBSuccess) ok = duckdb_query(con, macros, NULL);
  if (ok == DuckDBError) access->set_error(info, "could not register");
  return ok == DuckDBSuccess;
}
