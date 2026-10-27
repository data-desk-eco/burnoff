# burnoff

The Data Desk Sentinel-2 hotspot detector: one C file, `src/burnoff.c`, over
libcurl and libopenjp2, built as a DuckDB extension, and `src/burnoff.sql`,
the macros run on load. `make test` checks that it loads, offline.

- `s2_detect()` detects in one scene over a UTM box and gives the box's
  clear share, its `hotspots` and `cells`, the obscured share of each 640 m
  square: what a clear look at a site is judged by.
- `s2_get()` is a GET for the catalogue; `s2_scenes`/`s2_hotspots` search
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

Keep it a detector. Archive shapes, sites and publishing are the data-desk
ETL's (`etl/providers/data-desk/burnoff/`), in SQL over `s2_detect`'s rows.
A tag `v*` releases a build for each platform; that ETL pins
`burnoff-linux_amd64.duckdb_extension`.

web/ builds the same detector for the browser (`make wasm`, emscripten):
`web/burnoff.c` includes `src/burnoff.c` over a libcurl shim of
synchronous XHRs, so it runs in a web worker, and adds in C what
`s2_scenes` and `s2_hotspots` do in SQL (MGRS tiles, UTM, the zone a hotspot
is reported in). `gs://` urls go through Google's JSON API, which sends
CORS headers. A read is posted to the page before it is made (`ahead`),
and the page fetches it, so blocking reads come from the HTTP cache. That
cache can hand a read a 206 whose body is short of its Content-Range while
another read of the file is in flight (seen in Aerial at ~1 in 400 reads
once B8A was read more); `get()` retries such a body as it does a 5xx. The
Aerial map (`~/Tools/aerial`, branch `burnoff-live`,
`web/flaring/live.js`) runs it.

Measured 2026-10-26 (M2, 16 workers, Permian at z11): first hotspots 2.9 s
after load, 44 sites and ~1900 dated looks in 40 s. A site read is ~0.4 s
and bound by round trips, not bytes or decode. Packet surgery (fetching
only the precincts a window needs, others replaced by empty packets) is
bit-exact and cuts a 320 px cell to ~45% of a tile-part, but needs 5-7
requests against 1, so it is not used. Nor is a screen decode (B12 first
without its lowest bitplanes, under a certified error bound, then exact
decodes only where a peak is possible): it was exact, and 6-9x faster on
cloudy files, but on clear land (Permian, Catalonia) bright ground and
real hotspots send most cells to the exact decode, so the total did not
fall. Single-threaded, the wasm decode is within 3-6% of native. Of the
emscripten flags tried (-O2, LTO, mimalloc, emmalloc, SSE2 and SSE4.1
emulation, fast-math), only SSE2 for OpenJPEG helped (0-5%, through its
vertical 5/3 DWT), and it is kept.
