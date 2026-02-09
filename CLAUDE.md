# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync.

Zero npm dependencies. The only external libraries are MapLibre GL (map
rendering) and geotiff.js (COG reads), loaded from CDN. Everything
else — CRDT, WebRTC mesh, sync protocol, IndexedDB persistence, UTM
projection math, and the signal server's WebSocket framing — is
hand-rolled using web standards.

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
     Element84 STAC API
     Sentinel-2 L2A COGs
     (B12, B11, B8A, SCL)
```

Peers share a single CRDT document. When one peer starts detection,
idle peers read the job from awareness state, partition blocks by
hash, and process their share. Results merge via LWW-Map CRDT.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make test         # Run determinism tests
make deploy       # Deploy signaling to Cloud Run
```

No `npm install` required. Dev server uses `python3 -m http.server`.
Signal server uses only `node:http` and `node:crypto` (Node.js builtins).
Tests use `node:test` and `node:assert`.

## Key Files

```
web/
  app.js              Main thread: map, UI, CRDT sync, cross-date clustering
  detect.js           Web Worker: STAC search, band reads, per-block detection
  utm.js              UTM <-> WGS84 projection (inline Transverse Mercator)
  crdt.js             LWW-Map CRDT with binary codec
  sync.js             Sync protocol, awareness, validation
  rtc.js              WebRTC DataChannel mesh (raw RTCPeerConnection)
  store.js            IndexedDB persistence with batched flushes
  terminals.geojson   LNG terminal locations (Global Energy Monitor)
  index.html          Entry point
  style.css           UI styles
signal/
  server.js           WebSocket signaling relay (RFC 6455 over node:http)
  Dockerfile          Cloud Run container for production signaling
test/
  determinism.test.mjs  Detection + clustering determinism tests (node:test)
  p2p-test.html         CRDT codec + sync integration tests (browser)
```

## External Dependencies

| Library | Purpose | Loaded from |
|---------|---------|-------------|
| MapLibre GL 5.1 | WebGL map rendering | CDN (`<script>`) |
| geotiff.js 2.1 | Cloud Optimized GeoTIFF reads | CDN (`<script>` + `importScripts`) |

Everything else uses browser/Node.js builtins:
WebRTC, IndexedDB, Web Workers, Fetch, Canvas, WebSocket,
TextEncoder/Decoder, Blob, crypto (Node), http (Node).

## Detection Algorithm

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

`signal/server.js` is a stateless WebSocket relay implementing RFC 6455
framing over `node:http` + `node:crypto`. Zero npm dependencies.
Messages: `subscribe`, `unsubscribe`, `publish`, `ping`/`pong`.
Dev: `ws://localhost:4444`. Production: set via `<meta name="signaling-url">`.
