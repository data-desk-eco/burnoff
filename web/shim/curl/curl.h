// just enough of libcurl's easy api for burnoff.c, over a synchronous
// XMLHttpRequest: the detector runs in a web worker, where those may block
#include <emscripten.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
typedef long long curl_off_t;
typedef size_t (*curl_cb)(char *, size_t, size_t, void *);
typedef struct {
  const char *url, *range;
  void *wd, *hd;
  curl_cb wf, hf;
  long code, nobody;
  curl_off_t len;
} CURL;
typedef enum { CURLE_OK, CURLE_UNSUPPORTED_PROTOCOL, CURLE_URL_MALFORMAT,
  CURLE_COULDNT_CONNECT = 7, CURLE_FILE_COULDNT_READ_FILE = 37,
  CURLE_LOGIN_DENIED = 67 } CURLcode;
enum { CURLOPT_URL, CURLOPT_RANGE, CURLOPT_WRITEDATA, CURLOPT_HEADERDATA,
  CURLOPT_WRITEFUNCTION, CURLOPT_HEADERFUNCTION, CURLOPT_NOBODY,
  CURLOPT_HTTPGET, CURLOPT_AWS_SIGV4, CURLOPT_USERPWD, CURLOPT_CAINFO,
  CURLOPT_CAPATH, CURLOPT_CONNECTTIMEOUT, CURLOPT_LOW_SPEED_LIMIT,
  CURLOPT_LOW_SPEED_TIME, CURLINFO_RESPONSE_CODE,
  CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, CURL_GLOBAL_ALL };
#define curl_global_init(f) 0
#define curl_easy_init() ((CURL *)calloc(1, sizeof(CURL)))
#define curl_easy_cleanup free
#define curl_easy_strerror(e) "network error"

static void curl_easy_setopt(CURL *c, int o, ...) {
  va_list a;
  va_start(a, o);
  switch (o) {
  case CURLOPT_URL: c->url = va_arg(a, char *); break;
  case CURLOPT_RANGE: c->range = va_arg(a, char *); break;
  case CURLOPT_WRITEDATA: c->wd = va_arg(a, void *); break;
  case CURLOPT_HEADERDATA: c->hd = va_arg(a, void *); break;
  case CURLOPT_WRITEFUNCTION: c->wf = va_arg(a, curl_cb); break;
  case CURLOPT_HEADERFUNCTION: c->hf = va_arg(a, curl_cb); break;
  case CURLOPT_NOBODY: c->nobody = va_arg(a, long); break;
  }
  va_end(a);
}

EM_JS_DEPS(curl, "$stringToNewUTF8");
// the status, or -1 on a network error, with the body and the headers in
// malloc'd buffers. self.BURNOFF_PROXY prefixes every url, for cors
EM_JS(int, xhr, (const char *u, const char *r, int head, char **body,
                 int *n, char **hdr), {
  const x = new XMLHttpRequest();
  try {
    x.open(head ? 'HEAD' : 'GET',
           (self.BURNOFF_PROXY || "") + UTF8ToString(u), false);
    x.responseType = 'arraybuffer';
    if (r) x.setRequestHeader('Range', 'bytes=' + UTF8ToString(r));
    x.send();
  } catch (e) { return -1; }
  const b = new Uint8Array(x.response || []), p = _malloc(b.length || 1);
  HEAPU8.set(b, p);
  HEAPU32[body >> 2] = p, HEAP32[n >> 2] = b.length;
  HEAPU32[hdr >> 2] = stringToNewUTF8(x.getAllResponseHeaders());
  return x.status || -1;
});

static CURLcode curl_easy_perform(CURL *c) {
  char *b, *h;
  int n, s = xhr(c->url, c->range, c->nobody, &b, &n, &h);
  if (s < 0) return CURLE_COULDNT_CONNECT;
  c->code = s, c->len = c->nobody ? -1 : n;
  for (char *l = h; c->hf && *l; l += strcspn(l, "\n") + !!*l)
    c->hf(l, 1, strcspn(l, "\n"), c->hd);
  if (!c->nobody && c->wf) c->wf(b, 1, n, c->wd);
  free(b), free(h);
  return CURLE_OK;
}

static void curl_easy_getinfo(CURL *c, int i, void *p) {
  if (i == CURLINFO_RESPONSE_CODE) *(long *)p = c->code;
  else *(curl_off_t *)p = c->len;
}
