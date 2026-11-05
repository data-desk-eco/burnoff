// burnoff's shared DuckDB and curl host. Each detector owns its jobs.
#include "burnoff.h"
#include <curl/curl.h>
#include <errno.h>
#include <limits.h>

// "name=value,name=value" over t
const char *params(const char *s, double *t, const char **tk,
                   int nt) {
  while (s && *s) {
    const char *eq = strchr(s, '='), *end = strchr(s, ',');
    int k = 0;
    if (!eq || (end && eq > end)) return "expected name=value";
    while (k < nt && (strlen(tk[k]) != (size_t)(eq - s) ||
                      strncmp(tk[k], s, eq - s)))
      k++;
    if (k == nt) return "unknown threshold";
    char *stop;
    errno = 0;
    double v = strtod(eq + 1, &stop);
    if (stop == eq + 1 || stop != (end ? end : s + strlen(s)) ||
        errno == ERANGE || !isfinite(v)) return "invalid threshold value";
    if (end && !end[1]) return "expected name=value";
    t[k] = v;
    s = end ? end + 1 : NULL;
  }
  return NULL;
}

void append(buf *b, const void *p, size_t n) {
  if (b->n + n > b->cap)
    b->p = realloc(b->p, b->cap = 2 * (b->n + n));
  memcpy(b->p + b->n, p, n);
  b->n += n;
}

static size_t wr(char *d, size_t s, size_t n, void *u) {
  append(u, d, s * n);
  return s * n;
}

void drop(buf *b) { free(b->p), *b = (buf){0}; }

static size_t hd(char *d, size_t s, size_t n, void *u) {
  buf *b = u;
  char *slash = memchr(d, '/', s * n);
  if (!strncasecmp(d, "content-range:", 14) && slash)
    b->size = atoll(slash + 1);
  if (!strncasecmp(d, "x-ratelimit-reset:", 18)) b->wait = atoi(d + 18);
  if (!strncasecmp(d, "retry-after:", 12)) b->wait = atoi(d + 12);
  return s * n;
}

// the http url of an s3://, gs:// or other url
static void href(const char *url, char *u) {
  const char *s3 = getenv("AWS_S3_ENDPOINT");
  if (!strncmp(url, "s3://", 5))
    snprintf(u, 4096, "https://%s/%s",
             s3 ? s3 : "eodata.dataspace.copernicus.eu", url + 5);
  else if (strncmp(url, "gs://", 5)) snprintf(u, 4096, "%s", url);
  else {   // google's json api, which also answers cross-origin reads
    const char *b = url + 5, *o = strchr(b, '/');
    int k = snprintf(u, 4096, "https://storage.googleapis.com/download/"
                     "storage/v1/b/%.*s/o/", o ? (int)(o - b) : 0, b);
    for (o = o ? o + 1 : ""; *o && k < 4000; o++)
      k += *o == '/' ? sprintf(u + k, "%%2F") : (u[k] = *o, 1);
    snprintf(u + k, 4096 - k, "?alt=media");
  }
}

// a range past the end is PAST, which eodata answers with a 404 rather than
// a 416; a stage that lacks a read gives LACK, one that is done early FIN
const char PAST[] = "range past the end of the file", LACK[] = "",
                  FIN[] = "";

// one answer to r, its body in r->b, e a failure to connect: done, an
// error, or r->wait seconds before it is made again. transient failures
// (network errors, 429, 5xx) retry: a 429 after the wait it names, as
// eodata allows 5000 requests a minute for each key, and the rest with a
// backoff, as cdse sheds load with 503s
static void check(rd *r, int e, long code) {
  buf *b = &r->b;
  // a body short of its range retries as a 5xx does
  if (!e && code == 206 && b->size > 0 &&
      r->lo + (long long)b->n < (r->hi < 0 ? b->size : MIN(r->hi, b->size)))
    code = 500;
  if (!e && (code == 416 || (code == 404 && r->lo))) r->e = PAST;
  else if (!e && code < 400) {
    if (code == 200 && r->hi > -2) r->lo = 0, r->hi = -1;   // range ignored
    if (b->size < 0 && r->hi == -1) b->size = r->lo + b->n;
    r->ok = 1;
  } else if (!e && code != 429 && code < 500) r->e = "http error";
  else if (++r->tries == 8) r->e = "fetch failed after retries";
  else r->wait = code == 429 && b->wait > 0 ? MIN(b->wait, 60)
                                            : 1 << MIN(r->tries - 1, 5);
}

