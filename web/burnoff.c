// burnoff's detector for the browser: src/burnoff.c, its duckdb functions
// unused, over the xhr shim in shim/curl. detect() gives one s2_detect row
// as json, in a buffer that the caller frees
#include "../src/burnoff.c"

EMSCRIPTEN_KEEPALIVE char *detect(const char *url, double x0, double y0,
                                  double x1, double y1, const char *th) {
  static ctx x;
  double box[4] = {x0, y0, x1, y1}, t[NT];
  res r = {0};
  char *o = NULL;
  size_t n;
  FILE *f = open_memstream(&o, &n);
  memcpy(t, TD, sizeof t);
  if (!x.c)
    x.c = curl_easy_init(), curl_easy_setopt(x.c, CURLOPT_WRITEFUNCTION, wr),
    curl_easy_setopt(x.c, CURLOPT_HEADERFUNCTION, hd);
  const char *e = params(th, t);
  if (!e) e = run(&x, url, box, t, &r);
  fprintf(f, "{\"clear\":%.17g,\"error\":", isnan(r.clear) ? -1 : r.clear);
  fprintf(f, e ? "\"%s\",\"flares\":[" : "null,\"flares\":[", e);
  for (int i = 0; !e && i < r.nd; i++) {
    det *d = &r.d[i];
    fprintf(f, "%s{\"x\":%.17g,\"y\":%.17g,\"max_b12\":%.17g,\"avg_b12\":"
      "%.17g,\"peak_b11\":%.17g,\"ratio\":%.17g,\"peakedness\":%.17g,"
      "\"pixels\":%d,\"radiance\":%.17g,\"saturated\":%s}", i ? "," : "",
      d->x, d->y, d->max, d->avg, d->b11, isinf(d->ratio) ? 1e308 : d->ratio,
      d->pk, d->px, d->rad, d->sat ? "true" : "false");
  }
  fputs("],\"cells\":[", f);
  for (int i = 0; !e && i < r.nq; i++)
    fprintf(f, "%s[%.17g,%.17g,%.17g]", i ? "," : "", r.q[i].x, r.q[i].y,
            r.q[i].cloud);
  fputs("]}", f), fclose(f), free(r.d), free(r.q);
  return o;
}
