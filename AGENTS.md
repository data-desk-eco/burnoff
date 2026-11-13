# burnoff

The Data Desk hotspot detector, Sentinel-2 by day and Sentinel-3 by
night: a DuckDB extension, and a service on the jump host that runs it
for the Aerial map (`~/Tools/aerial`). `README.md` documents the API and
the extension; this file is for work on the code. `make test` checks
that the extension loads, offline.

## Layout

- `src/burnoff.c`, `src/burnoff.h`: shared DuckDB bindings, reads and workers.
- `src/mem.c`: a job's memory (`mem`, `remem`, `unmem`, `let`).
- `src/s2.c`: the Sentinel-2 detector and its DuckDB result binding.
- `src/band.c`: a band file's header, tile-parts and reads, and the
  caches jobs share.
- `src/j2k.c`: the JPEG 2000 decoder.
- `src/s3.c`: the Sentinel-3 SLSTR night detector and its result binding.
- `src/h5.c`: the HDF5 reader for a granule's netCDF-4 files.

`burnoff.c`, `mem.c`, `s2.c` and `s3.c` compile separately. `s2.c`
includes `j2k.c` then `band.c`, and `s3.c` includes `h5.c`, as text: each
is read and changed alone, but is not a unit of its own. `j2k.c` and
`h5.c` parse bytes and know nothing of reads or DuckDB; `band.c` names
reads on a job.
- `src/burnoff.sql`: macros run on load (`s2_scenes`, `s2_hotspots`,
  `s3_scenes`, `s3_hotspots`, `s3_flares`).
- `serve/`: the service, which `make serve` builds for.

Keep it a detector. Archive shapes and publishing belong to the
data-desk ETL (`etl/fetch/burnoff`), which loads the extension that
`make serve` builds on the box, so its runs detect as the service does.
The extension uses the stable C API of DuckDB 1.2 (`C_STRUCT`), so one
build loads on 1.2 to 2.0; `src/duckdb*.h` are 2.0.0's.

## The detector

The S2 detector runs in stages: headers and the 60 m cloud mask; B12;
background, candidates and windows; B11 and B8A around the
candidates; detections. Each stage names all its byte-range reads before
any is made (a round), then its decodes. The host makes the reads at
once (curl multi). The detector then resumes its stage.

- With a TLM (N0512 on), PLTs give packet lengths and only the packets
  a window needs are read. Without one, an SOT search with learned
  layouts finds the tile-parts, read whole, and shares what it found
  (`share()`).
- A site takes 3 rounds. Reads are cut to bytes not already in hand
  (`want()`/`fill()`). Under the eodata budget (5000 requests a minute)
  tile-parts are read whole.
- A decode of 1024 code-blocks or more spreads over the cores other
  rows leave idle (`spread()`).
- A job's memory is its own (`mem`, `remem`, `unmem` in `mem.c`):
  pages mapped for it and all unmapped when it ends, so a long-running
  DuckDB does not keep what jobs freed. A piece over 256 KB is its own
  mapping: `unmem` keeps it for the job's next piece of its size (up to
  16 MB kept, so a decode's planes are not mapped again for each tile),
  else unmaps it. Smaller ones wait for the job's end. Every piece comes
  zeroed. What outlives the job, its results and the shared caches, is
  `malloc`'s: never `free` a `mem` piece, nor `unmem` a `malloc` one.
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
found`. Over https too, where dates without a TLM share a query: 2 of 18
Permian scenes (T13SER, N0511, May 2025) failed so in 3 of 5 runs.

The store digests (`V`, `V3`, which `make serve` writes to `ext/env`)
include the shared host and header, plus each detector's sources. An
S2-only change leaves S3 unchanged, and conversely. A digest marks the
detector that made each row; it does not make the service read cells
again. A cell held is kept whatever the detector. To read cells again
after a change of output, delete their rows by `v` in `schema.sql`.

## The night detector

`s3.c` reads SLSTR L1B (`SL_1_RBT`) granules, netCDF-4 files of a
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

On the data desk box (CloudFerro WAW3-2, beside eodata), run from the
checkout `/srv/burnoff` by data-desk's units (`infra/systemd/burnoff*`,
with the keys as systemd credentials) behind its caddy: one DuckDB 2.0
(the box's, `server.sql`) holding the store and serving Quack on
localhost:9494, at `https://dev.datadesk.eco/quack`. Each start runs
`make serve`, which builds the extension, the digests and the seeds when
their sources change, and checks the DuckDB version. To deploy:

```sh
ssh eouser@dev.datadesk.eco \
  'git -C /srv/burnoff pull -q && sudo systemctl restart burnoff'
```

