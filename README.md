# burnoff

A Sentinel-2 L1C flare detector in C, as a DuckDB extension. It reads the
JPEG2000 archive directly, so one query searches the CDSE catalogue and
detects the flares in a region.

```sql
load spatial;
load burnoff;  -- in duckdb -unsigned
from s2_flares(ST_MakeEnvelope(-104.2, 31.6, -103.2, 32.6), '2025-05-01',
               t1 := '2025-05-31', max_cloud := 50);
-- around a point, from a date to today
from s2_flares(ST_Buffer(ST_Point(-103.9, 32.1), 0.05), '2025-01-01');
-- for each row of a table of areas
from aois, lateral s2_flares(aois.geom, '2025-01-01');
```

## Build

You need a C compiler, `pkg-config`, libcurl and OpenJPEG 2.5 or later
(`libcurl4-openssl-dev` and `libopenjp2-7-dev` on Ubuntu).

```bash
make -C burnoff          # burnoff.duckdb_extension
make -C burnoff install  # so that `load burnoff` works in any directory
```

The extension loads in DuckDB 1.2 or later. It is not signed, so start
DuckDB with `-unsigned`.

## Use

Load spatial first.

- `s2_flares(g, t0, t1 := today, max_cloud := 100, source := 'auto',
  thresholds := '')` gives one row for each flare in a lon/lat geometry
  from t0 to t1. A point has no area, so buffer it.
- `s2_scenes(g, t0, t1 := today, source := 'auto')` gives the scenes that
  the search finds, with the box to read in each.
- `s2_detect(b12, xmin, ymin, xmax, ymax [, thresholds])` detects in one
  scene, over a box in the metres of its UTM zone. A failed row has an
  `error` value, and the query continues.

`source` is `'eodata'` (CDSE's S3, which needs `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`, as on CloudFerro machines)
or `'gcp'` (Google's public mirror, with no credentials). `'auto'` uses
eodata when `AWS_ACCESS_KEY_ID` is set and gcp when it is not.
`thresholds` is `'name=value,...'` over the defaults in `burnoff.c`.

## Limits

- burnoff needs baseline N0400 or later, which has a raster cloud mask.
- A search that fills the catalogue's 1000-scene page stops the query.
- Flares in an overlap of two UTM zones are found in both.
