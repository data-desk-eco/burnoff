# burnoff

Burnoff is a DuckDB extension for detecting gas flares in Sentinel-2 L1C
imagery. It reads the JPEG2000 archive directly, so one query searches the
CDSE catalogue and detects the flares in a region. Each flare comes with its
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
from s2_flares(ST_MakeEnvelope(-104.2, 31.6, -103.2, 32.6), '2025-05-01',
               t1 := '2025-05-31', max_cloud := 50);
-- around a point, from a date to today
from s2_flares(ST_Buffer(ST_Point(-103.9, 32.1), 0.05), '2025-01-01');
-- for each row of a table of areas
from aois, lateral s2_flares(aois.geom, '2025-01-01');
```

## Build

Requires a C compiler, `pkg-config`, libcurl and OpenJPEG 2.5 or later
(`libcurl4-openssl-dev` and `libopenjp2-7-dev` on Ubuntu, `openjpeg` in
Homebrew).

```sh
make              # ext/burnoff.duckdb_extension
make test         # loads it and runs a detection offline
make install      # so that `load burnoff` works in any directory
```

## Functions

- `s2_flares(g, t0, t1 := today, max_cloud := 100,
  thresholds := '')` gives one row for each flare in a lon/lat geometry
  from t0 to t1. A point has no area, so buffer it.
- `s2_scenes(g, t0, t1 := today)` gives the scenes that
  the search finds, with the box to read in each.
- `s2_detect(b12, xmin, ymin, xmax, ymax [, thresholds])` detects in one
  scene, over a box in the metres of its UTM zone. It gives the box's
  `clear` share, an `error` (a failed row does not stop the query), the
  `flares`, and `cells`: the centre and obscured share (`cloud`: cloud, no
  data, or a background cell too cloudy to read) of each 640 m square of
  the box. A look at a site is clear when its square's `cloud` is low.

An optional `source` is `'eodata'` (CDSE's S3, which needs `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`, as on CloudFerro machines)
or `'gcp'` (Google's public mirror, with no credentials). The default, `'auto'`, uses
eodata when `AWS_ACCESS_KEY_ID` is set and gcp when it is not.
`thresholds` is `'name=value,...'` over the defaults in `src/burnoff.c`.

## Limits

- burnoff needs baseline N0400 or later, which has a raster cloud mask.
- A search that fills the catalogue's 1000-scene page stops the query.
- Flares in an overlap of two UTM zones are found in both.
