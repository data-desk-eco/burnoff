# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync, plus a
VIIRS Nightfire (VNF) mode for browsing EOG's satellite flare catalog.

Zero npm dependencies. The only external libraries are MapLibre GL (map
rendering), geotiff.js (COG reads), DuckDB-WASM (Parquet queries), and the
s2-flares rust core compiled to wasm (the flare detector) — all vendored under
`web/vendor/` and `web/s2/`. Everything else — CRDT, WebRTC mesh, sync protocol,
IndexedDB persistence, UTM projection math, and the signal server's WebSocket
framing — is hand-rolled using web standards.

## Architecture

```
  Browser (app.js)                         Browser (peer)
 ┌──────────────────────┐                 ┌──────────────────────┐
 │  MapLibre GL         │                 │  MapLibre GL         │
 │  ┌────────────────┐  │   WebRTC /      │  ┌────────────────┐  │
 │  │ LWW-Map CRDT   │◄─┼── WebSocket ──►─┼─►│ LWW-Map CRDT   │  │
 │  │  detections Map │  │   (DataChannel) │  │  detections Map │  │
 │  │  processed  Map │  │                 │  │  processed  Map │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 │          │           │                 │          │           │
 │  IndexedDB           │                 │  IndexedDB           │
 │          │           │                 │          │           │
 │  ┌───────▼────────┐  │                 │  ┌───────▼────────┐  │
 │  │ detect         │  │                 │  │ detect         │  │
 │  │  (Web Worker)  │  │                 │  │  (Web Worker)  │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 └──────────┼───────────┘                 └──────────┼───────────┘
            │ HTTP range requests                    │
            ▼                                        ▼
     Element84 STAC API          DuckDB-WASM
     Sentinel-2 L2A COGs         VNF Parquet (CloudFerro archive)
     (B12, B11, B8A, SCL)
```

**S2 mode:** The default data source reads the precomputed *cluster view*
straight from the CloudFerro public parquet archive (s2-flares `box.sh publish`).
The archive co-produces a derived cluster view partitioned by MGRS tile,
`clusters/mgrs=<tile>/data.parquet` — one row per cluster (scalar score columns +
a nested `detections` list). `web/s2archive.js` enumerates those per-tile objects
from the bucket listing, then range-reads with DuckDB-WASM **only the tiles the
viewport overlaps** — each tile's parquet is loaded once, lazily, and cached;
viewports are served from those cached tiles (bbox + date-overlap filter), so a
far-out or uncovered viewport fetches nothing. `archiveFeature` maps a row straight
to the Feature shape `crossDateCluster` emits, so the avg-B12 slider gates
client-side but the server-side clustering is not re-run. The in-browser COG detection worker (`detect-worker.js`, the "Detect"
button) is the fallback for areas not yet archived: it runs the s2-flares rust core
compiled to wasm (`web/s2/wasm/`), the SAME binary methodology as the server-side
archive — there is no JS detector port (it drifted from the core and was removed; the
app already hard-depends on wasm via DuckDB-WASM, so wasm-or-nothing loses no reach).
Peers share a single CRDT document, idle peers read
the job from awareness state, partition blocks by hash, and process their share,
merging results via LWW-Map CRDT. The CRDT/mesh stack is **loaded lazily**
(`ensureDetect()` dynamically imports crdt/sync/rtc/store) only when the viewport
sits outside the archive's coverage — a pure-archive session never fetches it. The
archive base is set via `<meta name="s2-archive">` in index.html.

