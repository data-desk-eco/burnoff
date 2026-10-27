// burnoff's detector for the browser: src/burnoff.c, its duckdb functions
// unused, over the xhr shim in shim/curl, with in c what s2_scenes and
// s2_hotspots do in sql: the mgrs tiles over a lon/lat box, and a scene's
// hotspots over it in lon/lat. each call gives json in a buffer the caller
// frees
#include "../src/burnoff.c"

// wgs84 transverse mercator by krüger's series to third order, under a
// millimetre within a zone
#define N1 (1 / (2 * 298.257223563 - 1))
#define N2 (N1 * N1)
#define N3 (N2 * N1)
static const double AA = 6378137 / (1 + N1) * (1 + N2 / 4) * .9996,
  AL[] = {N1 / 2 - 2 * N2 / 3 + 5 * N3 / 16, 13 * N2 / 48 - 3 * N3 / 5,
          61 * N3 / 240},
  BE[] = {N1 / 2 - 2 * N2 / 3 + 37 * N3 / 96, N2 / 48 + N3 / 15,
          17 * N3 / 480},
  DE[] = {2 * N1 - 2 * N2 / 3 - 2 * N3, 7 * N2 / 3 - 8 * N3 / 5,
          56 * N3 / 15};
#define R (M_PI / 180)

// lon/lat to metres of utm zone z, from a false northing of 1e7 if south
static void utm(double lon, double lat, int z, int s, double *x, double *y) {
  double c = 2 * sqrt(N1) / (1 + N1), l = (lon - 6 * z + 183) * R;
  double t = sinh(atanh(sin(lat * R)) - c * atanh(c * sin(lat * R)));
  double xi = atan2(t, cos(l)), eta = atanh(sin(l) / sqrt(1 + t * t));
  *x = eta, *y = xi;
  for (int j = 1; j <= 3; j++)
    *x += AL[j - 1] * cos(2 * j * xi) * sinh(2 * j * eta),
    *y += AL[j - 1] * sin(2 * j * xi) * cosh(2 * j * eta);
  *x = 5e5 + AA * *x, *y = s * 1e7 + AA * *y;
}

static void geo(double x, double y, int z, int s, double *lon, double *lat) {
  double xi = (y - s * 1e7) / AA, eta = (x - 5e5) / AA, a = xi, b = eta;
  for (int j = 1; j <= 3; j++)
    a -= BE[j - 1] * sin(2 * j * xi) * cosh(2 * j * eta),
    b -= BE[j - 1] * cos(2 * j * xi) * sinh(2 * j * eta);
  double chi = asin(sin(a) / cosh(b)), p = chi;
  for (int j = 1; j <= 3; j++) p += DE[j - 1] * sin(2 * j * chi);
  *lat = p / R, *lon = 6 * z - 183 + atan2(sinh(b), cos(a)) / R;
}

// the sentinel-2 tile over lon/lat: its 100 km mgrs square, whose latitude
// band is the one its centre is in (13SFR straddles 32°N)
static void mgrs(double lon, double lat, char *id) {
  int z = (int)floor((lon + 180) / 6) % 60 + 1, s = lat < 0, c, r, b;
  double x, y, clon, clat;
  utm(lon, lat, z, s, &x, &y);
  c = x / 1e5, r = y / 1e5;
  geo(c * 1e5 + 5e4, r * 1e5 + 5e4, z, s, &clon, &clat);
  b = MIN(MAX((int)floor((clat + 80) / 8), 0), 19);
  sprintf(id, "%02d%c%c%c", z, "CDEFGHJKLMNPQRSTUVWX"[b],
          "ABCDEFGHJKLMNPQRSTUVWXYZ"[(z - 1) % 3 * 8 + MAX(c, 1) - 1],
          "ABCDEFGHJKLMNPQRSTUV"[(r + (z % 2 ? 0 : 5)) % 20]);
}

// the tile of each of n points (lon, lat pairs): ["13SFR", ...]
EMSCRIPTEN_KEEPALIVE char *tiles(const double *pt, int n) {
  char *o, id[8];
  size_t len;
  FILE *f = open_memstream(&o, &len);
  fputc('[', f);
  for (int i = 0; i < n; i++)
    mgrs(pt[2 * i], pt[2 * i + 1], id),
    fprintf(f, "%s\"%s\"", i ? "," : "", id);
  fputc(']', f), fclose(f);
  return o;
}

// the obscured share of the 640 m square at x y, or -1 outside the read:
// the squares are a grid, row by row from the north west
static double cloud(const res *r, double x, double y) {
  int nx = 0;
  while (nx < r->nq && r->q[nx].y == r->q[0].y) nx++;
  long i = r->nq ? lround((x - r->q[0].x) / 640) : -1;
  long j = r->nq ? lround((r->q[0].y - y) / 640) : -1;
  return i >= 0 && i < nx && j >= 0 && j * nx + i < r->nq
       ? r->q[j * nx + i].cloud : -1;
}

