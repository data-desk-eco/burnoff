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

Uses Sentinel-2 L1C TOA reflectance (B8A, B11, B12) via Element84 STAC. 6km search radius.
L1C preserves full thermal signal without atmospheric correction clipping.
Cloud masking via L2A SCL band fetched separately.

**Per-pixel** (must pass all):
1. B12 > 0.3 AND B11 > 0.2 (bright in SWIR)
2. B12 > 3× local median (contrast)
3. (B11 - B8A) / (B11 + B8A) > 0 (thermal signature, SWIR > NIR)

**Per-cluster** (at detection):
4. Peak B12 ≥ 0.5
5. ≤ 50 pixels (point source, 20m² each)
6. If > 30 pixels, require peak B12 ≥ 0.70
7. Warm region ≤ 100 pixels (B12 > 0.2 connected component containing detection)
8. < 30% cloud cover (scene and local)

**At export** (stricter):
7. Peak B12 ≥ 0.75
8. ≥ 2 detection dates

## Spatial Clustering

Cross-date clustering uses size-aware merging with co-occurrence penalty:
```
radius = sqrt(pixels / π) × 20m

# Size-aware threshold
if max_pixels < 10:
    # Small detections have uncertain centroids (can drift 200-300m)
    threshold = max(100m, min(350m, max_radius × 15))
else:
    # Large detections are spatially accurate
    threshold = max(100m, r_a + r_b)

# Co-occurrence penalty (separates distinct flares)
if locations co-occur on same dates:
    threshold *= (1 - 0.2 × cooccur_count)  # up to 50% reduction
```

- Small detections (< 10 pixels): use aggressive 15× radius scaling, capped at 350m
- Large detections: use sum of radii for more conservative merging
- Co-occurring locations: stricter threshold keeps distinct flares separate

## Key Files
- `src/burnoff/detect.py` - Detection algorithm
- `queries/init.sql` - Schema + clustering macros
- `queries/export_map.sql` - GeoJSON export with clustering

## Remote Setup (Claude Code)

When running as remote Claude Code, install dependencies before `make refresh`:
```bash
make deps  # Installs DuckDB CLI and tippecanoe
```

DuckDB spatial extension requires network access to download on first use.
