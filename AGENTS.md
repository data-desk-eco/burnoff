# burnoff

The Data Desk Sentinel-2 hotspot detector: a DuckDB extension, a
WebAssembly build for the browser, and a service on the jump host.
`README.md` documents the API and the extension; this file is for work on
the code. `make test` checks that the extension loads, offline.

## Layout

- `src/burnoff.c`: the detector and its DuckDB and curl host.
- `src/j2k.c`: the JPEG 2000 decoder (headers, packets, tier-2, the
  CPU's tier-1 and inverse 5/3 DWT).
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

## The browser

`web/worker.js` holds several jobs per worker, falls back to the CPU
without WebGPU, reads `gs://` through Google's JSON API, and keeps file
pieces (64 MB in memory, 1 GB in the Cache API) and finished results
(IndexedDB, keyed by call and wasm hash). The Aerial map
(`~/Tools/aerial`, branch `burnoff-live`) uses it only when the service
fails.

## The service

On the jump host (CloudFerro WAW3-2, beside eodata), deployed by
`serve/deploy.sh`, run by systemd behind caddy and fcgiwrap.

- `hotspots.cgi` → `query` → `hotspots.sql` (+ `sites.sql` for
  `f=sites`). Cells come from the store, else one `s2_detect` of those
  missing; new cells are merged into the store in one transaction, keyed
  by the detector's digest `v`. Requests run in parallel, one a core.
  Answers carry `Cache-Control`: a day for a window ended before today,
  else an hour.
- The store is `/data/burnoff/store.db` (`schema.sql`, SQLite, WAL). It
  is a cache: everything in it can be read again from eodata.
- `index.sh` (daily) indexes eodata's scenes. `bulk.sh` (nice 19) fills
  the store around the archive's sites and pauses during requests.
- `export.sh` (hourly) merges the store into the archive's
  `data-desk/burnoff/{observations,detections}`, one file per H3 res-1
  cell. The archive is the record: the store's rows replace the archive's
  for the scene cells it holds, nothing else is removed, and a second run
  changes nothing. Only partitions where the store holds keys the archive
  lacks are read and rewritten (8-30 s). An empty store is seeded from
  the archive.
- Units fail to `data-desk-failed@` and log as `burnoff-<unit>`.

Gotchas: the export needs `memory_limit = 3GB`, 2 threads and a writable
`temp_directory` (it was OOM-killed on the 7.5 GB box otherwise). DuckDB's
sqlite scanner fails on `count(*)` of a `WITHOUT ROWID` table; count a
column. A deploy restarts the service only for a new detector.

## Measured

M2, 2026-10-29. A whole tile: 0.76 s on the GPU against 4.6 s on one
core. Through DuckDB at 8 rows: 70 tiles in 7.0 s (CPU 10.2 s), 518 sites
in 4.8 s. Headless Chrome over gs://, 4 workers: 112 sites in 4.3 s and
175 MB; a repeat session reads nothing. In the browser, the network sets
the time.
