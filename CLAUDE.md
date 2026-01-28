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

1. STAC search for L2A images in viewport, last 6 months, <30% cloud
2. Per-image: read B12, B11, B8A, SCL bands (windowed)
3. DN to reflectance: `(DN - 1000) / 10000` (L2A offset)
4. Brightness filter: B12 > 0.3 AND B11 > 0.2
5. Contrast filter: B12 > median(background) * 3.0, floor 0.15
6. Thermal filter: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 OR saturation
7. Connected components (BFS, 4-connectivity)
8. Cluster filters: size, peak, peakedness, single-pixel, warm-region halo
9. Cross-date clustering: Union-Find merge within 41m, anchor to brightest
