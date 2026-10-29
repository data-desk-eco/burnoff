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
- `web/burnoff.c`, `web/worker.js`: the browser build and its worker.

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
band.

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
any other. The cells' table (`table()`) turns `screen()`'s comparisons of
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
shorter than its Content-Range, as a browser's cache can give. The Aerial
map (`~/Tools/aerial`, branch `burnoff-live`) runs it.

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

In Chrome over gs://, 4 workers of 8 detections: 112 sites in 10.7 to
11.2 s and 72 sweeps in 6.6 to 7.1 s, as in eae703c (10.7 and 6.8 s):
the network sets the time. The CPU decode takes as long there (10.5 to
12.1 s, 6.0 to 7.2 s); over a local server the 136 jobs take 1.8 s on
WebGPU and 5.9 s without.
