# Burnoff

Sentinel-2 SWIR flare detection at LNG facilities.

## Commands

```bash
make refresh      # Rebuild from current detections.json
make serve        # Dev server on :8000
make deploy       # Upload to GCS
```

## Key Files

- `src/burnoff/detect.py` - Detection algorithm
- `queries/export_map.sql` - GeoJSON export with clustering
- `web/app.js` - Map viewer

## Detection Algorithm

Uses Sentinel-2 L1C TOA reflectance at 20m resolution via Element84 STAC.
Connected component detection: find B12 ≥ 0.75 pixels, group, output centroids.
Cross-date clustering merges detections ≤40m apart, anchored to brightest.
Solar zenith correction: `b12_corrected = B12 × cos(θ_z)` removes seasonal bias
from TOA reflectance (flares are thermal emitters, not reflectors).
