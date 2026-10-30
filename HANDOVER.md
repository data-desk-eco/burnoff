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

## Checked and not done (2026-10-29)

- **Read only the mask tiles that the box touches.** The mask is 64 tiles
  of 256 px with no TLM, 7.7 to 155 KB on 13SFR. The tiles that a box
  meets can only be found by a search for their SOT markers (one more
  round), and the whole mask is read once for each scene and shared by all
  of its boxes.
- **Resume short reads.** Neither host gives a short 206 body now: `fetch()`
  with `cache: 'no-store'` rejects a cut body, and curl reports a cut
  connection as an error. Only a failed read would save bytes.
- **Stop early on cloudy dates.** This is already so: with the mask and
  b12's header in hand, `heads()` ends before any read is made. Over a
  cloudy scene's 42 boxes, only the first job read the b11 and b8a headers.
