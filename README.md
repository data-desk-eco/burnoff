# burnoff

A Sentinel-2 L1C flare detector in C, as a DuckDB extension. It reads the
JPEG2000 archive directly. One SQL query searches the CDSE catalogue and
detects flares in a region. No stored detections are necessary. The name
comes from the burnoff project, whose flare thresholds it uses.

```sql
-- duckdb -unsigned -init burnoff/burnoff.sql
from s2_flares_in(-104.2, 31.6, -103.2, 32.6, '2025-05-01', '2025-05-31',
                  max_cloud := 50);
```

## Build

You need a C compiler, `pkg-config`, libcurl and OpenJPEG 2.5 or later. On
Ubuntu, these are `libcurl4-openssl-dev` and `libopenjp2-7-dev`.

```bash
make -C burnoff          # burnoff.duckdb_extension
make -C burnoff install  # so that `load burnoff` works in any directory
```

The extension uses the stable DuckDB C API (v1.2.0). It loads in DuckDB
1.2 or later. It is not signed, so start DuckDB with `-unsigned`.

## Use

`burnoff.sql` loads the extension and the spatial extension, sets the
session for the catalogue, and defines two macros:

- `s2_scenes(w, s, e, n, t0, t1, href := 'eodata')` gives each L1C scene
  that touches a longitude/latitude box between two dates. Each scene has
  its B12 href, its UTM zone, the west and north edges of its MGRS 100 km
  square (`sx`, `sy`), and the box to read, in the metres of that zone.
- `s2_flares_in(w, s, e, n, t0, t1, max_cloud := 100, href := 'eodata',
  thresholds := '')` gives one row for each flare, with lon, lat and the
  detection values.

`eodata` hrefs need the eodata credentials in `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`. CloudFerro machines have
them in `/etc/profile.d/eodata.sh`. Away from CloudFerro, `href := 'gcp'`
reads the same files from the public Google Cloud mirror.

`burnoff.sql` sets `threads = 1`. The detection runs on the extension's own
workers. With more DuckDB threads, the client thread can poll for the
result on a core of its own, which costs approximately 20% of the CPU on
four cores.

The function below the macros is:

```sql
s2_flares(b12 VARCHAR, xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE
          [, thresholds VARCHAR])
  -> STRUCT(clear DOUBLE, error VARCHAR, flares STRUCT(x, y, max_b12,
            avg_b12, peak_b11, ratio, peakedness, pixels, radiance,
            saturated)[])
```

The box is in metres of the UTM zone of the scene. `clear` is the
cloud-free fraction of the observed pixels in the box. It is NULL when
the tile has no data in the box. A failed row has an `error` value, and
the query continues. `thresholds` is `'name=value,...'` over the
defaults in `burnoff.c`.

`BURNOFF_THREADS` sets the number of rows in flight (default four per
core).

## Scenes and squares

The tiles of one UTM zone share a pixel grid and overlap by 9.8 km. Each
scene keeps only the flares in its MGRS 100 km square, so the squares
partition a pass and no flare is found twice. The box that a scene reads
is its square, widened by 2 km and rounded out to the 6.4 km background
cells of the tile. A flare in the square thus has the same background
cells and components as in a run over the whole tile. Against the
earlier full-tile macro, all 473 flares inside their squares in the
Permian test were identical in every value.

Before this partition, a flare in an overlap was kept when either tile
found it. The tiles have different background cells, so some flares were
found in one tile only. That test had 22 such flares out of 490.

Across a zone boundary, the two detections stay.

The catalogue gives a maximum of 1000 scenes for each search, and it
answers a burst of searches with HTTP 429. `s2_scenes` sizes each search
from the box: approximately 200 days for a point, 90 days for one degree
square and 50 days for two. A full page stops the query with an error, so
scenes are never lost without a message.

## How it reads the archive

Sentinel-2 JP2 files before baseline 05.12 have no tile index. GDAL finds
tile *k* with *k* + 1 sequential range requests. burnoff does these steps:

1. It reads the 16 KB header, which gives the tiling and the GMLJP2
   georeferencing. The header is the same on every date of one MGRS
   tile, band and processing baseline (only the Kakadu comments differ),
   so burnoff reads it one time for each. Until a read gives the size of
   a file, burnoff uses the size of the file that it learned the header
   from.
2. It reads the cloud mask (a few KB). It does not fetch JP2 tiles that
   are below cloud, and it decodes each tile only over its clear 320 px
   background cells.
