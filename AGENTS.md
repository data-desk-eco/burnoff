# burnoff

The Data Desk Sentinel-2 hotspot detector: one C file, `src/burnoff.c`, over
libcurl and libopenjp2, built as a DuckDB extension, and `src/burnoff.sql`,
the macros run on load. `make test` checks that it loads, offline.

- `s2_detect()` detects in one scene over a UTM box and gives the box's
  clear share, its `hotspots` and `cells`, the obscured share of each 640 m
  square: what a clear look at a site is judged by.
- `s2_get()` is a GET for the catalogue; `s2_scenes`/`s2_hotspots` search
  CDSE's STAC for a geometry and detect at query time.

It reads the JP2 files directly, uses the L1C `MSK_CLASSI` mask, and runs
the compact-source thresholds over a box in one pass with 320 px
background cells.

A detection is a job (`step()` in `src/burnoff.c`) in stages: the headers
and the mask; B12; the background, candidates and windows; B11 and B8A;
the detections. Each stage gives a set of byte-range reads, all known
before any is made, and then a set of decodes. The host makes the reads
at the same time and calls `step()` again: curl's multi interface in the
extension (one multi handle for each worker thread), `fetch()` in the
browser. A decode is a `dj` (band, tile, window, packets), and a stage
gives all of a band's decodes at once, so another decoder (a GPU) can take
them in one batch. `dodec()` is the one place that calls OpenJPEG.
`screen()` is the pass over the B12 raster (background, threshold,
candidates); after it, only `ring()` (3 px around each candidate) and the
640 m squares (no data) read that raster.

When a file's main header has a TLM (the offset of each tile-part; in
13SFR, the N0512 and N0513 files, but no N0511 or older ones), each
tile-part header's PLT gives the length of each packet. The files have one
quality layer, so each packet (one precinct of one resolution) is complete
in itself. `need()` names the packets that a decode window needs, by
OpenJPEG's own rule for the packets it skips (a precinct within 2
coefficients of the window in a subband, in `tcd.c`).
Only those packets are read, and the others are decoded as empty packets
(one 0x00 byte), so the decode is identical to a decode of the whole
tile-part. A tile-part that a window needs whole is read whole, without its
PLT. Reads closer than 32 KB are joined. Files without a TLM use the
SOT-marker search with learned per-MGRS layouts, in rounds of parallel
reads, and are read as whole tile-parts. Against eodata (`s3://`), which
allows 5000 requests a minute per key, tile-parts are always read whole,
joined within 1 MB, and at most 20 requests are made for each band (the
closest runs are joined). Without a TLM, the whole codestream is read once
more than a quarter of the tile-parts are needed.

Two costs set its speed: JPEG2000 decoding for large boxes, and eodata's
5000 requests a minute per key for many small ones. An optimisation decodes
fewer pixels or makes fewer requests; check one against a baseline's
detections, which must match exactly. The measurements are in the history
of `README.md`.

A peak must be heat, not reflected sunlight (`nir_excess`): its rise in
B8A over the brightest non-candidate pixel within 3 px must be under 0.1
of its rise in B12 over the same ring. A fire barely lifts B8A, while sun
off a roof, glass, a car or a domed tank lifts all three bands. B8A is now
read at every candidate of a component that can hold a detection, the
saturated ones as well. Measured 2026-10-27 on a year of scenes, against
the detector without the test: over London (441 scenes) detections fell
from 20,224 to 1,451, and sites lit on two dates with a mean B12 of 0.85
from 2,059 to 83, most of the persistent ones at landfill, waste and
sewage sites. On 13SFR in the Permian (93 scenes), sites within ~350 m of
a VIIRS Nightfire site fell from 327 to 315, and around the Houston ship
channel from 54 to 45 (most of those lost were domed tank roofs), and the
others there from 737 to 142. Every detection that passes is identical to
one found without the test, and a read takes as long. A ring median for
the background, B11 in place of B12 as the denominator, and a B11/B12
excess gate on top did worse or added nothing. Over Madrid (214 scenes)
the sites fell from 704 to 114. Most of those left are on industrial
roofs, and their bands fit solar panels: silicon absorbs B8A and passes
SWIR, which reflects off the panel's back, so a panel glints like a fire,
but only under a summer sun (Aerial's live layer hides a site lit only in
summer). Bright roofs with a highlight brighter in B12 than B11 (the
Astrodome) are also left.

