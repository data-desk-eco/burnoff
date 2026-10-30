# burnoff

Burnoff detects hotspots, such as gas flares, in Sentinel-2 L1C imagery.
It reads the JPEG 2000 files directly and decodes only the parts it needs.
Each hotspot has a position, brightness, radiance and pixels. Each scene
has a value that tells how clearly it saw the area.

You can use burnoff in two ways:

- **The hosted API.** Send a bounding box and a date range and get
  GeoJSON. The service keeps every result, so a repeated area is fast.
- **The DuckDB extension.** Download it and run the detector on your own
  computer, over any area, in SQL.

## The API

```
GET https://dev.datadesk.eco/burnoff/hotspots?bbox=w,s,e,n[&datetime=a/b][&f=sites]
```

- `bbox`: longitude and latitude, at most 0.44° by 0.25°.
- `datetime`: `a/b` as ISO dates. Use `..` for an open end. The default
  is the last 90 days.
- `f=sites`: optional. Groups the hotspots into sites (see below).

Without `f`, you get a feature collection, newest first:

- One `look` feature for each scene, with no geometry. `cloud` is the
  obscured share of the box (`-1` if the scene does not cover it). A
  scene that could not be read is an `error` feature.
- One `hotspot` feature for each detection. The geometry is its pixels
  as a multipolygon. `pixel_b12` gives the B12 value of each pixel.

With `f=sites`, you get one point feature for each site. The service
finds sites from all the detections it holds, on all dates:

1. Each detection puts a count on the 20 m pixel of its peak, at most one
   for each date, and half a count on the four pixels next to it.
2. Each pixel points to its highest neighbour. The pixels that climb to
   the same top make a hill.
3. A hill joins the largest larger hill within 60 m that never had a
   detection on the same date. Two flares that burn on the same date stay
   two sites.

The same detections always give the same sites, for any `bbox` or
`datetime`. The `id` is the mean place of the site's detections, rounded
to 40 m (`live:<lat>,<lon>`). The mean changes little as detections are
added, so the `id` usually stays the same. `datetime`
selects only the dates in each site. Its properties are `id`,
`looks` (`[[date, cloud], …]` for the 640 m square under the site),
`detections` (the brightest detection of each date, with its pixels)
and `detection_count`.

```sh
curl 'https://dev.datadesk.eco/burnoff/hotspots?bbox=-103.6,31.9,-103.5,32&datetime=2026-08-01/2026-10-30&f=sites'
```

A new area takes some seconds, because the service reads each scene.
An area that the service has already read comes back in less than a
second.

### How the service works

The service runs on one machine in CloudFerro's WAW3-2 region, next to
the Copernicus `eodata` archive. All of its data stays in the EU. It
uses only this extension, SQLite and systemd. The files are in `serve/`,
and `serve/deploy.sh` installs them.

- A request runs `hotspots.sql` in DuckDB with the extension. The SQL
  finds the box's tiles and scenes from an index of `eodata`. It reads
  each 6.4 km cell from the store if the store has it. Otherwise, it
  runs `s2_detect` on the cells that are missing. `sites.sql` groups the
  result into sites.
- The store is one SQLite file. The service writes new cells and their
  hotspots in one transaction, under a digest of the extension that made
  them. A new detector therefore reads the cells again.
- systemd timers update the scene index each day (`index.sh`) and merge
  the store into the Data Desk archive each hour (`export.sh`). The
  archive is the record. The export replaces only the cells that the
  store holds, so it never removes rows, and a second run changes
  nothing. If the store is empty, the export fills it from the archive. A
  background job (`bulk.sh`) fills the store around known sites. It
  stops while a request runs.

## The extension

Download `burnoff-osx_arm64.duckdb_extension` (macOS) or
`burnoff-linux_amd64.duckdb_extension` (Linux) from the
[latest release](https://github.com/data-desk-eco/burnoff/releases/latest)
and install it under the name `burnoff`:

```sh
curl -fL https://github.com/data-desk-eco/burnoff/releases/latest/download/burnoff-osx_arm64.duckdb_extension -o burnoff.duckdb_extension
duckdb -unsigned -c "force install './burnoff.duckdb_extension'"
```

The extension loads in DuckDB 1.2 or later. It is not signed, so start
DuckDB with `-unsigned`. Load spatial first:

```sql
load spatial;
load burnoff;
from s2_hotspots(ST_MakeEnvelope(-104.2, 31.6, -103.2, 32.6), '2025-05-01',
               t1 := '2025-05-31', max_cloud := 50);
-- for each row of a table of areas
from aois, lateral s2_hotspots(aois.geom, '2025-01-01');
```

### Functions

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

### Build

Requires a C compiler, `pkg-config` and libcurl (`libcurl4-openssl-dev` on
Ubuntu). The JPEG 2000 decoder is burnoff's own, `src/j2k.c`. The build
downloads wgpu-native into `ext/` so that the extension can decode on the
GPU (Metal on macOS, Vulkan on Linux); `make GPU=0` builds without it.
`make wasm` also needs emscripten.

```sh
make              # ext/burnoff.duckdb_extension
make test         # loads it and runs a detection offline
make install      # so that `load burnoff` works in any directory
make wasm         # web/burnoff.{js,wasm}, with emscripten
```

## How it decodes

A detection reads the cloud mask, then B12 over the clear parts of the
box, then B11 and B8A only in small windows around candidate hotspots.
From baseline N0512 the files index their packets, so only the packets
that a window needs are read. Burnoff parses those packets on the CPU.
Large decodes then run on the GPU, which also computes the background
and candidates over B12. Small decodes, such as the windows around
candidates, run on the CPU, which is as fast for them. Without a GPU,
everything runs on the CPU. The results are the same, value for value,
either way.

Over the network, a detection waits for its rounds of reads, one after
the other. A small box in a newer file (N0512 on) takes three rounds: the
headers and the cloud mask; B12 with the indexes of B11 and B8A; then B11
and B8A around the candidates. Older files have no index, so burnoff
searches for their tiles. It keeps what it finds for the next detection
on the same file, and it uses the layout of a newer date to look in the
right place in an older one.

On an M2, a whole Sentinel-2 tile takes 0.8 to 1.1 seconds with the GPU
and 3.5 to 4.6 seconds on one CPU core. At eight rows at once, 70 whole
and quarter tiles take 7.0 seconds against 10.2 seconds on the CPU alone,
and 518 small sites take 4.8 seconds either way. In the browser, the
network sets the time for sites.

## In the browser

`make wasm` builds the same detector for a web worker. `web/worker.js`
answers three calls:

- `tiles(points)` names the MGRS tile of each lon/lat point.
- `detect(url, w, s, e, n, part, parts, points)` gives one scene's hotspots
  over a lon/lat box, in lon/lat, and the obscured share of the 640 m
  square under each point. `part` of `parts` reads that share of the box's
  6.4 km cell columns, so several workers can share one scene.
- `drop` ends a detection at its next stage, and the worker answers it
  with `{dropped: true}`. A map whose view moves on uses it to free the
  worker for the new view's reads.

A `gs://gcp-public-data-sentinel-2/...` url is read through Google's JSON
API, which answers cross-origin range requests. The page needs no proxy and
no catalogue: a tile's scenes come from one listing of the bucket for each
satellite and year.

The Aerial map (`data-desk-eco/aerial`) uses the API for its live layer,
and this build only when the API fails.

## Limits

- burnoff needs baseline N0400 or later, which has a raster cloud mask.
- A search that fills the catalogue's 1000-scene page stops the query.
- Hotspots in an overlap of two UTM zones are found in both.
