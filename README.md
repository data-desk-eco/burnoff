Burnoff

In-browser Sentinel-2 gas-flare detection, on a map.

  make serve     # static server on :8000 + signaling on :4444
  make test

Three views of one map:

  - S2 (default): precomputed flare clusters from the s2-flares CloudFerro
    archive, range-read over HTTP with DuckDB-WASM.
  - Detect (outside archive coverage): downloads Sentinel-2 L2A COGs from the
    Element84 STAC catalogue and runs the detector in a Web Worker; connected
    peers split the work over WebRTC and merge results in a CRDT.
  - VNF: VIIRS Nightfire observations, for cloud-free persistence comparison.

The detector, clusterer and quality score are the s2-flares methodology core
(github.com/data-desk-eco/s2-flares), Rust compiled to wasm and vendored in
web/s2/ — the in-browser path produces the same results as the archive run.
The UI is the data desk design system, vendored in web/vendor/dd/; the generic
map shell (web/map.js, web/quarters.js) is kept separate from the burnoff
modules (app.js, detect.js, card.js) so future full-screen remote-sensing maps
can reuse it directly.

Zero npm dependencies: MapLibre GL, geotiff.js, DuckDB-WASM and the wasm core
are vendored; the rest (CRDT, WebRTC mesh, IndexedDB, UTM math, signaling) is
browser/Node.js builtins. Production signaling is a Cloudflare Durable Object
(signal/worker.js).

References

Faruolo et al. (2024) The DAFI v2 algorithm for gas flare detection
https://doi.org/10.1088/1748-9326/ad82fb
Elvidge et al. (2013) VIIRS Nightfire: satellite pyrometry at night
https://doi.org/10.3390/rs5094423
