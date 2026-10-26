# burnoff

The Data Desk Sentinel-2 flare detector: one C file, `src/burnoff.c`, over
libcurl and libopenjp2, built as a DuckDB extension, and `src/burnoff.sql`,
the macros run on load. `make test` checks that it loads, offline.

- `s2_detect()` detects in one scene over a UTM box and gives the box's
  clear share, its flares and `cells`, the obscured share of each 640 m
  square: what a clear look at a site is judged by.
- `s2_get()` is a GET for the catalogue; `s2_scenes`/`s2_flares` search
  CDSE's STAC for a geometry and detect at query time.

It reads JP2 tile-parts directly, uses the L1C `MSK_CLASSI` mask, and runs
the compact-source thresholds over a box in one pass with 320 px
background cells. From baseline N0511 the main header's TLM gives each
tile-part's offset, so that header is read for each file and tile-parts
are read exactly; older files use the SOT-marker search with learned
per-MGRS layouts.

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
XHRs, so it runs in a web worker, and adds in C what `s2_scenes` and
`s2_flares` do in SQL (MGRS tiles, UTM, the zone a flare is reported in).
`gs://` urls go through Google's JSON API, which sends CORS headers. A
read is posted to the page before it is made (`ahead`), and the page
fetches it, so blocking reads come from the HTTP cache. The Aerial map
(`~/Tools/aerial`, branch `burnoff-live`, `web/flaring/live.js`) runs it.

Measured 2026-10-26 (M2, 16 workers, Permian at z11): first flares 2.9 s
after load, 44 sites and ~1900 dated looks in 40 s. A site read is ~0.4 s
and bound by round trips, not bytes or decode. Packet surgery (fetching
only the precincts a window needs, others replaced by empty packets) is
bit-exact and cuts a 320 px cell to ~45% of a tile-part, but needs 5-7
requests against 1, so it is not used. Nor is a screen decode (B12 first
without its lowest bitplanes, under a certified error bound, then exact
decodes only where a peak is possible): it was exact, and 6-9x faster on
cloudy files, but on clear land (Permian, Catalonia) bright ground and
real flares send most cells to the exact decode, so the total did not
fall. Emscripten flag variants (-O2, LTO, mimalloc, emmalloc, SSE4.1
emulation, fast-math) moved a full-tile decode by under 5%.
