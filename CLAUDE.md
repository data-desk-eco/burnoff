# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync, plus a
VIIRS Nightfire (VNF) mode for browsing EOG's satellite flare catalog.

Zero npm dependencies. The only external libraries are MapLibre GL (map
rendering), geotiff.js (COG reads), and DuckDB-WASM (VNF Parquet
queries), all loaded from CDN. Everything else — CRDT, WebRTC mesh,
sync protocol, IndexedDB persistence, UTM projection math, and the
signal server's WebSocket framing — is hand-rolled using web standards.

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
     Sentinel-2 L2A COGs         VNF Parquet (GCS)
     (B12, B11, B8A, SCL)
```

**S2 mode:** Peers share a single CRDT document. When one peer starts
detection, idle peers read the job from awareness state, partition blocks
by hash, and process their share. Results merge via LWW-Map CRDT.

**VNF mode:** DuckDB-WASM queries a pre-built Parquet file (on GCS in
production, local in dev) containing per-flare daily observations from
EOG profile CSVs. Each row has `clear`/`detected` booleans for real
cloud-free persistence metrics.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make test         # Run determinism tests
make vnf          # Build VNF parquet from EOG profile CSVs
make vnf-upload   # Upload VNF parquet to GCS
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
  app.js              Main thread: map, UI, CRDT sync, cross-date clustering
  vnf.js              VNF data module: DuckDB-WASM Parquet queries
  detect-worker.js    Module Web Worker: delegates to s2-flares for detection
  vendor/s2-flares/   Shared detection library (git submodule)
  crdt.js             LWW-Map CRDT with binary codec
  sync.js             Sync protocol, awareness, validation
  rtc.js              WebRTC DataChannel mesh (raw RTCPeerConnection)
  store.js            IndexedDB persistence with batched flushes
  terminals.geojson   LNG terminal locations (Global Energy Monitor)
  index.html          Entry point
  style.css           UI styles
scripts/
  build_vnf.py        Build VNF parquet from EOG profile CSVs + flare index
signal/
  server.js           WebSocket signaling relay for local dev (RFC 6455 over node:http)
  worker.js           Cloudflare Worker + Durable Object signaling relay (production)
  Dockerfile          Legacy Cloud Run container (unused)
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
| MapLibre GL 5.1 | WebGL map rendering | CDN (`<script>`) |
| geotiff.js 2.1 | Cloud Optimized GeoTIFF reads | Vendored in s2-flares submodule |
| DuckDB-WASM 1.29 | VNF Parquet queries | CDN (`import()`) |

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

Cross-date clustering (main thread, grid-indexed):
  - Anchor-based merge, configurable radius (0-200m, default 135m)
  - Minimum 4 distinct dates per cluster
  - Minimum average B12 per cluster: 0.85 (adjustable via UI slider)
  - Seasonal false-positive flag: clusters with all detections in <=3
    consecutive months are marked (catches sun glint off flat surfaces)
  - Persistence metric: detections / observations per cluster
  - Cloud-free %: fraction of observations with ≤30% cloud (data quality indicator)
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
