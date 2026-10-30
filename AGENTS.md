# burnoff

The Data Desk Sentinel-2 hotspot detector, built as a DuckDB extension
and, for the browser, as WebAssembly. `make test` checks that the
extension loads, offline.

- `src/burnoff.c`: the detector and its DuckDB and curl host.
- `src/j2k.c`: the JPEG 2000 decoder (headers, packets, tier-2, and the
  CPU's tier-1 and inverse 5/3 DWT).
- `web/j2k.wgsl`: tier-1, the DWT and B12's screen for the GPU, one module
  for both hosts: `src/gpu.c` (wgpu-native, Metal or Vulkan) and
  `web/gpu.js` (WebGPU).
- `src/burnoff.sql`: the macros run on load (`s2_scenes`, `s2_hotspots`).
  `s2_scenes` asks the catalogue for scenes at most `max_cloud` cloudy,
  keeps one item for each tile and datetime (the newest baseline, then the
  newest processing), and gives them newest first.
- `web/burnoff.c`, `web/worker.js`: the browser build and its worker.
- `serve/`: the service on the jump host (`serve/deploy.sh`), sqlite for
  its store and duckdb with this extension for the work, run by systemd.
  `GET
  https://dev.datadesk.eco/burnoff/hotspots?bbox=w,s,e,n[&datetime=a/b]`
  (`hotspots.cgi`, fcgiwrap behind caddy, `args.sql`; at most 0.44° by
  0.25°) gives geojson: each scene's look (its obscured share over the
  bbox) and hotspots (their pixels, a multipolygon); `&f=sites` gives
  them as sites (`sites.sql`): a feature a site, the detections within
  100 m of its first, with its looks (the cloud of the square under it). `query` runs
  `hotspots.sql`: the bbox's tiles (`s2_tile`), their scenes from the
  store's index of eodata (`index.sh`, daily), each scene's 6.4 km cells
  from the store where held, else one `s2_detect` of those lacking with a
  cell's margin (a hotspot is the same whichever read made it, so the
  store's are the browser's), the cells read written to a scratch sqlite
  file that sqlite3 merges into the store in one transaction, under the
  detector's digest (`v`). The store is `/data/burnoff/store.db`
  (`schema.sql`, wal; a cell's 640 m squares packed by `cells.sql`, on the
  tile's own origin). `bulk.sh` (nice 19) reads every cell of each scene
  of the tiles about the archive's sites (`seeds.sql`), 30 days at a time
  back to 2022, the newest 30 again before each; `export.sh` hourly merges
  the newest processing of each scene into the archive's
  `data-desk/burnoff/{observations,detections}`, a file a partition (an h3
  res-1 cell), once its checks pass: the archive is the record, each
  scene's cell the store holds replacing the archive's (rows carry `v`),
  so a run is idempotent and never drops a row; only the partitions
  where the store holds a cell the archive lacks (by scene, i, j, v; a
  key scan of the archive, ~8 s) are read and rewritten; an empty store is seeded
  from the archive's current-`v` rows. ~8-30 s an hour (~95 s for all 76
  partitions), at 3 GB and 2 threads, spilling to
  `/data/burnoff/tmp` (unlimited it was OOM-killed on the 7.5 GB box; at
  2 GB and 4 threads its s3 writes ran out). Units fail to `data-desk-failed@` and log as
  `burnoff-<unit>`. All of it is copernicus data on cloudferro, in the eu.

`s2_detect()` gives one scene's clear share, `hotspots` and `cells` (the
obscured share of each 640 m square) over a UTM box. Keep it a detector:
archive shapes, sites and publishing are the data-desk ETL's
(`etl/providers/data-desk/burnoff/`). A tag `v*` releases a build for
each platform; that ETL pins `burnoff-linux_amd64.duckdb_extension`.

## The pipeline

A detection is a job (`step()`) in stages: the headers and the 60 m cloud
mask; B12; the background, candidates and windows; B11 and B8A over
windows around candidates; the detections. Each stage gives a set of
byte-range reads, all known before any is made, and then a set of
decodes (`dj`, in `j->dq`). The host makes the reads at once (curl's multi
interface; `fetch()` in the browser) and calls `step()` again.

