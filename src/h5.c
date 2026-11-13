// h5: burnoff's hdf5 reader, for the netcdf-4 files of a sentinel-3 slstr
// granule and nothing else: a 2-d variable, chunked under a one-leaf v1
// b-tree, deflated and perhaps shuffled, found by its hard link in the
// file's head and described by a v2 object header. it parses bytes its
// caller has read and says how many more it needs; anything else is
// refused. a chunk is inflated into the job's memory (mem.c).
#include <limits.h>
#include <zlib.h>

#define TREE3 2616    // a v1 b-tree node of chunks, 2-d, k = 32

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

// a netcdf-4 variable: shape, chunks, element type and packing, and each
// chunk's place in the file and origin in the array
typedef struct {
  long long bt, hp;
  int h, w, ch, cw, es, sg, fl, sh, nk, ok;
  double sc, of, fill;
  long long ka[64];
  int kn[64], kr[64], kc[64];
} var;

// an attribute message's value, if it is named nm: v1 pads its parts to 8
// bytes, v2 does not, v3 adds an encoding byte
static int attr(const unsigned char *a, const unsigned char *end,
                const char *nm, double *x) {
  if (end - a < 8) return 0;
  int v = a[0], ns = le(a + 2, 2), ts = le(a + 4, 2), ss = le(a + 6, 2);
  int head = v == 3 ? 9 : 8;
  if (v < 1 || v > 3 || end - a < head + ns ||
      strlen(nm) + 1 != (size_t)ns || memcmp(a + head, nm, ns)) return 0;
  int tn = v == 1 ? (ns + 7) & ~7 : ns,
      sn = v == 1 ? (ts + 7) & ~7 : ts,
      dn = v == 1 ? (ss + 7) & ~7 : ss;
  if (ts < 8 || end - a < head + tn + sn + dn) return 0;
  const unsigned char *t = a + head + tn, *d = t + sn + dn;
  int c = t[0] & 15, sz = le(t + 4, 4);
  if (sz < 1 || sz > 8 || end - d < sz || c > 1 ||
      (c && sz != 4 && sz != 8)) return 0;
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
  size_t n = e - d;
  if (t == 1) {   // dataspace
    if (n < 4) return "short dataspace";
    int k = d[0] == 1 ? 8 : 4;
    if (d[0] < 1 || d[0] > 2 || d[1] != 2) return "not a 2-d variable";
    if (n < (size_t)k + 16) return "short dataspace";
    long long h = le(d + k, 8), w = le(d + k + 8, 8);
    if (h <= 0 || w <= 0 || h > INT_MAX || w > INT_MAX)
      return "invalid variable dimensions";
    v->h = h, v->w = w;
  } else if (t == 3) {   // datatype
    if (n < 8) return "short datatype";
    v->fl = (d[0] & 15) == 1, v->sg = d[1] & 8, v->es = le(d + 4, 4);
    if ((d[0] & 15) > 1 || v->es < 1 || v->es > 8 ||
        (v->fl && v->es != 4 && v->es != 8)) return "not a supported number";
  } else if (t == 8) {   // layout: v3, chunked, a v1 b-tree
    if (n < 19) return "short layout";
    if (d[0] != 3 || d[1] != 2 || d[2] != 3) return "not chunked";
    v->bt = le(d + 3, 8), v->ch = le(d + 11, 4), v->cw = le(d + 15, 4);
    if (v->bt < 0 || v->ch <= 0 || v->cw <= 0) return "invalid chunk layout";
  } else if (t == 11) {   // filters: shuffle and deflate alone
    if (n < 2) return "short filters";
    int ver = d[0], o = ver == 1 ? 8 : 2;
    if (ver < 1 || ver > 2) return "unknown filter version";
    if (n < (size_t)o) return "short filters";
    for (int f = 0; f < d[1]; f++) {
      if (n - o < 6) return "short filter";
      int id = le(d + o, 2), nm = ver == 1 || id >= 256;
      if (nm && n - o < 8) return "short filter";
      int nl = nm ? le(d + o + 2, 2) : 0,
          nv = le(d + o + (nm ? 6 : 4), 2);
      o += ver == 1 ? 8 + ((nl + 7) & ~7) + ((4 * nv + 7) & ~7)
                    : (nm ? 8 : 6) + nl + 4 * nv;
      if ((size_t)o > n) return "short filter values";
      if (id == 2) v->sh = 1;
      else if (id != 1) return "an unknown filter";
    }
  } else if (t == 12) {
    if (n < 8) return "short attribute";
    int ver = d[0], head = ver == 3 ? 9 : 8;
    if (ver < 1 || ver > 3) return "unknown attribute version";
    for (int k = 2; k < 8; k += 2) {
      int size = le(d + k, 2);
      head += ver == 1 ? (size + 7) & ~7 : size;
    }
    if (n < (size_t)head) return "short attribute";
    pack(d, e, v);
  } else if (t == 21) {   // dense attributes
    if (n < 2 || n < (size_t)(10 + (d[1] & 1 ? 2 : 0)))
      return "short attribute info";
    v->hp = le(d + 2 + (d[1] & 1 ? 2 : 0), 8);
  }
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
    if (q[b] < 0 || q[b + 1] < q[b] || q[b + 1] > (1ll << 40))
      return *e = "invalid object header size", -1;
    if (q[b + 1] + 4 > (long long)n) return q[b + 1] + 4096;
    for (long long k = q[b]; k + (fl & 4 ? 6 : 4) <= q[b + 1];) {
      int t = p[k], s = le(p + k + 1, 2);
      k += 4 + (fl & 4 ? 2 : 0);
      if (k + s > q[b + 1]) return *e = "short object message", -1;
      if (t == 16) {   // a continuation: OCHK, messages, checksum
        if (s != 16 || nq == 16) return *e = "invalid header continuation", -1;
        long long at = le(p + k, 8), len = le(p + k + 8, 8);
        if (at < 0 || at > (1ll << 40) || len < 8 || len > (1ll << 30))
          return *e = "invalid header continuation", -1;
        q[nq] = at + 4, q[nq + 1] = at + len - 4, nq += 2;
      }
      if ((*e = msg(t, p + k, p + k + s, v))) return -1;
      k += s;
    }
  }
  // more attributes than fit lie in a fractal heap of one direct block
  if (v->hp > 0) {   // all ones: none
    long long a = v->hp, r, z;
    if (a > (1ll << 40)) return *e = "invalid attribute heap", -1;
    if (a + 160 > (long long)n) return a + 4096;
    if (memcmp(p + a, "FRHP", 4) || le(p + a + 140, 2))
      return *e = "attributes in an indirect heap", -1;
    r = le(p + a + 132, 8), z = le(p + a + 112, 8);
    if (r < 0 || r > (1ll << 40) || z < 0 || z > (1ll << 30))
      return *e = "invalid attribute heap", -1;
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


// chunk i of v from its bytes z, inflated and unshuffled, or NULL
static unsigned char *h5chunk(const var *v, int i, const unsigned char *z) {
  uLongf n = (uLongf)v->ch * v->cw * v->es, m = n / v->es;
  unsigned char *a = mem(n), *b = a;
  if (uncompress(a, &n, z, v->kn[i]) != Z_OK || n != m * v->es)
    return unmem(a), NULL;
  if (v->sh) {   // byte k of every element, then byte k + 1
    b = mem(n);
    for (size_t q = 0; q < m; q++)
      for (int c = 0; c < v->es; c++) b[q * v->es + c] = a[c * m + q];
    unmem(a);
  }
  return b;
}

// the element at s, and as it is stored in *u (0 for a float)
static double h5num(const var *v, const unsigned char *s, long long *u) {
  *u = v->fl ? 0 : le(s, v->es);
  return v->fl ? real(s, v->es)
       : v->sg && v->es < 8 && *u >> (8 * v->es - 1)
         ? *u - (1ll << 8 * v->es) : *u;
}
