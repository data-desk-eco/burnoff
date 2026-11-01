# burnoff

The Data Desk Sentinel-2 hotspot detector: a DuckDB extension, a
WebAssembly build for the browser, and a service on the jump host.
`README.md` documents the API and the extension; this file is for work on
the code. `make test` checks that the extension loads, offline.

## Layout

- `src/burnoff.c`: the detector and its DuckDB and curl host.
- `src/j2k.c`: the JPEG 2000 decoder (headers, packets, tier-2, the
  CPU's tier-1 and inverse 5/3 DWT).
- `src/slstr.c`: the Sentinel-3 SLSTR night detector (`s3_detect`), on
  the same jobs and host; native only, as eodata needs its keys.
- `web/j2k.wgsl`: tier-1, the DWT and B12's screen on the GPU, for
  `src/gpu.c` (wgpu-native) and `web/gpu.js` (WebGPU).
- `src/burnoff.sql`: macros run on load (`s2_scenes`, `s2_hotspots`).
- `web/burnoff.c`, `web/worker.js`: the browser build (`make wasm`).
- `serve/`: the service (`serve/deploy.sh`).

Keep it a detector. Archive shapes, sites and publishing belong to the
data-desk ETL (`etl/providers/data-desk/burnoff/`), which pins the
`burnoff-linux_amd64.duckdb_extension` of a `v*` release.

## The detector

A detection is a job (`step()`) in stages: headers and the 60 m cloud
mask; B12; background, candidates and windows; B11 and B8A around the
candidates; detections. Each stage names all its byte-range reads before
any is made (a round), then its decodes. The host makes the reads at once
(curl multi natively, `fetch()` in the browser) and steps again.

- With a TLM (N0512 on), PLTs give packet lengths and only the packets a
  window needs are read. Without one, an SOT search with learned layouts
  finds the tile-parts, read whole, and shares what it found (`share()`).
- A site takes 3 rounds. Reads are cut to bytes not already in hand
  (`want()`/`fill()`). Under the eodata budget (5000 requests a minute)
  tile-parts are read whole.
- Code-block reads for B11 and B8A (`j->cb`) are only for slow links
  (`saveData`, 2g/3g, `worker.js?cb=1`). A measured link speed was tried
  and overran Chrome under Aerial's load.
- Decodes go to the GPU for stages of 4096 code-blocks or more, else the
  CPU, which is the reference.
- GPU traps (M2, under load): passes must not overlap, so a stage's
  dispatches share one pass; Metal can skip a pass unreported, so each
  ends with a canary (`mark`) and a stage without it is redone on the CPU.
- `nir_excess` rejects sunlight: a peak's B8A rise must be under 0.1 of
  its B12 rise. It cut London's detections from 20,224 to 1,451 a year
  and kept Permian flares (327 to 315 sites).

## Exactness

A change must keep every detection, clear share and cell identical,
field for field, against a baseline: 588 boxes over 14 scenes
(N0400-N0513), natively, through DuckDB at several rows, and in headless
Chrome with WebGPU on and off. `j2k.c` must equal OpenJPEG 2.5 sample for
sample, and the GPU must equal the CPU. `j2k.c` refuses any codestream
shape the L1C baselines do not use. The cell table (`table()`) turns
`screen()`'s comparisons into DN cuts so the GPU matches; change both
sides together. Over file://, run each date's boxes in its own process:
a header cached from another date can give `tile-part not found`.

## The night detector

`slstr.c` reads SLSTR L1B (`SL_1_RBT`) granules, netCDF-4 files of a few
deflated chunks per variable (S5: 4 of 1201x1500), with its own reader
of the HDF5 that they use: superblock v2, v2 object headers, compact or
heap links and attributes (one direct block), v3 chunked layout, a v1
B-tree leaf, shuffle and deflate (zlib). Anything else is an error.

- A job's stages: the sun (`sza_min`), then the heads of 7 files (24 KB,
  geodetic_an's 40 KB, as its links lie past 27 KB; read further while a
  link is not found); every chunk index with the
  tie-point grid; S5, its exception flags and the cloud mask over the
  box; if S5 has a hot pixel, S6 and the per-pixel geolocation of the
  chunks under hot pixels; the clusters; S7 and F1 (one 2.4 MB chunk
  each) only if S6 leaves a cluster unconfirmed; the hotspots. A stage
  drops the files it is done with.