Reads. With a TLM in the main header (N0512 on; not N0511 or older), each
tile-part's PLT gives its packets' lengths, and one quality layer makes a
packet (a precinct of a resolution) complete in itself. `need()`
(`j2k_need()`) names the packets a window needs and only those are read;
`j2k.c` refuses a decode that lacks one. Reads closer than 32 KB are
joined. Without a TLM, an SOT-marker search with learned per-MGRS layouts
finds the tile-parts, read whole. Against eodata (5000 requests a minute a
key) tile-parts are read whole, joined within 1 MB, at most 20 requests a
band. A read is cut to the bytes that no read in hand of the job holds at
either end (`want()`), and `fill()` makes it whole from them; one that
reads in hand hold whole is not made. A header is read as 16 KB once for
each MGRS tile, band and baseline (the key of its cache); with a TLM, a
later date reads only its codestream header, from where the tile's header
puts it to 1 KB past its first SOT, so tile 0's PLT is in it, and the jp2
boxes ahead of it are the tile's: about 1.7 KB in place of 16 KB. A cached
header with a TLM is put in the job's reads, for tile 0's PLT.

On request (`j->cb`), b11's and b8a's packets are read by code-block,
for one round more: each needed packet's first 512 bytes (`HEAD`, its
header nearly always; else the whole packet), then only the code-blocks
the windows need (`blocks()`, `j2k_blocks()`), joined within 1 KB and to
at most 16 reads a tile a round (`CBMAX`); `put()` lays them out as the
packet for the decoder. The worker asks for it on `saveData`, a 2g/3g
`effectiveType` or `worker.js?cb=1`; natively it is never on. A measured
link is not used: under Aerial's load (4 workers of 8 jobs) a fast line's
share per worker looked slow, the path switched on, and its reads overran
Chrome (`ERR_INSUFFICIENT_RESOURCES`, then retries with backoff). A
worker now keeps at most 128 reads in flight (`FLY`) on either path. On
file:// with a TLM, a 2 km site's b11 and b8a are 112 KB in 5.5 reads
against 16 KB in 32, a 10 km box's 387 KB against 245, 0.8 to 1 round
more. In Aerial's z12 Permian view, forced on: 21k requests against 5.3k,
291 MB against ~340, no failed request, and the view full in 27 s against
10 on a fast line; off, 10.1 s against 10.2 (medians of 4). Detections
are identical either way.

Rounds. A stage's reads are a round, and a stage asks for all that the
answers it waits on do not decide. With a TLM a site is 3 rounds: the mask
and the three headers; b12's tile-parts with b11's and b8a's PLTs in its
tiles; then, once b12's candidates are known, b11's and b8a's packets.
B12's tile-parts are read whole, without a round for their PLTs, while
those lacking a PLT come to 1 MB or less (`WHOLE`: a site's, whose b12
needs 52% of their bytes); a larger box first reads the PLTs of the tiles
it covers in part, 4 rounds. Reading b11's and b8a's tile-parts whole as
well (a site in 2 rounds) cost 10-60% more bytes and no time that 10 runs
over 4 sets of jobs in Chrome could show. Without a TLM the tile-parts any
job has found in a file are kept for the next (`share()`), and a TLM's
offsets teach the learned layouts, so an older date of a tile is read
where a newer one put its tile-parts: a 10 km box of N0511 after one of
N0512 is 3 rounds and 2.4 MB where it was 5 and 5.8 MB (`s2_scenes` gives
the newest first for this). A cloudy date's b11 and b8a headers are read
only by the first job of the scene, with its mask; a later job, the mask
and b12's header in hand, ends before any read. Under the eodata
budget b11's and b8a's headers come with b12's reads and b8a's tile-parts
with b11's: 3 rounds where there were 6 to 8 (of the 588 boxes, the 154
that read b11 all read b8a).