// one scene's hotspots over a lon/lat box, in lon/lat, and how obscured the
// 640 m square of each of np points (lon, lat pairs) was, or -1 unread. the
// zone a hotspot is reported in is the box within the tile's own 100 km
// square, so no hotspot of a pass is found twice, and part of parts of its
// 6.4 km background cell columns, so workers can share it. a detection is
// one component of at most max_pixels, so the zone is read with that many
// pixels more on every side, rounded out to whole cells: a hotspot is then
// what a read of the whole tile finds, wherever the zone's edges fall
EMSCRIPTEN_KEEPALIVE char *detect(const char *url, double w, double s,
                                  double e, double n, int part, int parts,
                                  const double *pt, int np, const char *th) {
  static ctx x;
  const char *fn = strrchr(url, '/') ? strrchr(url, '/') + 1 : url, *er;
  int zn = atoi(fn + 1), so = fn[3] < 'N';
  double t[NT], z[4] = {INFINITY, INFINITY, -INFINITY, -INFINITY}, b[4], p, q;
  band *f = x.bd;
  res r = {.clear = NAN};
  char *o = NULL;
  size_t len;
  FILE *out = open_memstream(&o, &len);
  memcpy(t, TD, sizeof t);
  if (!x.c)
    x.c = curl_easy_init(), curl_easy_setopt(x.c, CURLOPT_WRITEFUNCTION, wr),
    curl_easy_setopt(x.c, CURLOPT_HEADERFUNCTION, hd);
  if (!(er = params(th, t)) && !(er = header(&x, url, f))) {
    double sx = round(f->ox / 1e5) * 1e5, sy = round(f->oy / 1e5) * 1e5;
    double m = (t[MAXPX] + 1) * f->res, c0, c1;
    for (int i = 0; i < 81; i++) {
      utm(w + (e - w) * (i % 9) / 8, s + (n - s) * (i / 9) / 8, zn, so, &p,
          &q);
      z[0] = MIN(z[0], p), z[1] = MIN(z[1], q);
      z[2] = MAX(z[2], p), z[3] = MAX(z[3], q);
    }
    z[0] = MAX(z[0], sx), z[1] = MAX(z[1], sy - 1e5);
    z[2] = MIN(z[2], sx + 1e5), z[3] = MIN(z[3], sy);
    c0 = floor((z[0] - f->ox) / 6400), c1 = ceil((z[2] - f->ox) / 6400);
    z[0] = MAX(z[0], f->ox + 6400 * (c0 + floor((c1 - c0) * part / parts)));
    z[2] = MIN(z[2], f->ox + 6400 * (c0 + floor((c1 - c0) * (part + 1) /
                                                 parts)));
    b[0] = f->ox + floor((z[0] - m - f->ox) / 6400) * 6400;
    b[2] = f->ox + ceil((z[2] + m - f->ox) / 6400) * 6400;
    b[1] = f->oy - ceil((f->oy - z[1] + m) / 6400) * 6400;
    b[3] = f->oy - floor((f->oy - z[3] - m) / 6400) * 6400;
    if (z[2] > z[0] && z[3] > z[1]) er = run(&x, url, b, t, &r);
  }
  fprintf(out, "{\"clear\":%.6g,\"error\":", isnan(r.clear) ? -1 : r.clear);
  fprintf(out, er ? "\"%s\",\"hotspots\":[" : "null,\"hotspots\":[", er);
  for (int i = 0, k = 0; !er && i < r.nd; i++) {
    det *d = &r.d[i];
    if (d->x < z[0] || d->x >= z[2] || d->y <= z[1] || d->y > z[3]) continue;
    geo(d->x, d->y, zn, so, &p, &q);
    fprintf(out, "%s{\"lon\":%.7f,\"lat\":%.7f,\"max_b12\":%.4f,\"avg_b12\":"
      "%.4f,\"peak_b11\":%.4f,\"ratio\":%.4g,\"peakedness\":%.4f,\"pixels\":"
      "%d,\"radiance\":%.4f,\"saturated\":%s,\"cloud\":%.3g", k++ ? "," : "",
      p, q, d->max, d->avg, d->b11, isinf(d->ratio) ? 1e308 : d->ratio, d->pk,
      d->px, d->rad, d->sat ? "true" : "false", cloud(&r, d->x, d->y));
    // and its pixels, each its b12 and its square's corners
    fputs(",\"px\":[", out);
    for (int j = 0; j < d->px; j++) {
      double x0 = f->ox + (d->pp[2 * j] & 65535) * f->res;
      double y0 = f->oy - (d->pp[2 * j] >> 16) * f->res;
      fprintf(out, "%s[%.4f", j ? "," : "", cal(d->pp[2 * j + 1]));
      for (int c = 0; c < 4; c++)
        geo(x0 + (c == 1 || c == 2) * f->res, y0 - (c > 1) * f->res, zn, so,
            &p, &q), fprintf(out, ",%.7f,%.7f", p, q);
      fputc(']', out);
    }
    fputs("]}", out);
  }
  fputs("],\"cloud\":[", out);
  for (int i = 0; i < np; i++)
    utm(pt[2 * i], pt[2 * i + 1], zn, so, &p, &q),
    fprintf(out, "%s%.3g", i ? "," : "", er ? -1 : cloud(&r, p, q));
  for (int i = 0; i < r.nd; i++) free(r.d[i].pp);
  fputs("]}", out), fclose(out), free(r.d), free(r.q);
  return o;
}
