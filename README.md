# burnoff

A Sentinel-2 L1C flare detector in C, as a DuckDB extension. It reads the
JPEG2000 archive directly, so one query searches the CDSE catalogue and
detects the flares in a region.

```sql
load spatial;
load burnoff;  -- in duckdb -unsigned
from s2_flares(-104.2, 31.6, -103.2, 32.6, '2025-05-01', '2025-05-31',
                  max_cloud := 50);
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

- `s2_flares(w, s, e, n, t0, t1, max_cloud := 100, source := 'auto',
  thresholds := '')` gives one row for each flare in a lon/lat box
  between two dates.
- `s2_scenes(w, s, e, n, t0, t1, source := 'auto')` gives the scenes that
  the search finds, with the box to read in each.
- `s2_detect(b12, xmin, ymin, xmax, ymax [, thresholds])` detects in one
  scene, over a box in the metres of its UTM zone. A failed row has an
  `error` value, and the query continues.

`source` is `'eodata'` (CDSE's S3, which needs `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`, as on CloudFerro machines)
or `'gcp'` (Google's public mirror, with no credentials). `'auto'` uses
eodata when `AWS_ACCESS_KEY_ID` is set and gcp when it is not.
`thresholds` is `'name=value,...'` over the defaults in `burnoff.c`.

To stop DuckDB's warning about range requests, set `force_download = true`.

## Limits

- burnoff needs baseline N0400 or later, which has a raster cloud mask.
- A search that fills the catalogue's 1000-scene page stops the query.
- Flares in an overlap of two UTM zones are found in both.
