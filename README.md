# burnoff

Burnoff detects hotspots, such as gas flares, in Sentinel-2 L1C imagery.
It reads the JPEG 2000 files directly and decodes only the parts it needs.
Each hotspot has a position, brightness, radiance and pixels. Each scene
has a value that tells how clearly it saw the area. The extension also
detects hotspots by night in Sentinel-3 SLSTR L1B granules, read in the
same way from the netCDF files.

You can use burnoff in two ways:

- **The hosted API.** Send a bounding box and a date range over DuckDB's
  Quack protocol and get GeoJSON. The service keeps every result, so a repeated area is fast.
- **The DuckDB extension.** Download it and run the detector on your own
  computer, over any area, in SQL.

## The API

The service speaks [Quack](https://duckdb.org/docs/2.0/quack/overview),
DuckDB's client-server protocol, at `quack:dev.datadesk.eco:443` with the
token `burnoff`. It accepts two queries and refuses all others:

```sql
FROM hotspots(w, s, e, n[, 'a', 'b'])
FROM sites(w, s, e, n[, 'a', 'b'])
```

- `w, s, e, n`: longitude and latitude, at most 0.44° by 0.25°.
- `'a', 'b'`: the dates, as ISO dates. Use `'..'` for an open end. The
  default is the last 90 days.

Each gives one row, with one column, `geojson`. From DuckDB 2.0:

```sql
INSTALL quack; LOAD quack;
FROM quack_query('quack:dev.datadesk.eco:443',
  'FROM sites(-103.6, 31.9, -103.5, 32, ''2026-08-01'', ''2026-10-30'')',
  token := 'burnoff');
```

In a browser, use the
[Quack SDK](https://github.com/tobilg/quack-protocol) at
`https://dev.datadesk.eco`.

`hotspots` gives a feature collection, newest first:

- One `look` feature for each scene, with no geometry. `cloud` is the
  obscured share of the box (`-1` if the scene does not cover it). A
  scene that could not be read is an `error` feature.
- One `hotspot` feature for each detection. The geometry is its pixels
  as a multipolygon. `pixel_b12` gives the B12 value of each pixel.

`sites` gives one point feature for each site. The service
finds sites from all the detections it holds, on all dates:

1. Each detection is put on the 20 m pixel of its peak.
2. Pixels within 40 m of each other are joined, the nearest first. A join
   is not made if it would put two detections of the same date, more than
   30 m apart, in one site: those are two flares that burned at the same
   time.

The same detections always give the same sites, for any box or dates. The `id` is the mean place of the site's detections, rounded
to 40 m (`live:<lat>,<lon>`). The mean changes little as detections are
added, so the `id` usually stays the same. The dates select only the
dates in each site. Its properties are `id`,
`looks` (`[[date, cloud], …]` for the 640 m square under the site),
`detections` (the brightest detection of each date, with its pixels)
and `detection_count`.

A new area takes some seconds, because the service reads each scene.
An area that the service has already read comes back in less than a
second.

### How the service works

The service runs on one machine in CloudFerro's WAW3-2 region, next to
the Copernicus `eodata` archive. All of its data stays in the EU. It
uses only this extension, DuckDB 2.0 and systemd. The files are in
`serve/`, and `serve/deploy.sh` installs them.

- One DuckDB process (`server.sql`) holds the store and serves Quack
  behind caddy. Its gate (`api.sql`) turns `hotspots(...)` or
  `sites(...)` into the service's SQL. It runs scripts from the
  machine's own jobs (`q`) only with a key.
- A request runs `hotspots.sql` in DuckDB with the extension. The SQL
  finds the box's tiles and scenes from an index of `eodata`. It reads
  each 6.4 km cell from the store if the store has it. Otherwise, it
  runs `s2_detect` on the cells that are missing. `sites.sql` groups the
  result into sites.
- The store is one DuckDB file. A request writes new cells and their
  hotspots in one transaction, under a digest of the extension that made
  them. A new detector therefore reads the cells again.
- systemd timers update the scene index each day (`index.sh`) and merge
  the store into the Data Desk archive each hour (`export.sh`). The
  archive is the record. The export replaces only the cells that the
  store holds, so it never removes rows, and a second run changes
  nothing. If the store is empty, the export fills it from the archive.
  `bulk.sh`, run by hand, fills the store around known sites.

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

### Night-time hotspots from Sentinel-3

A second detector reads Sentinel-3 SLSTR L1B (`SL_1_RBT`) granules from
eodata, by night. It needs eodata's keys, as `source := 'eodata'` does.

```sql
from s3_hotspots(ST_MakeEnvelope(51.4, 25.8, 51.7, 26.0), '2025-01-01',
                 t1 := '2025-01-31');
```

- `s3_hotspots(g, t0, t1 := today, thresholds := '')` gives one row for
  each hotspot in a lon/lat geometry from t0 to t1, with its granule's
  `sza` (the sun's zenith angle at the box) and `clear` share.
- `s3_scenes(g, t0, t1 := today, night := true)` gives the granules that
  CDSE's catalogue lists over the bounds: by default only ascending
  passes, which cross at about 22:00 local time. An orbit processed
  twice gives only the granules of its newest baseline.
- `s3_detect(dir, w, s, e, n [, thresholds])` detects in one granule (its
  `.SEN3` directory) over a lon/lat box. It gives `sza`, `clear`, an
  `error` and the `hotspots`. A granule where the sun is up at the box
  (`sza` under `sza_min`, 90°) has no hotspots and no `clear`. For a box
  under 10° it is not read at all.
- `s3_flares(g, t0, t1 := today, t_min := 1500, min_passes := 5)` gives
  Caseiro et al.'s flares: the 0.025° cells where the hotspots reach over
  `t_min` K and are confirmed on more than `min_passes` passes (one
  platform's orbit). Their test is a year of hotspots. Biomass fires are
  cooler, and few burn for as long.

The method is that of Caseiro et al. (2018, Remote Sensing 10:1118; 2020,
ESSD 12:2137). At night, only heat gives radiance in the SWIR bands. In
each band, a pixel is hot above the band's threshold: the lowest multiple
of the band's radiance step, above its background, that no pixel takes.
Hot S5 pixels (1.61 µm, 500 m) that touch, diagonally too, make one
hotspot. Each hotspot has:

- `lon`, `lat`: the mean place of its pixels, weighted by their S5
  radiance, from the product's own per-pixel geolocation. With
  `exact=0`, the place comes from the tie-point grid instead. That place
  is a few hundred metres off on flat ground and up to 2 km off over
  hills, but it saves 2.7 MB of reads for each 400 by 500 km of image
  with a hotspot in it.
- `pixels`, and `s5`, `s6`: the sums of its S5 and S6 radiance over the
  background (the median of the pixels two beyond it), scaled by 0.89 and
  0.80 for the bands' known overestimate (`s5_gain`, `s6_gain`).
- `temperature`: the temperature at which Planck's law gives the ratio
  of `s5` to `s6`. A hotspot outside 500-5000 K is dropped as spurious. A
  saturated one (`saturated`) has none.
- `rh`: its radiant heat in MW, σT⁴ times the fire area that `s6` gives at
  that temperature. Neither value is corrected for the atmosphere.
- `confirmed`: S6 is hot under it too, or else S7 or F1 (3.74 µm, 1 km).
  This is Caseiro et al.'s high-accuracy class.

`clear` is the share of the box's other pixels on which none of the
cloud tests in `cloud_bits` (the thermal ones, by default) fired.

The detector reads only parts of each granule. It reads the file heads,
then the tie-point grid (1.7 MB), which places the box in the image. Then
it reads the S5 chunks under the box, with their exception flags and the
cloud mask. Only when S5 holds a hot pixel does it read S6 and the
geolocation of the hot pixels' chunks, and S7 and F1 only for a hotspot
that S6 does not confirm. A small box takes four rounds of reads, or
five.

### Build

Requires a C compiler, `pkg-config`, libcurl and zlib
(`libcurl4-openssl-dev` and `zlib1g-dev` on Ubuntu). The JPEG 2000
decoder is burnoff's own, `src/j2k.c`. The build downloads wgpu-native
into `ext/` so that the extension can decode on the GPU (Metal on macOS,
Vulkan on Linux); `make GPU=0` builds without it. `make wasm` also needs
emscripten.

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
- The Sentinel-3 detector reads eodata only, so it needs eodata's keys,
  and it does not run in the browser.
- Its thresholds come from the chunks that it reads, a quarter of a
  granule or more, not from the whole granule.
- Its temperature uses S5 and S6 only, with no background or mid-infrared
  term. At Caseiro et al.'s 2017 flares, the median of its mean
  temperatures is 1964 K. Their modes are near 1200 and 1750 K.
- A large box holds about 250 MB a granule in memory.