A restart drops the requests in flight.

- `api.sql`'s gate (`quack_authorization_function`) sees every query.
  `FROM s2_hotspots(...)` or `s2_sites(...)` runs `args.sql`, `hotspots.sql`,
  `box.sql`, then `geojson.sql` or `sites.sql`; the `s3_` forms run the
  `s3*.sql` equivalents. A script after `admin <key>` (`q`, the key in
  the `burnoff` credential) runs as it is; anything else is refused. Macros
  live in `api.sql`; per-request tables are `CREATE OR REPLACE TEMP`.
- Cells come from the store, else one `s2_detect` of those missing; new
  cells and their hotspots are added in one transaction, marked with the
  detector's digest `v`.
- The gate keeps each public answer (`answer.sql`, `db.answers`) under its
  key: the call, its box, its window resolved to dates, and `v`. A
  request whose answer is fresh (`api.sql`'s `fresh`) gets it back without
  running a script. As `v` is in the key, a new detector makes each answer
  again, from the store. An answer is fresh while no other request's read
  has added cells or hotspots within 0.1° of its box since it began (`db.touched`, written after each read commits). For a
  window that ends within a week of today (3 days for S3), or one where a
  read failed, it is fresh for an hour. A request that makes an answer
  again first adds a row with no geojson; for 2 minutes, others get the
  last answer and do not make it too. The cache holds nothing that the
  store does not: emptied, every answer is made again the same.
  `prune.sql` (hourly, through `export.sh`) drops replaced answers and
  month-old rows.
- Every request's reads share one queue of `BURNOFF_THREADS` workers (8 on
  the jump host), so many requests at once wait in turn and do not hold
  more memory. Two requests that miss the same scene both read it, and the
  store keeps it twice (readers take distinct rows).
- `sites.sql` links every date's detections within 550 m of the box by
  constrained single linkage (40 m, never two of one date over 30 m
  apart) and names a site by its mean place rounded to 40 m, so a site
  and its id depend on the store alone. Keep its sums integer (whole
  cm). `s3sites.sql` is the same at 750 m links, 250 m ids. Both use
  `api.sql`'s `linked` macro for constrained single linkage.
- The store (`store.duckdb`, `schema.sql`) is in the unit's state
  directory, `/var/lib/data-desk/burnoff` on the data volume, and is a
  cache of eodata. It has no keys: concurrent appends of one key conflict in
  DuckDB, so readers take distinct rows. Cells lead with tile and
  sensing time and are read by them.
- Sentinel-3 granules come from CDSE's STAC, searched a 1° square and a
  day at a time (`s3_searched`). `s3url` maps a granule's eodata dir to
  what is read; a local test can read MEEO's public mirror
  (`https://meeo-s3.s3.eu-central-1.amazonaws.com/NTC/`) instead.
- `index.sh` (daily) indexes eodata's scenes. `bulk.sh`, by hand
  (`systemctl start burnoff@bulk`), fills the store around the
  archive's sites. `export.sh` (hourly) merges the store's S2 rows into
  the archive's `data-desk/burnoff/{observations,detections}`, one file
  per H3 res-1 cell, rewriting only partitions with new keys; an empty
  store is seeded from the archive. S3 is not exported yet.
- `load.sh` puts a load on a service as aerial would: N visitors over a
  few views, each its blocks over aerial's windows. Run it against a test
  instance, never `dev.datadesk.eco`.
- The units are `burnoff` and `burnoff@<script>`; a failure opens an
  issue through data-desk's `failed@`. The export runs inside the service,
  under its `memory_limit` and `temp_directory`.

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
- Memory: six months of Permian hotspots (gcp, 1°) in one DuckDB on an
  eo1.large hold 422 MB after, against 824 MB with `malloc` for the jobs
  (peak about 1.1 GB either way, same time). On the box from eodata
  (13 November 2026), 56 scenes and 15 granules (whole and chained)
  through one DuckDB hold 150 MB (S2) and 405 MB (S3) after, against
  290-440 MB and 530-660 MB with `malloc`, peaks within 10%. A test
  service (port 9495, empty store) under 6 clients at once (72 cold
  requests, 3 months each) peaked at 680 MB and held 340 MB after.
- `load.sh`, 20 visitors at once over Ras Laffan (234 requests each), on
  an eo1.large like the jump host, store warm, from a laptop: main, 861 s,
  p50 11.7 s, 303 errors; with the answers kept, 76 s, p50 0.65 s, 19
  errors (CDSE's search, failing under the first crowd), and 38 s, p50
  0.56 s, none, once kept.