**VNF mode:** DuckDB-WASM queries a pre-built Parquet file containing per-flare
daily observations from EOG profile CSVs. In production it lives in the shared
s2-flares CloudFerro archive at `vnf/data.parquet` (`<meta name="vnf-url">`); dev
falls back to a local `web/vnf.parquet`. Each row has `clear`/`detected` booleans
for real cloud-free persistence metrics.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make test         # Run determinism tests
make vnf          # Build VNF parquet from EOG profile CSVs
make vnf-upload   # Upload VNF parquet to the s2-flares archive (vnf/data.parquet)
make deploy       # Deploy signaling worker to Cloudflare
git push          # Deploy static site via GitHub Pages (auto on push to main)
```

No `npm install` required. Dev server uses `python3 -m http.server`.
Local signaling uses `node:http` and `node:crypto` (Node.js builtins).
Production signaling is a Cloudflare Worker + Durable Object (`npx wrangler deploy`).
Tests use `node:test` and `node:assert`.

## Key Files

```
web/
  app.js              Main thread orchestrator: map setup, mode switching, UI,
                      info card, lazy CRDT wiring (ensureDetect)
  map-style.js        MapLibre base style + magma colour ramp
  render.js           Mode config + colour/radius/legend expression builders
  clustering.js       Terminal grid + archive/VNF feature builders
  duckdb.js           Shared DuckDB-WASM bootstrap (openDuckDB) for vnf + archive
  vnf.js              VNF data module: DuckDB-WASM Parquet queries
  s2archive.js        S2 archive reader: DuckDB-WASM over the cluster parquet
  detect-worker.js    Module Web Worker: wasm block detector + COG I/O
  s2/                 The s2-flares methodology core, adopted in-tree (no submodule):
                      stac/cog/geo I/O + cluster/score JS + the rust core compiled to
                      wasm in s2/wasm/. detect-worker runs the wasm — the same binary
                      methodology as the archive; cog.js holds the block tiling glue.
  crdt.js             LWW-Map CRDT with binary codec   (lazy: loaded outside coverage)
  sync.js             Sync protocol, awareness, validation              (lazy)
  rtc.js              WebRTC DataChannel mesh (raw RTCPeerConnection)   (lazy)
  store.js            IndexedDB persistence with batched flushes        (lazy)
  terminals.geojson   LNG terminal locations (Global Energy Monitor)
  index.html          Entry point
  style.css           UI styles
scripts/
  build_vnf.py        Build VNF parquet from EOG profile CSVs + flare index
signal/
  server.js           WebSocket signaling relay for local dev (RFC 6455 over node:http)
  worker.js           Cloudflare Worker + Durable Object signaling relay (production)
wrangler.toml         Cloudflare Worker config (Durable Object binding + migration)
test/
  determinism.test.mjs       Detection + clustering determinism tests (node:test)
  signaling-node.test.mjs    Signaling relay tests (node, requires ws package)
  signaling.test.html        Signaling relay tests (browser)
  p2p-test.html              CRDT codec + sync integration tests (browser)
```

## External Dependencies

| Library | Purpose | Loaded from |
|---------|---------|-------------|
| MapLibre GL 5.1 | WebGL map rendering | Vendored (`web/vendor/`) |
| geotiff.js 2.1 | Cloud Optimized GeoTIFF reads | Vendored in `web/s2/vendor/` (ESM, one copy) |
| s2-flares wasm 2.0 | Block flare detector (rust core) | Vendored in `web/s2/wasm/` |
| DuckDB-WASM 1.29 | VNF + S2-archive Parquet queries | Vendored (`web/vendor/duckdb/`) |

Everything else uses browser/Node.js builtins:
WebRTC, IndexedDB, Web Workers, Fetch, Canvas, WebSocket,
TextEncoder/Decoder, Blob, crypto (Node), http (Node).

## S2 Detection Algorithm

Sentinel-2 L2A at 20m resolution via Element84 STAC COGs.
Runs entirely client-side in a Web Worker with windowed reads (geotiff.js).

Processing uses fixed 256x256 pixel blocks within each tile.
Each block is identified by `{mgrs}_{row}_{col}` and cached by `block_id:date`.

```
Per-block pipeline (fused into minimal passes):

  1. STAC search for L2A images in viewport (no scene-level cloud filter)
  2. Read SCL band first for cloud check
  3. Cloud check via SCL: skip blocks >75% cloud; mark blocks >30% as not cloud-free
     (for persistence metric — blocks between 30-75% are still processed)
  4. Read B12, B11, B8A bands (windowed, 10px overlap)
  5. Pre-pass: B12 DN -> reflectance, collect background for median
  6. Fused pass: B11/B8A DN -> reflectance + brightness + contrast + thermal -> mask
     - Brightness:  B12 > 0.3 AND B11 > 0.2
     - Contrast:    B12 > median(background) * 3.0, floor 0.15
     - Thermal:     NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 OR saturation
  7. Connected components (BFS, 4-connectivity)
  8. Cluster filters: size, peak, peakedness, single-pixel, warm-region halo
  9. Overlap dedup: canonical block via floor(pixel / 256)

Each detection also carries glint/spectral annotations (s2-flares core; the
glint geometry helpers are re-exported from `web/s2/score.js`):
  - sun_elevation/sun_azimuth (STAC view extension, via stac.js)
  - glint_angle = 90 - sun_elevation; glint_score (1.0 ≤25°, →0 at 65°)
  - peak_b11, b12_b11_ratio (flames are hot, ratio >~1.3; glint is flat ~1.0)

