Burnoff

Client-side Sentinel-2 SWIR gas-flare detection. Two data sources behind one map:

  - S2 archive (default): reads a precomputed flare-cluster Parquet from the
    s2-flares CloudFerro archive with DuckDB-WASM, range-read over HTTP. Cluster
    pins are served from memory per viewport.
  - Detect (fallback, un-archived areas): downloads Sentinel-2 L2A COG bands
    (B12/B11/B8A/SCL) from the Element84 STAC catalogue and runs the detector
    in-browser in a Web Worker. Idle peers split the work over WebRTC and merge
    results into a shared CRDT.
  - VNF mode: VIIRS Nightfire daily observations (Parquet, same archive), for
    cloud-free persistence comparison.

  Browser                                  Browser (peer)
 +-----------------------+                +-----------------------+
 |  MapLibre + UI        |     WebRTC     |  MapLibre + UI        |
 |  LWW-Map CRDT  <------- WS sync ------> LWW-Map CRDT          |
 |  detect-worker (wasm) |                |  detect-worker (wasm) |
 +----------+------------+                +----------+------------+
   |        |  HTTP range                            |
   v        v                                        v
 DuckDB-WASM   Element84 STAC / S2 L2A COGs   DuckDB-WASM
 (archive Parquet)                            (archive Parquet)


Quick start

  make serve     # static server on :8000 + signaling on :4444
  make test      # determinism + signaling tests


Detection

The detector, clusterer and quality score are the s2-flares methodology core
(github.com/data-desk-eco/s2-flares), a Rust workspace compiled to wasm and
vendored in web/s2/wasm/. The Detect worker runs that wasm (JS web/s2/detect.js
is the fallback), so the in-browser path produces the same results as the
server-side archive run. STAC search and COG I/O stay in JS (web/s2/).

Per 256x256 block: SCL cloud screen -> DN-to-reflectance with background median
for contrast -> fused brightness/contrast/thermal mask -> connected components +
shape/halo filters. Detections are merged across dates by grid-indexed,
anchor-based spatial clustering (configurable radius).

Each cluster carries a vision-validated score (display-only; the avg-B12 slider
is the active gate): a B12/B11-ratio term, a clear-sky persistence term, and a
geometric glint penalty. A strongly negative glint penalty (high-sun specular
geometry across every look, no flame spectral signature) flags possible sun
glint; derived from sun elevation, it also applies to synced detections.


P2P sync

Local detections live in a hand-rolled LWW-Map CRDT, persisted to IndexedDB and
synced over WebRTC DataChannels with a binary sync protocol. The whole stack
(crdt/sync/rtc/store) is loaded lazily -- only when the viewport sits outside the
archive's coverage, where Detect is live. A pure-archive session never fetches it.


Structure

  web/
    app.js            Orchestrator: map, mode switching, info card, lazy CRDT wiring
    render.js         Mode config + marking/ramp/key builders (data desk design)
    worldmap.js       Mollweide world-map widget
    vendor/dd/        Vendored data desk design system dist (~/Tools/design)
    clustering.js     Terminal grid + archive/VNF feature builders
    duckdb.js         Shared DuckDB-WASM bootstrap
    s2archive.js      S2 cluster-archive reader (DuckDB-WASM)
    vnf.js            VIIRS Nightfire reader (DuckDB-WASM)
    detect-worker.js  Web Worker: wasm block detector (JS fallback) + COG I/O
    s2/               s2-flares core in-tree: stac/cog/geo I/O, cluster/score JS,
                      wasm/ (Rust core via wasm-bindgen). Not a submodule.
    crdt.js sync.js rtc.js store.js   P2P stack (lazy-loaded)
    terminals.geojson LNG terminals (Global Energy Monitor)
    index.html style.css
  signal/
    worker.js         Cloudflare Durable Object signaling (production)
    server.js         WebSocket signaling relay, dev (zero deps)
  scripts/            VNF parquet build/backfill (Python) + upload (shell)
  test/               Determinism (incl. score) + P2P tests

Zero npm dependencies. MapLibre GL, geotiff.js, DuckDB-WASM and the s2-flares wasm
are vendored; everything else -- CRDT, WebRTC mesh, sync protocol, IndexedDB,
UTM math, signaling -- is browser/Node.js builtins.


References

Faruolo et al. (2024) The DAFI v2 algorithm for gas flare detection
https://doi.org/10.1088/1748-9326/ad82fb
Elvidge et al. (2013) VIIRS Nightfire: satellite pyrometry at night
https://doi.org/10.3390/rs5094423