3. It finds each tile-part from a guessed offset. The byte pair 0xFF90
   cannot occur in the coded data, so a scan for the SOT marker finds
   the tile-part. The tile-parts found bracket the one that is wanted,
   and the next read interpolates in the bracket. The offsets change
   little between dates, so burnoff learns them for each MGRS tile and
   band. One read also takes the other wanted tile-parts that the layout
   puts less than 1 MB after the first. If a box needs more than a
   quarter of a band, burnoff reads the full codestream in one request.
4. The main header and one tile-part make a complete codestream.
   OpenJPEG decodes only a window of it.
5. It reads B11 only around components of candidate pixels that can hold
   a peak. It reads B8A only for components with a pixel that is both a
   possible peak and bright in B11, and only where saturation does not
   decide the pixel. Both are exact: the detections do not change.
6. The windows of B11 and B8A are merged while the merged window costs
   less than a second decode. Each decode costs approximately 4 ms
   however small it is, because these files use 8 by 8 code-blocks and
   OpenJPEG parses the packet headers of the whole tile.
7. When fewer rows are in flight than there are cores, a large decode
   uses the free cores.

Headers and cloud masks are kept between rows. Tile-parts are not kept,
and a codestream is freed when its band is decoded.

## Requests

eodata allows 5000 requests a minute for each key. Its responses say so
(`x-ratelimit-limit: 5000;w=60`). Above that rate it answers with 429 and
the number of seconds until the window resets, and burnoff waits that
long. Thus for many small boxes, the request count sets the speed, not
the decoding. A scene with no candidate flares needs approximately two
requests: the cloud mask and the B12 tile-parts. A scene with candidates
also needs B11 and usually B8A. The LNG run below made 3.9 requests for
each scene.

eodata answers a range that starts after the end of a file with 404, not
416. burnoff then reads one byte to learn the size, and continues. A file
that does not exist still fails.

The catalogue search costs approximately 1.3 s for each box and year of
data. Parallel searches were not faster.

## Method

The thresholds are the s2e compact-source defaults. burnoff examines the
whole box in one pass:

- It calculates the background median for each 320-pixel cell, from a
  histogram of the B12 counts.
- It calculates the spectral mask and its 4-connected components.
- It applies the morphological gates.
- It grows the combustion-hot core from the peak of each component.

These are the differences from the s2e block detector:

- There are no overlapping blocks. Components that cross a cell edge are
  joined.
- Pixels with no data are not part of the background.
- Cloud comes from the L1C `MSK_CLASSI_B00` mask (opaque cloud and
  cirrus). CloudSEN is not used.

A numpy and scipy implementation of the same method was run on bands
that GDAL decoded. On one full tile, it gave the same 87 detections.

## Measurements

On CloudFerro, from an eo1.large (4 vCPU, 7.6 GB) in WAW3-2, reading
eodata over S3:

| Query | Before | Now |
| --- | --- | --- |
| 100 by 110 km, May 2025, 56 scenes: wall time | 33 s | 17 s |
| the same: CPU time | 100 to 116 s | 61 s |
| the same: peak memory | 3.4 GB | 1.0 GB |
| 2 km box, all of 2025, 88 scenes | 7 to 10 s | 1.4 to 1.8 s |
| 190 by 220 km, March to May 2025, 315 scenes | not run | 185 s, 1.8 GB |
| 81 LNG export terminals, all of 2025, 11,218 scenes | 14 min | 10 min |

The LNG run used the AOIs in data-desk's
`etl/providers/data-desk/s2e/aoi/lng-terminals.geojson` (boxes of
approximately 4.5 km) on the jump host. It found 11,052 flares at 74
terminals, with no failed rows. The catalogue took 115 s and detection
took 497 s. Detection made 43,930 requests (65,172 before the header and
read changes) at the rate limit, and read 61 GB, approximately 1 Gbit/s.
Both limits apply to one machine with one key.

The large query used all four cores. JPEG2000 decoding is approximately
77% of the CPU time, and 68% is OpenJPEG's entropy decoder. A newer
OpenJPEG (2.5.4), and builds with `-O3 -march=native`, were not faster.
The decoder thus sets the speed, and more cores give more speed.

From a laptop on a home connection, the Google Cloud mirror limits the
speed. A 28 by 22 km box over four months took 15 to 20 s.

## Limits

- burnoff needs baseline N0400 or later, because older products have no
  raster cloud mask.
- If `max_pixels` is more than 100, a component that crosses the edge of
  a square can be cut at the edge of the box.
