# Burnoff

Sentinel-2 SWIR flare detection at LNG facilities.

## Stack
- Python CLI (`uv run burnoff`) for detection
- DuckDB for clustering and export
- PMTiles + tippecanoe for vector tiles
- MapLibre GL JS for web map

## Commands
```bash
make all          # Full pipeline: detect -> db -> geojson -> pmtiles
make refresh      # Rebuild from current detections.json
make serve        # Web server on :8000
```

## Detection Algorithm

Uses Sentinel-2 L2A (B8A, B11, B12) via Element84 STAC. 6km search radius.

**Per-pixel** (must pass all):
1. B12 > 0.3 AND B11 > 0.2 (bright in SWIR)
2. B12 > 3× local median (contrast)
3. (B11 - B8A) / (B11 + B8A) > 0 (thermal signature)

**Per-cluster** (at detection):
4. Peak B12 ≥ 0.5
5. ≤ 200 pixels (point source)
6. < 30% cloud cover (scene and local)

**At export** (stricter):
7. Peak B12 ≥ 0.75
8. ≥ 2 detection dates

## Spatial Clustering

Cross-date clustering uses overlap-based merging:
```
radius = sqrt(pixels / π) × 20m
merge if distance ≤ max(50m, radius_a + radius_b)
```

Large flares tolerate centroid drift; small distinct flares stay separate.

## Key Files
- `src/burnoff/detect.py` - Detection algorithm
- `queries/init.sql` - Schema + clustering macros
- `queries/export_map.sql` - GeoJSON export with clustering