`web/j2k.wgsl` is the jpeg2000 tier-1 and inverse 5/3 dwt for the gpu, one
module for any host; `web/gpu.js` runs it in webgpu from the cpu's tier-2
code-block records (their layout and the bindings are in `j2k.wgsl`'s head).
It must stay bit-exact with openjpeg: check every coefficient and sample of
whole band-scenes, 8x8 blocks (to N0512) and 32x32 (from N0513), against
openjpeg's own. `src/gpu.c` runs the same `j2k.wgsl` natively, over
wgpu-native (`GPU=1`, the default, fetches it into `ext/`): `gpu_decode()`
and `gpu_cells()`, which give an error, for the cpu path to take over, when
there is no adapter. It builds the cells' cut tables as `gpu.js` does; a
change to either kernel host's tables or bindings goes into both.

Keep it a detector. Archive shapes, sites and publishing are the data-desk
ETL's (`etl/providers/data-desk/burnoff/`), in SQL over `s2_detect`'s rows.
A tag `v*` releases a build for each platform; that ETL pins
`burnoff-linux_amd64.duckdb_extension`.

web/ builds the same detector for the browser (`make wasm`, emscripten):
`web/burnoff.c` includes `src/burnoff.c` without its DuckDB and curl host,
and adds in C what `s2_scenes` and `s2_hotspots` do in SQL (MGRS tiles,
UTM, the zone a hotspot is reported in). `web/worker.js` steps the job:
it gets a stage's reads from `reads()`, makes them with `fetch()`, gives
each answer to `answer()`, and calls `next()` again. Nothing blocks, so a
worker holds several detections at once. `gs://` urls go through Google's
JSON API, which sends CORS headers. A browser's HTTP cache can give a 206
whose body is shorter than its Content-Range (seen in Aerial at ~1 in 400
reads); `check()` retries such a body as it does a 5xx. The Aerial map
(`~/Tools/aerial`, branch `burnoff-live`, `web/flaring/live.js`) runs it.

Measured 2026-10-26 (M2, 16 workers, Permian at z11): first hotspots 2.9 s
after load, 44 sites and ~1900 dated looks in 40 s. A site read is ~0.4 s
and bound by round trips, not bytes or decode. A screen decode is not used
(B12 first without its lowest bitplanes, under a certified error bound,
then exact decodes only where a peak is possible): it was exact, and 6-9x
faster on cloudy files, but on clear land (Permian, Catalonia) bright
ground and real hotspots send most cells to the exact decode, so the total
did not fall. Single-threaded, the wasm decode is within 3-6% of native.
Of the emscripten flags tried (-O2, LTO, mimalloc, emmalloc, SSE2 and
SSE4.1 emulation, fast-math), only SSE2 for OpenJPEG helped (0-5%, through
its vertical 5/3 DWT), and it is kept.

Measured 2026-10-29 on 13SFR, the staged reads against the blocking ones
(web-map, 4f439d1). Detections, clear shares and cells are identical,
field for field, on 588 boxes (full tiles, quarters, 10 km and 2 km sites,
JP2 tile and image edges, off the image) over 14 scenes from N0400 to
N0513 (cloudy and clear, with and without a TLM), over file://, under the
eodata budget, through DuckDB, over gs:// (88 boxes) and in headless
Chrome (136 jobs local, 320 over gs://). Packet reads decode identically,
pixel for pixel, to whole tile-parts on 13,500 random windows of nine
N0512 and N0513 band files. Over gs:// on an M2, native, per row with a
TLM: a 10 km site reads B12 0.73 to 0.34 MB, B11 and B8A 0.37 to 0.09 MB
each, in 0.24 to 0.14 s; a 2 km site B12 0.35 to 0.06 MB in 0.14 to
0.10 s; a quarter tile B12 17.0 to 4.7 MB and B11 3.3 to 0.9 MB in 1.4 to
0.9 s; a whole tile B11 17.0 to 3.6 MB in 3.8 to 2.9 s. A 10 km site makes
~10 requests in 4-5 rounds against ~2-3 requests. B8A over B11's windows
reads the same bytes as over its own, so it comes with B11 and saves a
round. Without a TLM, a whole tile takes 5.4 to 2.0 s, as more than a
quarter of a band no longer reads the whole file. In Chrome against
gs://, 112 site reads on four clear scenes took 19.6 s with 16 workers
(the old way, Aerial's) and 10.7 s with 4 workers holding 8 each; 72
sweep reads 16.0 s and 6.8 s.
