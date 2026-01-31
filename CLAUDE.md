# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync.

## Architecture

```
  Browser (app.js)                         Browser (peer)
 ┌──────────────────────┐                 ┌──────────────────────┐
 │  MapLibre GL         │                 │  MapLibre GL         │
 │  ┌────────────────┐  │   WebRTC /      │  ┌────────────────┐  │
 │  │ Yjs CRDT Doc   │◄─┼── WebSocket ──►─┼─►│ Yjs CRDT Doc   │  │
 │  │  detections Map │  │   (y-webrtc)    │  │  detections Map │  │
 │  │  processed  Map │  │                 │  │  processed  Map │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 │          │           │                 │          │           │
 │  IndexedDB           │                 │  IndexedDB           │
 │          │           │                 │          │           │
 │  ┌───────▼────────┐  │                 │  ┌───────▼────────┐  │
 │  │ detect-worker  │  │                 │  │ detect-worker  │  │
 │  │  (Web Worker)  │  │                 │  │  (Web Worker)  │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 └──────────┼───────────┘                 └──────────┼───────────┘
            │ HTTP range requests                    │
            ▼                                        ▼
     Element84 STAC API
     Sentinel-2 L2A COGs
     (B12, B11, B8A, SCL)
```

Peers share a single Yjs document. When one peer starts detection,
idle peers read the job from awareness state, partition blocks by
hash, and process their share. Results merge via CRDT.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make deploy       # Deploy signaling to Cloud Run
```

## Key Files

```
web/
  app.js              Main thread: map, UI, Yjs sync, cross-date clustering
  detect-worker.js    Web Worker: STAC search, band reads, per-block detection
  index.html          Entry point
  style.css           UI styles
signal-server.js      WebSocket signaling relay (y-webrtc pub/sub)
test/                 Determinism + P2P integration tests
Dockerfile            Cloud Run container for production signaling
```

## Detection Algorithm

Sentinel-2 L2A at 20m resolution via Element84 STAC COGs.
Runs entirely client-side in a Web Worker with windowed reads (geotiff.js).

Processing uses fixed 256x256 pixel blocks within each tile.
Each block is identified by `{mgrs}_{row}_{col}` and cached by `block_id:date`.

```
Per-block pipeline (fused into minimal passes):

  1. STAC search for L2A images in viewport, <30% cloud
  2. Read B12, B11, B8A, SCL bands (windowed, 10px overlap)
  3. Cloud check via SCL (skip blocks >30% cloud, excluding bright pixels)
  4. Pre-pass: B12 DN → reflectance, collect background for median
  5. Fused pass: B11/B8A DN → reflectance + brightness + contrast + thermal → mask
     - Brightness:  B12 > 0.3 AND B11 > 0.2
     - Contrast:    B12 > median(background) * 3.0, floor 0.15
     - Thermal:     NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 OR saturation
  6. Connected components (BFS, 4-connectivity)
  7. Cluster filters: size, peak, peakedness, single-pixel, warm-region halo
  8. Overlap dedup: canonical block via floor(pixel / 256)

Cross-date clustering (main thread, grid-indexed):
  - Anchor-based merge within 50m (no transitive chaining)
  - Minimum 4 distinct dates per cluster
  - Minimum average B12 per cluster: 0.70
```

## P2P Sync

Two Yjs maps in a shared document (`burnoff-global`):
- `detections`: `block_id:date` -> detection array
- `processed`: `block_id:date` -> timestamp (cache marker)

Persisted locally via IndexedDB, synced via WebRTC (y-webrtc) +
WebSocket fallback (Yjs sync protocol over the signaling connection).

Distributed detection: blocks are partitioned across peers by hashing
the cache key. Partition updates are sent to workers live (no restart).

## Signaling

`signal-server.js` is a stateless WebSocket relay (~80 lines).
Messages: `subscribe`, `unsubscribe`, `publish`, `ping`/`pong`.
Dev: `ws://localhost:4444`. Production: set via `<meta name="signaling-url">`.