Cross-date clustering (main thread, grid-indexed):
  - Anchor-based merge, configurable radius (0-200m, default 135m)
  - Minimum 4 distinct dates per cluster
  - Minimum average B12 per cluster: 0.85 (adjustable via UI slider) — the
    active quality gate
  - Glint false-positive flag: clusters whose minimum per-look glint_score is
    high (high-sun geometry across every look, no flame spectral evidence) are
    warned. Derived from sun_elevation, so it works on synced detections too.
    Replaces the old Apr–Aug seasonal heuristic.
  - Persistence metric: detections / observations per cluster
  - Cloud-free %: fraction of observations with ≤30% cloud (data quality indicator)

Cluster quality score (vision-validated methodology, lib/score.js) — computed
and shown in the detail card, NOT yet a gate. The formula was tuned in
~/Research/permian-flaring against an unbiased 2,826-site aerial study (sql/30):
  - total_score = 0.50·ratio_score
                + 0.40·persistence_score·(0.1 + 0.9·ratio_score)
                − 0.40·min_glint_score        (range −0.40 … +0.90)
  - ratio_score (0–1): smooth ramp on the B12/B11 ratio over 1.1→1.7 — the
    strongest precision signal. Peak-B12 brightness is FLAT as a ranking term and
    is dropped from the score (it is the recall floor, i.e. the avg-B12 gate).
  - persistence_score (0–1): the clear-sky share lit, n_dates / cloud-free obs.
    Its weight ramps with the ratio (the 0.1 floor keeps dim-but-real pads
    ordered); a flat additive persistence rewarded static reflectors.
  - glint_penalty (−0.40–0): linear in the cluster's MINIMUM per-look glint_score
    — a real flare fires across many sun geometries so its min drops low;
    geometric glint stays high. (permian's three hard gates — far-from-facility,
    on-building, on-road — need ground layers unavailable client-side, so they do
    not port; and the retired openflaring score's S3 corroboration term is not
    carried — no Sentinel-3 client-side.)
  - ratio_score needs B12/B11, which the binary sync codec does NOT carry. So
    synced/legacy detections have a null ratio and score on persistence·0.1 −
    glint alone. Until the ratio is added to the codec (a format change), the
    score is display-only and the avg-B12 slider stays the gate.
    `clusterDetections` accepts an optional `scoreThreshold` (default 0/off).
```

## VNF Data Pipeline

EOG profile CSVs (one per flare site, every satellite pass since 2012)
are aggregated to daily level per flare by `scripts/build_vnf.py` and
written to a ZSTD-compressed Parquet file (~6 MB, ~1.8M rows).

```
Profile CSVs → nighttime filter → daily aggregation → parquet
                                       ↑
                  terminals.geojson → haversine filter (6 km)
                  flare index      → metadata enrichment (type, category, country)
```

Parquet schema: `flare_id, lat, lon, date, clear, detected, rh_mw, temp_k,
n_passes, type, category, country`. Coordinates are stable per-flare
averages (from profile passes), not per-pass positions.

The web query groups by `flare_id`, computes `total_dates`, `clear_dates`,
`detection_dates`, and returns a detection list with `date, rh_mw, temp_k`.
Persistence = `detection_dates / clear_dates` (real cloud-free denominator).

## P2P Sync

Two LWW-Maps in a shared CRDT document:
- `detections`: `block_id:date` -> detection array
- `processed`: `block_id:date` -> `[lat, lng]` (cloud-free) or `null` (cloudy)
  Binary codec: 4 bytes (2x i16), cloudy sentinel `i16(32767), i16(0)`

Persisted locally via IndexedDB, synced via WebRTC DataChannels +
custom binary sync protocol (state vectors, diffs, live updates).

Distributed detection: blocks are partitioned across peers by hashing
the cache key. Partition updates are sent to workers live (no restart).

## Signaling

WebSocket pub/sub relay for WebRTC signaling. Clients send JSON messages:
`subscribe`, `unsubscribe`, `publish`, `ping`/`pong`.

**Local dev:** `signal/server.js` — stateless relay implementing RFC 6455
framing over `node:http` + `node:crypto`. Zero npm dependencies.
Runs on `ws://localhost:4444` via `make signal`.

**Production:** `signal/worker.js` — Cloudflare Worker with a Durable Object
using the WebSocket Hibernation API. Subscriptions are stored via
`serializeAttachment`/`deserializeAttachment` so they survive hibernation.
All connections route to a single global Durable Object (`idFromName('global')`).
Deploy with `npx wrangler deploy` (config in `wrangler.toml`).
URL: `wss://burnoff-signaling.louis-6bf.workers.dev`.

The signaling URL is set via `<meta name="signaling-url">` in `index.html`.
