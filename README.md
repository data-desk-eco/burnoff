# burnoff

Burnoff is a DuckDB extension for detecting hotspots, such as gas
flares, in Sentinel-2 L1C imagery. It reads the JPEG2000 archive directly, so one query searches the
CDSE catalogue and detects the hotspots in a region. Each hotspot comes with its
position, brightness and radiance, and each scene with how clearly it saw
the region.

## Quick start

Download `burnoff-osx_arm64.duckdb_extension` (macOS) or
`burnoff-linux_amd64.duckdb_extension` (Linux) from the
[latest release](https://github.com/data-desk-eco/burnoff/releases/latest)
and install it under the name `burnoff`:

```sh
# macOS:
curl -fL https://github.com/data-desk-eco/burnoff/releases/latest/download/burnoff-osx_arm64.duckdb_extension -o burnoff.duckdb_extension
# Linux: use burnoff-linux_amd64 in place of burnoff-osx_arm64 above.
duckdb -unsigned -c "force install './burnoff.duckdb_extension'"
```

The extension loads in DuckDB 1.2 or later. It is not signed, so start
DuckDB with `-unsigned`, and load spatial first:

```sql
load spatial;
load burnoff;
from s2_hotspots(ST_MakeEnvelope(-104.2, 31.6, -103.2, 32.6), '2025-05-01',
               t1 := '2025-05-31', max_cloud := 50);
-- around a point, from a date to today
from s2_hotspots(ST_Buffer(ST_Point(-103.9, 32.1), 0.05), '2025-01-01');
-- for each row of a table of areas
from aois, lateral s2_hotspots(aois.geom, '2025-01-01');
```

## Build

Requires a C compiler, `pkg-config`, libcurl and OpenJPEG 2.5 or later
(`libcurl4-openssl-dev` and `libopenjp2-7-dev` on Ubuntu, `openjpeg` in
Homebrew). `make wasm` also needs emscripten and CMake.

```sh
make              # ext/burnoff.duckdb_extension
make test         # loads it and runs a detection offline
make install      # so that `load burnoff` works in any directory
make wasm         # web/burnoff.{js,wasm}, with emscripten
```

## Functions

- `s2_hotspots(g, t0, t1 := today, max_cloud := 100,
  thresholds := '')` gives one row for each hotspot in a lon/lat geometry
  from t0 to t1. A point has no area, so buffer it.
- `s2_scenes(g, t0, t1 := today)` gives the scenes that
  the search finds, with the box to read in each.
- `s2_detect(b12, xmin, ymin, xmax, ymax [, thresholds])` detects in one
  scene, over a box in the metres of its UTM zone. It gives the box's
  `clear` share, an `error` (a failed row does not stop the query), the
  `hotspots`, and `cells`: the centre and obscured share (`cloud`: cloud, no
  data, or a background cell too cloudy to read) of each 640 m square of
  the box. A look at a site is clear when its square's `cloud` is low.

An optional `source` is `'eodata'` (CDSE's S3, which needs `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`, as on CloudFerro machines)
or `'gcp'` (Google's public mirror, with no credentials). The default, `'auto'`, uses
eodata when `AWS_ACCESS_KEY_ID` is set and gcp when it is not.
`thresholds` is `'name=value,...'` over the defaults in `src/burnoff.c`.
One of them, `nir_excess` (0.1), drops a peak whose rise in B8A over its
surroundings is a tenth or more of its rise in B12: sunlight reflected
off roofs, glass and tanks, which a fire does not give. A large value
turns the test off.

## In the browser

`make wasm` builds the same detector for a web worker. `web/worker.js`
answers two calls:

- `tiles(points)` names the MGRS tile of each lon/lat point.
- `detect(url, w, s, e, n, part, parts, points)` gives one scene's hotspots
  over a lon/lat box, in lon/lat, and the obscured share of the 640 m
  square under each point. `part` of `parts` reads that share of the box's
  6.4 km cell columns, so several workers can share one scene.

A `gs://gcp-public-data-sentinel-2/...` url is read through Google's JSON
API, which answers cross-origin range requests. The page needs no proxy and
no catalogue: a tile's scenes come from one listing of the bucket for each
satellite and year.

A detection runs in stages. Each stage is a set of byte-range reads, all
known before any of them is made, and then a set of decodes. The worker
makes the reads of a stage at the same time with `fetch()` and does not
wait on them, so one worker can run several detections at once: one
decodes while the others wait for their reads. The worker answers each
call with its id, in the order the calls finish.

The Aerial map (`data-desk-eco/aerial`) uses it for a live layer.

## Limits

- burnoff needs baseline N0400 or later, which has a raster cloud mask.
- A search that fills the catalogue's 1000-scene page stops the query.
- Hotspots in an overlap of two UTM zones are found in both.
