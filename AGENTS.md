# burnoff

The Data Desk hotspot detector, Sentinel-2 by day and Sentinel-3 by
night: a DuckDB extension, and a service on the jump host that runs it
for the Aerial map (`~/Tools/aerial`). `README.md` documents the API and
the extension; this file is for work on the code. `make test` checks
that the extension loads, offline.

## Layout

- `src/burnoff.c`: the Sentinel-2 detector and its DuckDB and curl host.
- `src/j2k.c`: the JPEG 2000 decoder.
- `src/slstr.c`: the Sentinel-3 SLSTR night detector (`s3_detect`), on
  the same jobs and host.
- `src/burnoff.sql`: macros run on load (`s2_scenes`, `s2_hotspots`,
  `s3_scenes`, `s3_hotspots`, `s3_flares`).
- `serve/`: the service (`serve/deploy.sh`).

Keep it a detector. Archive shapes and publishing belong to the
data-desk ETL (`etl/providers/data-desk/burnoff/`), which pins the
`burnoff-linux_amd64.duckdb_extension` of a `v*` release.

## The detector

A detection is a job (`step()`) in stages: headers and the 60 m cloud
mask; B12; background, candidates and windows; B11 and B8A around the
candidates; detections. Each stage names all its byte-range reads before
any is made (a round), then its decodes. The host makes the reads at
once (curl multi) and steps again.

- With a TLM (N0512 on), PLTs give packet lengths and only the packets
  a window needs are read. Without one, an SOT search with learned
  layouts finds the tile-parts, read whole, and shares what it found
  (`share()`).
- A site takes 3 rounds. Reads are cut to bytes not already in hand
  (`want()`/`fill()`). Under the eodata budget (5000 requests a minute)
  tile-parts are read whole.
- A decode of 1024 code-blocks or more spreads over the cores other
  rows leave idle (`spread()`).
- `nir_excess` rejects sunlight: a peak's B8A rise must be under 0.1 of
  its B12 rise. It cut London's detections from 20,224 to 1,451 a year
  and kept Permian flares (327 to 315 sites).

## Exactness

A change must keep every detection, clear share and cell identical,
field for field, against a baseline: 588 boxes over 14 scenes
(N0400-N0513), through DuckDB at several rows. `j2k.c` must equal
OpenJPEG 2.5 sample for sample, and refuses any codestream shape the
L1C baselines do not use. Over file://, run each date's boxes in its
own process: a header cached from another date can give `tile-part not
found`.