// the read in hand that holds [lo, hi) of url
rd *got(job *j, const char *url, long long lo, long long hi) {
  for (rd *r = j->rq; r < j->rq + j->nr; r++)
    if (r->ok && r->lo <= lo &&
        (hi < 0 ? r->hi == hi : hi <= r->lo + (long long)r->b.n) &&
        !strcmp(r->url, url))
      return r;
  return NULL;
}

// r made whole: [wl, wh) from its answer and the reads in hand before it
static void fill(job *j, rd *r) {
  unsigned char *p = malloc(r->wh - r->wl);
  long long size = r->b.size;
  for (rd *q = j->rq; q <= r; q++) {
    long long a = MAX(q->lo, r->wl), b = MIN(q->lo + (long long)q->b.n, r->wh);
    if (q->ok && b > a && !strcmp(q->url, r->url))
      memcpy(p + a - r->wl, q->b.p + a - q->lo, b - a),
      size = MAX(size, q->b.size);
  }
  free(r->b.p), r->b = (buf){p, r->wh - r->wl, r->wh - r->wl, size, 0};
  r->lo = r->wl, r->hi = r->wh;
}

rd *add(job *j, const char *url, long long lo, long long hi) {
  if (j->nr == j->rcap)
    j->rq = realloc(j->rq, (j->rcap = 2 * j->rcap + 16) * sizeof *j->rq);
  rd *r = &j->rq[j->nr++];
  *r = (rd){.url = strdup(url), .lo = lo, .hi = hi, .wl = lo, .wh = hi,
            .b.size = -1};
  return r;
}

// a read to make: LACK, or what became of the same read made already. its
// ends that reads in hand hold are not read again, and one they hold
// whole is not made
const char *want(job *j, const char *url, long long lo,
                        long long hi) {
  for (rd *r = j->rq; r < j->rq + j->nr; r++)
    if (r->wl == lo && r->wh == hi && !strcmp(r->url, url))
      return r->e ? r->e : r->ok ? "tile-part not found" : LACK;
  rd *r = add(j, url, lo, hi);
  for (int c = hi > 0; c && r->lo < r->hi;) {
    c = 0;
    for (rd *q = j->rq; q < r; q++) {
      long long e = q->lo + (long long)q->b.n;
      if (!q->ok || strcmp(q->url, url)) continue;
      if (q->lo <= r->lo && r->lo < e) r->lo = e, c = 1;
      if (q->lo < r->hi && r->hi <= e) r->hi = q->lo, c = 1;
    }
  }
  if (hi > 0 && r->lo >= r->hi) r->ok = 1, fill(j, r);
  return LACK;
}

// a band done with: its reads go
void forget(job *j, const char *url) {
  int n = 0;
  for (rd *r = j->rq; r < j->rq + j->nr; r++)
    if (strcmp(r->url, url)) j->rq[n++] = *r;
    else free(r->url), free(r->b.p);
  j->nr = n;
}

static int cmp(const void *a, const void *b) {
  return (*(long long *)a > *(long long *)b) -
         (*(long long *)a < *(long long *)b);
}

// ranges q[0..n) (lo, hi pairs) as runs: in order, joined where the gap is
// at most g, then the closest joined until at most m are left (m 0: any)
int merge(long long *q, int n, long long g, int m) {
  int c = 0;
  qsort(q, n, 16, cmp);
  for (int i = 0; i < n; i++)
    if (c && q[2 * i] - q[2 * c - 1] <= g)
      q[2 * c - 1] = MAX(q[2 * c - 1], q[2 * i + 1]);
    else q[2 * c] = q[2 * i], q[2 * c + 1] = q[2 * i + 1], c++;
  for (; m && c > m; c--) {
    int b = 0;
    for (int i = 1; i < c - 1; i++)
      if (q[2 * i + 2] - q[2 * i + 1] < q[2 * b + 2] - q[2 * b + 1]) b = i;
    q[2 * b + 1] = q[2 * b + 3];
    memmove(q + 2 * b + 2, q + 2 * b + 4, (c - b - 2) * 16);
  }
  return c;
}