- The tie-point grid places the box only: an's row i is its row i/2 and
  column j its column `to_tx - (to_an - j) / 32` (track offsets). It is
  ~200-400 m off on flat ground and up to 2 km over hills (terrain
  parallax), so hotspots are placed by `geodetic_an`.
- `start_offset` changed meaning between baselines (2017's an grid gives
  the 1 km value, 2025's twice it): rows map by index, not by it.
- Before baseline 004, F1 is `F1_BT_in` (1 km in grid) not `F1_BT_fn`;
  a 404 on `F1_BT_fn` switches to it.
- A band's threshold is Caseiro et al.'s lowest unheld DN, but from the
  histogram's mode, not their 1000th brightest pixel (which in a gulf
  granule lies among the flares), and over the chunks read: holding 1/w
  of the granule, w empty DN levels in a row (as likely, for Poisson
  counts, as one level over the whole). On a whole 2025 gulf granule
  this equals their value (S5 0.2303).
- Exception bit 2 (pixel absent, a neighbour's copy) is no candidate;
  bit 16 (saturated) always is. The night cloud tests flag most hot
  pixels (58% of a gulf granule's, `medium_high`), so `clear` leaves hot
  pixels out and the mask never removes a detection.
- The rows of one `s3_detect` chunk that name one granule run as one job
  on one worker, box after box, sharing its reads (`same`, `keep`): the
  heads, tie points and any chunk two boxes share are read once. Order a
  many-site query by granule so they share a chunk. 8 gulf sites over 24
  granules: 953 MB and 4.05 rounds a box to 300 MB and 0.69, 22 s to 8,
  every field the same.
- Memory: a whole-granule box holds ~250 MB a job (float rasters of S5,
  its flags, S6 and the hot pixels' places). The jump host runs out at 8
  jobs beside the service; use `BURNOFF_THREADS`.

## The browser

`web/worker.js` holds several jobs per worker, falls back to the CPU
without WebGPU, reads `gs://` through Google's JSON API, and keeps file
pieces (64 MB in memory, 1 GB in the Cache API) and finished results
(IndexedDB, keyed by call and wasm hash). The Aerial map
(`~/Tools/aerial`, branch `burnoff-live`) uses it only when the service
fails.

## The service

On the jump host (CloudFerro WAW3-2, beside eodata), deployed by
`serve/deploy.sh`, run by systemd behind caddy: one DuckDB 2.0
(`/opt/burnoff/duckdb`, `server.sql`) holding the store and serving Quack
on localhost:9494, at `https://dev.datadesk.eco/quack`.

- `api.sql`'s gate (`quack_authorization_function`) sees every query.
  `FROM hotspots(w, s, e, n[, 'a', 'b'])` or the same of `sites` runs
  `args.sql`, `hotspots.sql`, `box.sql`, then `geojson.sql` or
  `sites.sql`; a script after `admin <key>` (`q`, the key in
  `/data/burnoff/env`) runs as it is; anything else is refused. A script
  answers with its first SELECT's rows, so checks before the answer are
  variables. Macros live in `api.sql` (one catalog for every
  connection); per-request tables are `CREATE OR REPLACE TEMP`.
- Cells come from the store, else one `s2_detect` of those missing; new
  cells and their hotspots are added in one transaction, keyed by the
  detector's digest `v`.
  `sites.sql` links every date's detections within 550 m of the box
  (`m`) by constrained single linkage (40 m, never two of one date over
  30 m apart in a site) and names a site by its mean place rounded to
  40 m, so a site and its id depend on the store alone, not on the
  request. Keep its sums integer (whole cm): float sums can round
  differently.
- The store is `/data/burnoff/store.duckdb` (`schema.sql`; deploy.sh
  copied the old SQLite store into it once). It is a cache: everything in
  it can be read again from eodata. It has no keys: concurrent appends of
  one key conflict in DuckDB, so a request adds what the store lacks and
  readers take distinct rows. Cells lead with tile and sensing time and
  are read by them: scenes' names share their first 8 bytes, so zonemaps
  on `scene` skip nothing (0.45 s a request to 0.02).
- `index.sh` (daily) indexes eodata's scenes. `bulk.sh`, by hand
  (`systemctl start burnoff-bulk`), fills the store around the archive's
  sites.
- `export.sh` (hourly) merges the store into the archive's
  `data-desk/burnoff/{observations,detections}`, one file per H3 res-1
  cell. The archive is the record: the store's rows replace the archive's
  for the scene cells it holds, nothing else is removed, and a second run
  changes nothing. Only partitions where the store holds keys the archive
  lacks are read and rewritten (8-30 s). An empty store is seeded from
  the archive.
- Units fail to `data-desk-failed@` and log as `burnoff-<unit>`.

Gotchas: the export runs in the service, under its `memory_limit = 4GB`
and `temp_directory` (it was OOM-killed on the 7.5 GB box without them),
with the archive's secret made and dropped around it. A deploy restarts
the service, dropping requests in flight, only when a file changed.

## Measured

M2, 2026-10-29. A whole tile: 0.76 s on the GPU against 4.6 s on one
core. Through DuckDB at 8 rows: 70 tiles in 7.0 s (CPU 10.2 s), 518 sites
in 4.8 s. Headless Chrome over gs://, 4 workers: 112 sites in 4.3 s and
175 MB; a repeat session reads nothing. In the browser, the network sets
the time.

Sites, 2026-10-30, on the archive's 53,905 detections (Feb-Oct 2026),
date halves against the whole, for sites of 5 dates or more. An id from
a heap's top kept 77% of detections; the mean rounded to 40 m, 86-89%
(60 m: 89-92% but more sites on one id; 100 m: 94%, dozens). A heap put
two detections over 30 m apart on one date in one site 318 to 968
times; constrained single linkage never does, and at 40 m keeps 88-89%
with 2 pairs of sites on one id (30 m: 89-90%, more sites split; 60 m:
86-87%). At Ras Laffan: 74 sites, the same from 0.1° blocks offset by
0.05° and in a June-August window; from detections to June alone, 49 of
52 ids survive the rest of the year, holding 97% of their detections.
The densest box (Kerman, ~1,000 detections) takes 0.45 s.

Night detector, 2026-10-31, on the jump host (6 jobs, 2 DuckDB
threads). Against Caseiro et al.'s 2017 flaring cells (GFlaringS3, ECCAD
doi:10.25326/19: Sentinel-3A, by night, 0.025° cells with a maximum over
1500 K and more than 5 confirmed detections), from 13,044 S3A granules of
2017 (0 errors): our cells by the same rule hold, within a cell, 738 of
their 770 in the Persian Gulf (47-57 E, 23-32.5 N), 122 of 125 in the
Niger Delta (5-7.5 E, 4-6.5 N), 40 of 40 at Punta de Mata, 8 of 8 on
Yamal and 103 of 112 at 33 random sites (0.1° boxes); of ours, 824 of
833, 124 of 138, 61 of 63, 8 of 11 and 107 of 109 are theirs. Nights a
cell: Ras Laffan 134 (theirs 109), Punta de Mata 130 (49), the
Iraq-Iran border 118 (160). Mean temperatures at our sites: 1755-2220 K
(10-90%); theirs are 950-2250 K. 99.7% of hotspots are confirmed.
Against ESA's SL_2_FRP (`FRP_an`, the same 63 night passes over the
gulf, January 2025): 5,078 of our 5,323 hotspots lie within 1 km of
theirs (median 147 m); theirs are pixels, not clusters, and the 18%
we miss are dim (median FRP_SWIR 1.4 MW, against 3.8 for those found).
Reads: 6.4 MB a granule for a 0.1° flare site (3.8 MB without a hot
pixel: heads, tie points, S5's chunk with its flags and the mask), 19
MB for the whole gulf box; 3.3-4.6 granules a second. A whole granule
decodes in 0.4 s on an M2.
