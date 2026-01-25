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

Cross-date clustering uses size-aware merging with co-occurrence penalty:
```
radius = sqrt(pixels / π) × 20m

# Size-aware threshold (protects small flares from absorption)
if size_ratio > 4x:
    threshold = min(r_a, r_b) × 2 + 20m
else:
    threshold = r_a + r_b

# Co-occurrence penalty (separates distinct flares)
if locations co-occur on same dates:
    threshold *= (1 - 0.2 × cooccur_count)  # up to 50% reduction

merge if distance ≤ max(50m, threshold)
```

- Large similar-size flares: merge at full radius sum (tolerates drift)
- Small + large flare: only merge if small is within large's footprint
- Co-occurring locations: stricter threshold keeps distinct flares separate

## Key Files
- `src/burnoff/detect.py` - Detection algorithm
- `queries/init.sql` - Schema + clustering macros
- `queries/export_map.sql` - GeoJSON export with clustering