char *swap(const char *url, const char *from, const char *to) {
  const char *p = strstr(url, from);
  char *r = malloc(strlen(url) + strlen(to) + 1);
  if (!p) return free(r), NULL;
  sprintf(r, "%.*s%s", (int)(p - url), url, to);
  return r;
}

int find(int *p, int i) {
  while (p[i] != i) i = p[i] = p[p[i]];
  return i;
}

// a worker's connections: a handle that holds the key and options, which
// each read's is copied from, and a multi handle over which a stage's
// reads go at once and which keeps their connections
typedef struct connection { CURL *c; CURLM *m; char *cred, sig[64]; } ctx;

// the reads of q[0..n) neither ok nor failed, made at once, after the
// longest wait one was asked for
static void fetch(ctx *x, rd *q, int n) {
  int wait = 0, left;
  char u[4096], range[48];
  CURLMsg *g;
  for (rd *r = q; r < q + n; r++)
    if (r->url && !r->ok && !r->e) wait = MAX(wait, r->wait);
  if (wait) sleep(wait);
  for (rd *r = q; r < q + n; r++) {
    if (!r->url || r->ok || r->e) continue;
    CURL *c = curl_easy_duphandle(x->c);
    href(r->url, u);
    snprintf(range, sizeof range, r->hi < 0 ? "%lld-" : "%lld-%lld", r->lo,
             r->hi - 1);
    curl_easy_setopt(c, CURLOPT_URL, u);
    if (x->cred && !strncmp(r->url, "s3://", 5))   // eodata's reads alone
      curl_easy_setopt(c, CURLOPT_AWS_SIGV4, x->sig),
      curl_easy_setopt(c, CURLOPT_USERPWD, x->cred);
    curl_easy_setopt(c, CURLOPT_RANGE, r->hi > -2 && (r->lo || r->hi >= 0)
                                       ? range : NULL);
    curl_easy_setopt(c, CURLOPT_NOBODY, (long)(r->hi == -2));
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &r->b);
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &r->b);
    curl_easy_setopt(c, CURLOPT_PRIVATE, r);
    r->b.n = 0, r->b.size = -1, r->b.wait = 0;
    curl_multi_add_handle(x->m, c);
  }
  for (int k = 1; k;)
    if (!curl_multi_perform(x->m, &k) && k)
      curl_multi_poll(x->m, NULL, 0, 1000, NULL);
  while ((g = curl_multi_info_read(x->m, &left))) {
    rd *r;
    long code = 0;
    curl_off_t len = -1;
    CURLcode e = g->data.result;
    curl_easy_getinfo(g->easy_handle, CURLINFO_PRIVATE, (char **)&r);
    curl_easy_getinfo(g->easy_handle, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_getinfo(g->easy_handle, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T,
                      &len);
    if (r->hi == -2) r->b.size = len;
    if (e == CURLE_FILE_COULDNT_READ_FILE || e == CURLE_URL_MALFORMAT ||
        e == CURLE_UNSUPPORTED_PROTOCOL || e == CURLE_LOGIN_DENIED)
      r->e = curl_easy_strerror(e);
    else check(r, e != CURLE_OK, code);
    curl_multi_remove_handle(x->m, g->easy_handle);
    curl_easy_cleanup(g->easy_handle);
  }
}

// a worker's connections, with eodata's key when one is in the environment
static void open_(ctx *x) {
  const char *id = getenv("AWS_ACCESS_KEY_ID"),
             *secret = getenv("AWS_SECRET_ACCESS_KEY"),
             *region = getenv("AWS_REGION");
  *x = (ctx){curl_easy_init(), curl_multi_init(), NULL, ""};
  curl_easy_setopt(x->c, CURLOPT_WRITEFUNCTION, wr);
  curl_easy_setopt(x->c, CURLOPT_HEADERFUNCTION, hd);
  curl_multi_setopt(x->m, CURLMOPT_MAX_HOST_CONNECTIONS, 6L);
  snprintf(x->sig, sizeof x->sig, "aws:amz:%s:s3",
           region ? region : "us-east-1");
  if (id && secret && asprintf(&x->cred, "%s:%s", id, secret) < 0)
    x->cred = NULL;
  // openssl 3 parses a whole CA bundle per connection, ~30 ms of a core;
  // debian's hashed directory is read lazily, one certificate per chain
  if (!access("/etc/ssl/certs/ca-certificates.crt", R_OK))
    curl_easy_setopt(x->c, CURLOPT_CAINFO, NULL),
    curl_easy_setopt(x->c, CURLOPT_CAPATH, "/etc/ssl/certs");
  curl_easy_setopt(x->c, CURLOPT_CONNECTTIMEOUT, 15L);
  curl_easy_setopt(x->c, CURLOPT_LOW_SPEED_LIMIT, 1024L);   // a stalled
  curl_easy_setopt(x->c, CURLOPT_LOW_SPEED_TIME, 30L);      // read retries
}