A change to `burnoff.c`, `j2k.c` or `slstr.c` changes the store's
digests (deploy.sh's `V`, `V3`), and the service reads every cell
again. Where the output is unchanged, relabel the store's rows in
`schema.sql`.

## The night detector

`slstr.c` reads SLSTR L1B (`SL_1_RBT`) granules, netCDF-4 files of a
few deflated chunks per variable, with its own reader of the HDF5 they
use: superblock v2, v2 object headers, compact or heap links and
attributes, v3 chunked layout, a v1 B-tree leaf, shuffle and deflate.
Anything else is an error.

- A job's stages: the sun (`sza_min`); the heads of 7 files; every
  chunk index with the tie-point grid; S5, its exception flags and the
  cloud mask over the box; if S5 has a hot pixel, S6 and the per-pixel
  geolocation under hot pixels; the clusters; S7 and F1 only if S6
  leaves a cluster unconfirmed; the hotspots.
- The tie-point grid places the box only. It is ~200-400 m off on flat
  ground and up to 2 km over hills, so hotspots are placed by
  `geodetic_an`.
- `start_offset` changed meaning between baselines: rows map by index.
- Before baseline 004, F1 is `F1_BT_in`; a 404 on `F1_BT_fn` switches
  to it.
- A band's threshold is Caseiro et al.'s lowest unheld DN, counted from
  the histogram's mode over the chunks read.
- Exception bit 2 (a neighbour's copy) is never a candidate; bit 16
  (saturated) always is. The night cloud tests flag most hot pixels, so
  `clear` leaves hot pixels out and the mask never removes a detection.
- The rows of one chunk that name one granule run as one job, box after
  box, sharing reads and inflated chunks (`same`, `keep`, `s3k`). Order a
  many-site query by granule.
- A whole-granule box holds ~250 MB. The jump host runs out at 8 jobs
  beside the service; use `BURNOFF_THREADS`.
- The L1B's geolocation is off by platform and swath column (`track`):
  S3A's north offset runs from +1.9 km at one swath edge to -0.45 km at
  the other, S3B sits 300-500 m west. The service corrects it at read
  (`s3at`, a quadratic in track per platform, fitted against 60 isolated
  S2 flares over 2017-2026): median error ~200 m for S3A, 160-190 m for
  S3B.

## The service

On the jump host (CloudFerro WAW3-2, beside eodata), deployed by
`serve/deploy.sh`, run by systemd behind caddy: one DuckDB 2.0
(`/opt/burnoff/duckdb`, `server.sql`) holding the store and serving
Quack on localhost:9494, at `https://dev.datadesk.eco/quack`.

- `api.sql`'s gate (`quack_authorization_function`) sees every query.
  `FROM hotspots(...)` or `sites(...)` runs `args.sql`, `hotspots.sql`,
  `box.sql`, then `geojson.sql` or `sites.sql`; the `s3_` forms run the
  `s3*.sql` equivalents. A script after `admin <key>` (`q`, the key in
  `/data/burnoff/env`) runs as it is; anything else is refused. Macros
  live in `api.sql`; per-request tables are `CREATE OR REPLACE TEMP`.
- Cells come from the store, else one `s2_detect` of those missing; new
  cells and their hotspots are added in one transaction, under the
  detector's digest `v`.
- `sites.sql` links every date's detections within 550 m of the box by
  constrained single linkage (40 m, never two of one date over 30 m
  apart) and names a site by its mean place rounded to 40 m, so a site
  and its id depend on the store alone. Keep its sums integer (whole
  cm). `s3sites.sql` is the same at 750 m links, 250 m ids.
- The store (`/data/burnoff/store.duckdb`, `schema.sql`) is a cache of
  eodata. It has no keys: concurrent appends of one key conflict in
  DuckDB, so readers take distinct rows. Cells lead with tile and
  sensing time and are read by them.
- Sentinel-3 granules come from CDSE's STAC, searched a 1° square and a
  day at a time (`s3_searched`). `s3url` maps a granule's eodata dir to
  what is read; a local test can read MEEO's public mirror
  (`https://meeo-s3.s3.eu-central-1.amazonaws.com/NTC/`) instead.
- `index.sh` (daily) indexes eodata's scenes. `bulk.sh`, by hand
  (`systemctl start burnoff-bulk`), fills the store around the
  archive's sites. `export.sh` (hourly) merges the store's S2 rows into
  the archive's `data-desk/burnoff/{observations,detections}`, one file
  per H3 res-1 cell, rewriting only partitions with new keys; an empty
  store is seeded from the archive. S3 is not exported yet.
- Units fail to `data-desk-failed@` and log as `burnoff-<unit>`. The
  export runs inside the service, under its `memory_limit` and
  `temp_directory`. A deploy restarts the service only when a file
  changed.

## Measured

- M2: a whole S2 tile, 4.6 s on one core; 70 tiles at 8 rows, 10.2 s;
  518 sites, 4.8 s.
- Sites on the archive's 53,905 detections (Feb-Oct 2026): ids from
  halves of the date range keep 88-89% of detections against the whole.
  The densest box (Kerman, ~1,000 detections) takes 0.45 s.
- S3 against Caseiro et al.'s 2017 flaring cells: 738 of their 770 in
  the Persian Gulf, 122 of 125 in the Niger Delta, 103 of 112 at 33
  random sites; 99.7% of hotspots confirmed. Against ESA's SL_2_FRP,
  95% of ours lie within 1 km of theirs.
- S3 against VIIRS Nightfire (2023 Q1, 11 regions): radiant heat 0.87 of
  VNF's (log r 0.88); nights caught 40% at 1-2 MW, 79% over 20 MW.
- S3 reads: 6.4 MB a granule for a 0.1° site; deployed, Ras Laffan 0.5°
  for 90 days in 10.9 s cold, 2.0 s warm.
