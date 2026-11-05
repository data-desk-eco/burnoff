# burnoff

Hotspot detection for the Data Desk [Aerial](https://github.com/data-desk-eco/aerial)
map: Sentinel-2 by day and Sentinel-3 by night. Available as a hosted API
and a DuckDB extension. Both detectors read only the parts of the source
imagery they need.

| | Sentinel-2 | Sentinel-3 |
| --- | --- | --- |
| Imagery | MSI L1C, 20 m | SLSTR L1B, 500 m |
| Detection | Daytime SWIR hotspots, with a near-infrared test to reject reflected sunlight | Night-time SWIR hotspots, confirmed in other infrared bands |
| Results | Position, brightness, radiance and pixel outlines | Position, temperature, radiant heat and pixel count |

## Hosted API

Connect with DuckDB 2.0's [Quack](https://duckdb.org/docs/2.0/quack/overview)
protocol at `quack:dev.datadesk.eco:443`, token `burnoff`. The public API
accepts four queries, each returning one `geojson` column in one row:

```sql
FROM s2_hotspots(w, s, e, n[, 'start', 'end'])
FROM s2_sites(w, s, e, n[, 'start', 'end'])
FROM s3_hotspots(w, s, e, n[, 'start', 'end'])
FROM s3_sites(w, s, e, n[, 'start', 'end'])
```

Bounds are longitude and latitude: at most 0.44° × 0.25° for S2 or
1° × 1° for S3. Dates are ISO dates; `'..'` leaves an end open. Omit
both dates for the last 90 days.

```sql
INSTALL quack; LOAD quack;
FROM quack_query('quack:dev.datadesk.eco:443',
  'FROM s2_sites(-103.6, 31.9, -103.5, 32, ''2026-08-01'', ''2026-10-30'')',
  token := 'burnoff');
```

Use `s3_sites` for the night-time view. Browser clients can use the
[Quack SDK](https://github.com/tobilg/quack-protocol) at
`https://dev.datadesk.eco`. Results are cached; new areas take seconds
to read, while cached areas usually return in under a second.

### Hotspots

Both `*_hotspots` queries return a GeoJSON feature collection with
`look` features for observations, `hotspot` features for detections and
`error` features for failed reads.

| | S2 | S3 |
| --- | --- | --- |
| Look | One per scene; `cloud` is the obscured share of the box, or `-1` outside coverage | One per night-time granule; `clear` is the clear share, excluding hot pixels; `date` is the local evening |
| Hotspot | Pixel multipolygon; `pixel_b12` gives each pixel's B12 value | Point with `rh` (MW), `temperature` (K), `pixels` and `confirmed` |

### Sites

Both `*_sites` queries group stored detections into point features.
Sites are built from all stored dates; the requested dates select their
observations. Properties include `id`, `looks` (`[[date, cloud], …]`),
`detections` and `detection_count`.

| | S2 | S3 |
| --- | --- | --- |
| Grouping | Peak pixels linked within 40 m; same-date detections over 30 m apart stay separate | Hotspots linked within 750 m; hotspots from the same granule stay separate |
| ID | Mean position rounded to 40 m: `live:<lat>,<lon>` | Mean position rounded to 250 m: `s3:<lat>,<lon>` |
| Looks | Cloud share in the site's 640 m square | Cloud share in the site's 0.02° square, from the clearest granule each night |
| Detections | Brightest detection each date, with pixels | Hotspots summed within the brightest granule each night: `rh`, `pixels`, `hotspots` |

IDs can move as observations are added, especially for S3. Match returning
S3 sites within about 600 m. The service corrects S3's systematic
geolocation error; about 90% of corrected positions are within 500 m of
the flare.

The service runs beside Copernicus eodata in CloudFerro's WAW3-2 region.
Deployment and service SQL are in [`serve/`](serve/); development and
operational notes are in [`AGENTS.md`](AGENTS.md).

## DuckDB extension

Download the macOS ARM64 or Linux AMD64 binary from the
[latest release](https://github.com/data-desk-eco/burnoff/releases/latest).
For macOS:

```sh
curl -fL https://github.com/data-desk-eco/burnoff/releases/latest/download/burnoff-osx_arm64.duckdb_extension -o burnoff.duckdb_extension
duckdb -unsigned -c "force install './burnoff.duckdb_extension'"
```

For Linux, use `burnoff-linux_amd64.duckdb_extension`. Requires DuckDB
1.2 or later, started with `-unsigned`. Load spatial before burnoff:

```sql
LOAD spatial;
LOAD burnoff;

FROM s2_hotspots(ST_MakeEnvelope(-104.2, 31.6, -103.2, 32.6),
                '2025-05-01', t1 := '2025-05-31', max_cloud := 50);
FROM s3_hotspots(ST_MakeEnvelope(51.4, 25.8, 51.7, 26.0),
                '2025-01-01', t1 := '2025-01-31');
```

Unlike the hosted API, these functions return detection rows, not GeoJSON.
`g` is a lon/lat geometry (buffer points to give them area); `t1` defaults
to today. Use a lateral join to query a table of areas:

```sql
FROM aois, LATERAL s2_hotspots(aois.geom, '2025-01-01');
```

### Sentinel-2

| Function | Returns |
| --- | --- |
| `s2_hotspots(g, t0, t1 := today, max_cloud := 100, thresholds := '')` | One row per hotspot |
| `s2_scenes(g, t0, t1 := today)` | Scenes and the box to read in each |
| `s2_detect(b12, xmin, ymin, xmax, ymax [, thresholds])` | One scene's `clear`, `error`, `hotspots` and 640 m `cells` with obscured share (`cloud`); bounds are metres in the scene's UTM zone |

The search functions accept `source := 'gcp'` for Google's public mirror
or `'eodata'` for CDSE S3. The default, `'auto'`, chooses eodata when
`AWS_ACCESS_KEY_ID` is set, otherwise gcp. Eodata also needs
`AWS_SECRET_ACCESS_KEY` and `AWS_S3_ENDPOINT`.

The detector reads the cloud mask and B12, then B11 and B8A around
candidates. The `nir_excess` test rejects peaks whose B8A rise is at
least 0.1 of their B12 rise, to remove reflected sunlight.
`thresholds` accepts `'name=value,...'`; defaults are in
[`src/burnoff.c`](src/burnoff.c).

Requires baseline N0400 or later. Searches that fill the catalogue's
1,000-scene page fail rather than return partial results. Detections in
UTM-zone overlaps appear in both zones.

### Sentinel-3

| Function | Returns |
| --- | --- |
| `s3_hotspots(g, t0, t1 := today, thresholds := '')` | One row per hotspot, with the granule's sun zenith angle (`sza`) and `clear` share |
| `s3_scenes(g, t0, t1 := today, night := true)` | Granules from CDSE, keeping the newest processing baseline per orbit; night searches select ascending passes, around 22:00 local time |
| `s3_detect(dir, w, s, e, n [, thresholds])` | One `.SEN3` directory's `sza`, `clear`, `error`, `hotspots` and 0.02° `squares`; bounds are lon/lat |
| `s3_flares(g, t0, t1 := today, t_min := 1500, min_passes := 5)` | 0.025° cells with hotspots above `t_min` K, confirmed on more than `min_passes` passes; intended for a year of observations |

S3 requires eodata credentials. The detector follows Caseiro et al.
(2018, *Remote Sensing* 10:1118; 2020, *ESSD* 12:2137): adjacent hot S5
pixels form a hotspot, confirmed by S6 or, failing that, S7 or F1.
Band thresholds are estimated from the chunks read. Granules with
`sza < 90°` produce no hotspots or clear share.

Each hotspot includes `lon`, `lat`, swath column `track`, `pixels`,
background-subtracted radiance sums `s5` and `s6`, `temperature` (K),
`rh` (radiant heat, MW), `saturated` and `confirmed`. Temperature and heat
are derived from S5 and S6 without atmospheric correction; saturated
hotspots have no temperature. `clear` excludes hot pixels, and clouds
do not remove detections. Defaults are in [`src/slstr.c`](src/slstr.c).

The extension uses product geolocation without the service's correction:
systematic errors can approach 2 km. `exact=0` uses the less accurate
tie-point grid to save reads. A whole granule needs about 250 MB of
memory. Sensitivity falls below a few MW: the detector catches about half
the nights seen by VIIRS Nightfire at 2–3 MW, and few below 1 MW.

### Build

Requires a C compiler, `pkg-config`, libcurl and zlib
(`libcurl4-openssl-dev` and `zlib1g-dev` on Ubuntu).

```sh
make              # ext/burnoff.duckdb_extension
make test         # loads the extension and runs an offline detection
make install      # makes LOAD burnoff work from any directory
```