// Complete one round, then assemble ranges from the bytes already in hand.
void read_round(job *j) {
  fetch(j->connection, j->rq, j->nr);
  for (rd *r = j->rq; r < j->rq + j->nr; r++)
    if (r->ok && r->hi >= 0 && (r->lo != r->wl || r->hi != r->wh)) fill(j, r);
}

static int busy, ncpu;
static const char *pool_error;
static row *qh, *qt;
static pthread_mutex_t qm = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t qc = PTHREAD_COND_INITIALIZER;

static void *worker(void *unused) {
  ctx connection;
  open_(&connection);
  for (;;) {
    pthread_mutex_lock(&qm);
    while (!qh) pthread_cond_wait(&qc, &qm);
    row *w = qh;
    if (!(qh = w->next)) qt = NULL;
    pthread_mutex_unlock(&qm);
    __atomic_add_fetch(&busy, 1, __ATOMIC_RELAXED);
    job j = {.connection = &connection};
    w->work(w, &j);
    for (int i = 0; i < j.nr; i++) free(j.rq[i].url), drop(&j.rq[i].b);
    free(j.rq);
    __atomic_sub_fetch(&busy, 1, __ATOMIC_RELAXED);
    pthread_mutex_lock(w->m);
    if (!--*w->left) pthread_cond_signal(w->c);
    pthread_mutex_unlock(w->m);
  }
  return NULL;
}

// a parallel for over the cores the rows in flight leave idle, j2k.c's
typedef struct { void (*f)(void *, size_t); void *a; size_t n, i; } pool;

static void *pooled(void *p) {
  pool *s = p;
  for (size_t i; (i = __atomic_fetch_add(&s->i, 1, __ATOMIC_RELAXED)) < s->n;)
    s->f(s->a, i);
  return NULL;
}

void spread(void (*f)(void *, size_t), void *a, size_t n) {
  pool s = {f, a, n, 0};
  pthread_t th[64];
  int t = MIN(ncpu / MAX(__atomic_load_n(&busy, __ATOMIC_RELAXED), 1), 64);
  int started = 1;
  while (started < t && !pthread_create(&th[started], NULL, pooled, &s))
    started++;
  pooled(&s);
  for (int i = 1; i < started; i++) pthread_join(th[i], NULL);
}

// BURNOFF_THREADS workers, by default four per core: decoding is the cost,
// and more rows in flight only hold more memory
static void init(void) {
  const char *n = getenv("BURNOFF_THREADS");
  ncpu = MAX(sysconf(_SC_NPROCESSORS_ONLN), 1);
  char *stop;
  errno = 0;
  long jobs = n ? strtol(n, &stop, 10) : 4 * ncpu;
  if (n && (stop == n || *stop || errno == ERANGE || jobs < 1
            || jobs > INT_MAX)) {
    pool_error = "BURNOFF_THREADS must be a positive integer";
    return;
  }
  pthread_t th;
  curl_global_init(CURL_GLOBAL_ALL);
  for (long i = 0; i < jobs; i++) {
    if (pthread_create(&th, NULL, worker, NULL)) {
      if (!i) pool_error = "could not start a worker";
      break;
    }
    pthread_detach(th);
  }
}

int valid(duckdb_vector v, idx_t i) {
  uint64_t *m = duckdb_vector_get_validity(v);
  return !m || duckdb_validity_row_is_valid(m, i);
}