Decodes. `j2k.c` parses the packets (tier-2) into code-block records in
`j2k.wgsl`'s 5-word layout (`batch()`: a stage's records over one byte
buffer and an 8-int32 tile table). The GPU then runs tier-1, the DWT and,
for B12, the screen (`gpu_cells`: the background cells, candidates, each
candidate's ring and the squares), and `took()` hands the results back;
`gscreen()` is `screen()` from them. Otherwise `dodec()` and `screen()` do
it on the CPU, which is also the reference. Natively a stage goes to the
GPU when it has 4096 code-blocks or more and fewer than 4 stages are
there: one GPU thread decodes a whole block, so a small stage (B11's
windows nearly always) is as quick on one core, and the CPU works
alongside. Calls from any number of threads run at once, each with its
own buffers; wgpu-native took 2 to 8 concurrent rows without a lock.

The GPU traps, each found under load from other processes on an M2:
wgpu-native began a compute pass before the one ahead had finished, so a
stage's dispatches share one pass; and Metal at times skips a pass,
unreported, so each pass ends with `mark`, a canary read back with the
results, and a stage without it is made on the CPU. A wait gives up
after 30 s. N0513's 32x32 code-blocks give 16 times fewer, longer GPU
threads than 8x8: a whole tile's B12 takes 0.63 s on the GPU against
0.38 s for 8x8, and a stage of a few hundred 32x32 blocks is slower than
one core.

## Exactness

A change must keep every detection, clear share and cell identical, field
for field, against a baseline (the harness in the session scratchpad: 588
boxes over 14 scenes N0400-N0513, full tiles to 2 km sites, tile and
image edges). `j2k.c`'s samples must equal OpenJPEG 2.5's, and the GPU's
the CPU's: check every sample of whole band-scenes, 8x8 blocks (to N0512)
and 32x32 (from N0513). `j2k.c` decodes only the codestream shape every
L1C baseline from N0400 uses (one layer, LRCP, reversible 5/3, no SOP/EPH,
a PLT in each tile-part, blocks up to 32x32, the mask's RCT) and refuses
any other. Over file:// no read gives a file's size but its header's,
and a header from the cache of another date gives that date's: boxes of
several dates in one process can then fail with `tile-part not found` (23
of the 588, at 2417981 and since), so run a date's boxes in a process of
its own. The cells' table (`table()`) turns `screen()`'s comparisons of
doubles into cuts in DN, so the GPU's screen is exact; a change to either
side goes into both. Check the GPU under load too: several processes at
once, repeated.

## The browser

`make wasm` builds `web/burnoff.{js,wasm}`; `web/burnoff.c` includes
`src/burnoff.c` without its DuckDB and curl host and adds the MGRS and
UTM work `s2_scenes`/`s2_hotspots` do in SQL. `web/worker.js` steps jobs:
reads with `fetch()`, a stage's decodes through `records()`, `gpu.js` and
`took()`, so one worker holds several detections. Without a WebGPU
adapter it decodes on the CPU and says so once. `gs://` urls go through
Google's JSON API, which sends CORS headers; `check()` retries a 206 body
shorter than its Content-Range, as a browser's cache can give. A worker
keeps the pieces of files it has read (`take()`): their last 64 MB in
memory and their last 1 GB on disk (the Cache API), the pieces from byte
0 (headers and masks) kept longest. A read is cut to the bytes that no
piece holds at either end, a piece still on its way included, and is made
whole from them: no read is added, and detections of one scene share its
headers, masks and tile-parts. Each finished detection without an error
goes into IndexedDB, keyed by its call and the SHA-256 of the wasm, so a
view opened again reads nothing. Without a secure context neither store is
used. The Aerial map (`~/Tools/aerial`, branch `burnoff-live`) runs it; it
does best to give a scene's detections to one worker, and a tile's dates
newest first.

## Hotspots, not sunlight

`nir_excess`: a peak's rise in B8A over the brightest non-candidate pixel
within 3 px must be under 0.1 of its rise in B12. Over a year of scenes
(2026-10-27) London's detections fell from 20,224 to 1,451, Madrid's sites
from 704 to 114 (most left are solar panels, which glint like a fire under
a summer sun), and Permian sites by a VIIRS flare from 327 to 315; every
detection kept is identical to one found without the test. A ring median,
B11 as the denominator and a B11/B12 gate did worse or added nothing.

## Measured

Measured 2026-10-29 on an M2 (8 cores, 10 GPU cores), file://, 13SFR.
Exactness: the 588 boxes identical field for field to the OpenJPEG-era
outputs natively (GPU as routed, every stage on the GPU, CPU only; plain
and under the eodata budget; two rounds each, four processes at once),
through DuckDB (2, 4 and 8 rows at once, three rounds; every stage on the
GPU at 2 to 8 rows, and two such processes at once), over gs:// (88
boxes) and in headless Chrome (136 jobs local, 136 over gs://, 112 sites
and 72 sweeps; WebGPU on and off).

One process, a row at a time, GPU against one core: a whole tile 0.76 s
against 4.6 s (N0512) and 1.13 s against 3.5 s (N0513); a quarter 0.24
against 0.86 s and 0.35 against 0.92 s; a 10 km site 16 against 34 ms
and 45 against 43 ms; a 2 km site 3 to 5 ms either way.

Through DuckDB at 1, 2, 4 and 8 rows at once: 70 quarter and whole tiles
in 15.0, 11.7, 9.3 and 7.0 s (CPU 51.8, 27.6, 14.9, 10.2 s; every stage on
a serialised GPU 15.3, 11.5, 9.6, 9.4 s); 518 sites in 6.6, 5.0, 5.1 and
4.8 s (CPU 7.9, 5.3, 5.3, 4.9 s; serialised GPU 10.8 to 11.0 s). At 8
rows the 588 boxes take 32 s of CPU time against 71 s.

Over gs:// natively, a box at a time with empty caches (medians of 3):
with a TLM a 2 km site took 242 ms against 396 (3 rounds against 4) and
a 10 km box 299 against 457; an N0511 box after N0512's, 2 km 381 ms
against 601 and 10 km 527 against 573 (3 rounds against 4 and 5). Under
the eodata budget the same boxes took 3 rounds against 6 to 8, 2 and 10
km in 342 to 379 ms against 586 to 1032.

In headless Chrome over gs://, 4 workers of 8 detections, medians of 7
runs taken in turn with 2417981 (the line drifts: 3 to 25 s for one set),
two scenes with a TLM and two without: 112 sites in 5.4 s against 7.3
(847 reads against 1268, 214 MB against 336) and 72 sweeps in 3.7 s
against 7.0 (421 reads against 1116, 108 MB against 290); a detection
waits on 3 rounds where it waited on 4. The scenes without a TLM were 88%
of the bytes and held the line near its ~290 Mbit/s. With a TLM alone,
56 sites took 3.8 s either way (661 reads against 979, 39 MB) and 36
sweeps 3.0 s against 3.5: a site's 1.3 s there is about 0.8 s of reads,
0.1 to 0.3 s waiting on the GPU and the rest the worker's queue, so a
round less is not seen. Exactness: 136 jobs local and 136 over gs://,
112 sites and 72 sweeps, WebGPU on and off, identical to the
OpenJPEG-era results.

Reads cut to the bytes not in hand, the shorter headers, newest first and
the worker's stores, measured 2026-10-29 against 8fdd67b, exact field for
field throughout (the 588 boxes natively, plain and under the eodata
budget, a scene a process and all in one, oldest and newest first; through
DuckDB at 2, 4 and 8 rows; 88 boxes over gs://; in headless Chrome the
four sets of jobs, WebGPU on and off, the sites and sweeps with the stores
cut to 2 MB and 20 MB, and second sessions). Natively, a scene a process:
6670 reads against 6674, 1800 MB against 1827, 625 rounds either way; all
in one process 6634 against 6650 reads, 1734 MB against 1784, 636 rounds
against 647. Newest first in one process: 629 rounds against 633 and 18
boxes failing over file:// against 25 (more boxes read, 1757 MB against
1747). Over gs://, 88 boxes: 269 MB against 280, 1707 reads against 1709.
In headless Chrome over gs://, 4 workers of 8, medians of 7 runs in turn,
cold: 112 sites 175 MB against 209 (802 reads against 848, 4.3 s against
5.2), 72 sweeps 62 MB against 107 (368 reads against 416, 2.9 s either
way), 136 jobs 207 MB against 273 (1143 reads against 1256, 4.8 s against
5.6). The 136 jobs over a local server took 1.5 s against 1.45. In a
second session the 112 sites made 4 reads (the wasm, one a worker) in 0.3
s; without the result store, 23 reads and 9 MB, and after the 72 sweeps,
143 to 160 MB.
