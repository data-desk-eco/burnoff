# Burnoff

Client-side Sentinel-2 SWIR flare detection.

## Commands

```bash
make serve        # Dev server on :8000
```

## Key Files

- `web/detect-worker.js` - Detection algorithm (Web Worker)
- `web/app.js` - Map viewer + clustering
- `web/style.css` - UI styles
- `web/index.html` - Entry point

## Detection Algorithm

Uses Sentinel-2 L2A surface reflectance at 20m resolution via Element84 STAC COGs.
Runs entirely client-side in a Web Worker with windowed COG reads (geotiff.js).

Processing uses fixed 256x256 pixel blocks within each Sentinel-2 tile for
deterministic results regardless of viewport/zoom level. Each block is identified
by `{mgrs}_{row}_{col}` and cached in localStorage keyed by `block_id:date`.

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

Detections persist across sessions via localStorage block cache. Multiple
detection runs accumulate into a global view.
