# Burnoff

Client-side Sentinel-2 SWIR flare detection.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
```

## Key Files

- `web/detect-worker.js` - Detection algorithm (Web Worker)
- `web/app.js` - Map viewer, clustering, P2P sync
- `web/style.css` - UI styles
- `web/index.html` - Entry point
- `signal-server.js` - WebRTC signaling relay (Node.js)

## Detection Algorithm

Uses Sentinel-2 L2A surface reflectance at 20m resolution via Element84 STAC COGs.
Runs entirely client-side in a Web Worker with windowed COG reads (geotiff.js).

Processing uses fixed 256x256 pixel blocks within each Sentinel-2 tile for
deterministic results regardless of viewport/zoom level. Each block is identified
by `{mgrs}_{row}_{col}` and cached by `block_id:date`.

1. STAC search for L2A images in viewport, <30% cloud
2. Per-image: enumerate 256px blocks overlapping viewport, skip cached blocks
3. Per-block: read B12, B11, B8A, SCL bands (windowed with 10px overlap)
4. DN to reflectance: `(DN - 1000) / 10000` (L2A offset)
5. Brightness filter: B12 > 0.3 AND B11 > 0.2
6. Contrast filter: B12 > median(background) * 3.0, floor 0.15
7. Thermal filter: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 OR saturation
8. Connected components (BFS, 4-connectivity)
9. Cluster filters: size, peak, peakedness, single-pixel, warm-region halo
10. Overlap dedup: canonical block assignment via `floor(pixel / 256)`
11. Cross-date clustering: anchor-based merge within 50m

## P2P Sync

Detection results are stored in a Yjs CRDT document, persisted locally via
IndexedDB and synced across peers via WebRTC (y-webrtc). Signaling is handled
by `signal-server.js` — a lightweight WebSocket relay. In dev, the client
auto-connects to `ws://<hostname>:4444`. For production, deploy signal-server.js
and set the URL via `<meta name="signaling-url" content="wss://...">`.
When a peer starts detection, other idle peers automatically help by processing
a deterministic partition of the blocks.

## Cross-Date Clustering Thresholds

- Merge distance: 50m
- Minimum distinct dates per cluster: 4
- Minimum average B12 per cluster: 0.70
