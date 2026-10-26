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

Keep it a detector. Archive shapes, sites and publishing are the data-desk
ETL's (`etl/providers/data-desk/burnoff/`), in SQL over `s2_detect`'s rows.
A tag `v*` releases a build for each platform; that ETL pins
`burnoff-linux_amd64.duckdb_extension`.

web/ builds the same detector for the browser (`make wasm`, emscripten):
`web/burnoff.c` includes `src/burnoff.c` over a libcurl shim of synchronous
XHRs, so it runs in a web worker. The archive buckets send no CORS headers,
so `web/serve.py` proxies them. On one full tile (T13SFR, 2025-05-19) it
matched native exactly, 87 flares, in about 10 s against 6 s.
