# burnoff

The Data Desk Sentinel-2 flare detector: one C file, `src/burnoff.c`, over
libcurl and libopenjp2, built as a DuckDB extension, and `src/burnoff.sql`,
the macros run on load. `make test` checks that it loads, offline.

- `s2_detect()` detects in one scene over a UTM box and gives the box's
  clear share, its flares and `cells`, the obscured share of each 640 m
  square: what a clear look at a site is judged by.
- `s2_get()` is a GET for the catalogue; `s2_scenes`/`s2_flares` search
  CDSE's STAC for a geometry and detect at query time.

It reads JP2 tile-parts directly (SOT-marker search with learned per-MGRS
layouts and headers, windowed OpenJPEG decode), uses the L1C `MSK_CLASSI`
mask, and runs the compact-source thresholds over a box in one pass with
320 px background cells.

Two costs set its speed: JPEG2000 decoding for large boxes, and eodata's
5000 requests a minute per key for many small ones. An optimisation decodes
fewer pixels or makes fewer requests; check one against a baseline's
detections, which must match exactly. The measurements are in the history
of `README.md`.

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
