# Handover: bandwidth savings

Ideas for reading fewer bytes off the JPEG2000 archive. Each one must keep
detections exact. The figures are estimates unless they say "measured".

- **Bounds before exact reads.** A pixel can only be a candidate if its B12
  is over the cell's contrast cut, and that cut is never below 0.45
  (background floor 0.15 × contrast ratio 3). Most ground only has to be
  proven under 0.45, not read exactly.
- **Coarse-to-fine resolution reads.** In LRCP order the lowest resolution
  levels are a prefix of each tile-part: about 7% of its bytes for levels
  0–2 and about 30% for levels 0–3. Bound every pixel from these and read
  the full-resolution packets only where the bound reaches 0.45.
- **Code-block maxima from packet headers.** Each full-resolution packet's
  header gives the number of bit-planes of each 8×8 code-block, which
  bounds its coefficients without decoding them. The headers are a few
  bytes at the start of each packet; the PLT gives their offsets.
- **Bit-plane prefixes.** A code-block's bytes run from its most significant
  pass to its least, so the first passes give tight bounds for few bytes.
  This needs millions of small ranges, so it is practical only natively, or
  against a store with cheap small reads.
- **The same test for B11 and B8A.** Rule out candidates (B11 under
  `b11_min`) from low-resolution bounds before reading their windows at
  full resolution.
- **Expected gain.** About 5–10x less B12 data on dark ground and about
  2–3x on bright desert, where the bare ground is 0.3–0.4. The cost is 2–4
  more read rounds per detection and about 2–3x the requests.
- **Keep cache-friendly reads.** Measured: in Aerial, whole tile-parts used
  less data than packet-level reads (0.78–0.89 GB against 1.03–1.09 GB for
  one view's year), because sweeps and site reads share them through the
  worker's answer cache. Precinct-level refinement should keep that sharing.
- **Only on slow links.** Use the bandwidth path when `navigator.connection`
  reports a slow link or data-saving. Fast links keep today's path.
- **Shrink the margins.** Each sweep decodes whole 6.4 km background cells
  plus a margin of `max_pixels + 1` pixels, about 1.6 km. Measured: one
  sweep part per scene in place of up to four cut a view's year from 981
  to 886 MB.
- **Never read twice.** A fact store shared across users, filled by a
  server that detects whole tiles in-region on CloudFerro, gives every
  user after the first a few KB of facts instead of the bytes.
- **Fix the header cache.** The cache keys a scene's header by tile, band
  and baseline, so a read can take another date's file size. In one
  process over many dates this fails some reads ("tile-part not found"),
  and the retries cost requests.
- **Measure in the worker.** The browser hides the sizes of cross-origin
  reads, so count bytes in `worker.js`, or through CDP's
  `Network.loadingFinished` on the auto-attached worker targets.

## More ideas (from a code read, not yet measured)

These keep detections exact. The line numbers were correct at 4d3e30c.

- **Keep results across sessions.** Store each finished detection in
  IndexedDB, keyed by URL, box, part, thresholds and wasm build
  (`web/worker.js`, before `detect`). A view that is opened again then
  reads no bytes.
- **Keep the answer cache across sessions.** Put headers, masks and
  tile-parts in OPFS or the Cache API, with headers and masks kept first.
- **Read only the bytes not already held.** `fly` and `kept` in the worker,
  and `got()` in C, reuse an answer only when it contains the whole read.
  Cut each read to the bytes that no kept or in-flight answer covers. Wait
  on a larger read in flight that contains it. This adds no requests.
- **Order the dates of a tile, newest first.** Then a TLM date always
  teaches the learned layouts to the older dates (5.8 to 2.4 MB, 5 to 3
  rounds). Today this happens only when that date happens to come first.
- **Remove duplicate scenes.** Keep one STAC item for each tile and
  datetime, the newest baseline (`src/burnoff.sql`).
- **Stop early on cloudy dates.** When the mask is cached and no cell
  passes `MAXCLOUD`, do not request the b11 and b8a headers.
- **Reuse the 16 KB header read.** That read can already contain tile 0's
  PLT, which `parts()` requests again. The GML box and COD are the same
  for each date of a tile, so read only from the codestream to the first
  SOT.
- **Read only the mask tiles that the box touches.** The mask is read
  whole (`mask()`, `0,-1`). Only the tiles that meet the box are decoded.
- **Request the PLTs with the headers.** With a TLM, the place of each PLT
  is known when the main header arrives. If tile 0's PLT is in the header
  read, b12 can read only its needed packets (52% of a site's bytes) with
  no extra round.
- **Resume short reads.** Request only the bytes from `lo+n`, not the full
  range again (`check()`).
- **Read code-blocks, not precincts, for b11 and b8a (slow links only).**
  A 7×7 window needs only one or two code-blocks of each precinct. This
  needs one more round to read the packet headers.
- **Filter cloud cover in the STAC query.** This saves only catalogue
  bytes and pages.