char *str(duckdb_vector v, idx_t i) {
  duckdb_string_t *s = (duckdb_string_t *)duckdb_vector_get_data(v) + i;
  return strndup(duckdb_string_t_data(s), duckdb_string_t_length(*s));
}

// rows with a url run on the pool, back once all are done
void run(row *rs, idx_t n) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  int left = 0;
  pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t c = PTHREAD_COND_INITIALIZER;
  pthread_once(&once, init);
  if (pool_error) {
    for (idx_t i = 0; i < n; i++)
      if (rs[i].url && !rs[i].e) rs[i].e = pool_error;
    pthread_cond_destroy(&c);
    pthread_mutex_destroy(&m);
    return;
  }
  pthread_mutex_lock(&qm);
  for (idx_t i = 0; i < n; i++)
    if (rs[i].url && !rs[i].follow) {
      rs[i].left = &left, rs[i].m = &m, rs[i].c = &c, left++;
      if (qt) qt->next = &rs[i]; else qh = &rs[i];
      qt = &rs[i];
    }
  pthread_cond_broadcast(&qc);
  pthread_mutex_unlock(&qm);
  pthread_mutex_lock(&m);
  while (left) pthread_cond_wait(&c, &m);
  pthread_mutex_unlock(&m);
  pthread_cond_destroy(&c);
  pthread_mutex_destroy(&m);
}

// s2_get(url): the body of an http get, four urls at a time, as the
// catalogue answers more with 429s. a failure fails the query, so a search
// never loses scenes
static void s2_get(duckdb_function_info info, duckdb_data_chunk in,
                   duckdb_vector out) {
  duckdb_vector v = duckdb_data_chunk_get_vector(in, 0);
  idx_t n = duckdb_data_chunk_get_size(in);
  rd *q = calloc(n ? n : 1, sizeof *q);
  ctx x;
  open_(&x);
  for (idx_t i = 0; i < n; i++)
    q[i] = (rd){.url = valid(v, i) ? str(v, i) : NULL, .hi = -1, .b.size = -1};
  for (idx_t i = 0; i < n; i += 4)
    for (int k = 1; k;) {
      k = 0;
      for (idx_t m = i; m < MIN(i + 4, n); m++)
        k |= q[m].url && !q[m].ok && !q[m].e;
      if (k) fetch(&x, q + i, MIN(4, n - i));
    }
  duckdb_vector_ensure_validity_writable(out);
  for (idx_t i = 0; i < n; i++) {
    if (q[i].e) duckdb_scalar_function_set_error(info, q[i].e);
    if (!q[i].url) duckdb_validity_set_row_invalid(
      duckdb_vector_get_validity(out), i);
    else duckdb_vector_assign_string_element_len(out, i,
      (const char *)q[i].b.p, q[i].b.n);
    free(q[i].url), drop(&q[i].b);
  }
  free(q), free(x.cred), curl_easy_cleanup(x.c), curl_multi_cleanup(x.m);
}

duckdb_logical_type type(duckdb_type t) {
  return duckdb_create_logical_type(t);
}

// burnoff.sql, as a string literal made by make
static const char *macros =
#include "burnoff.sql.h"
;

DUCKDB_EXTENSION_ENTRYPOINT(duckdb_connection con, duckdb_extension_info info,
                            struct duckdb_extension_access *access) {
  curl_global_init(CURL_GLOBAL_ALL);
  duckdb_state ok = s2_register(con);
  if (ok == DuckDBSuccess) ok = s3_register(con);
  duckdb_logical_type vc = type(DUCKDB_TYPE_VARCHAR);
  duckdb_scalar_function f = duckdb_create_scalar_function();
  duckdb_scalar_function_set_name(f, "s2_get");
  duckdb_scalar_function_add_parameter(f, vc);
  duckdb_scalar_function_set_return_type(f, vc);
  duckdb_scalar_function_set_function(f, s2_get);
  if (ok == DuckDBSuccess) ok = duckdb_register_scalar_function(con, f);
  duckdb_destroy_scalar_function(&f), duckdb_destroy_logical_type(&vc);
  if (ok == DuckDBSuccess) ok = duckdb_query(con, macros, NULL);
  if (ok == DuckDBError) access->set_error(info, "could not register");
  return ok == DuckDBSuccess;
}
