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

Uses Sentinel-2 L1C TOA reflectance at native 20m resolution via Element84 STAC.
L1C preserves full thermal signal without atmospheric correction clipping.
Cloud masking via L2A SCL band fetched separately.

**Connected component detection:**
1. Find all pixels with B12 ≥ 0.75 (bright SWIR)
2. Group into connected components (4-connectivity)
3. For each component, output the **centroid** (center of bright region)
4. Record max B12, pixel count, and avg B12 for filtering

**At export** (SQL filtering):
- Peak B12 > 0.9
- ≥ 2 detection dates

## Spatial Clustering

Simple overlap-based clustering:
```
Each flare has 20m radius
Merge if centers ≤ 40m apart (radii overlap)
```

Cross-date detections at the same location cluster together automatically.

## Key Files
- `src/burnoff/detect.py` - Detection algorithm (centroid-based)
- `queries/init.sql` - Schema
- `queries/export_map.sql` - GeoJSON export with clustering

## Remote Setup (Claude Code)

When running as remote Claude Code, install dependencies before `make refresh`:
```bash
make deps  # Installs DuckDB CLI and tippecanoe
```

DuckDB spatial extension requires network access to download on first use.
