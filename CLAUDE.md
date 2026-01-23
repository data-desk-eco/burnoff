# Burnoff

Sentinel-2 SWIR flare detection at LNG facilities.

## Stack
- Python CLI (`uv run burnoff`) for detection
- DuckDB for data storage/transforms
- PMTiles + tippecanoe for vector tiles
- MapLibre GL JS 5.x with globe projection
- GeoTIFF.js + proj4 for COG visualization

## Commands
```bash
make all          # Full pipeline: detect -> db -> geojson -> pmtiles
make refresh      # Rebuild geodata from current detections.json
make serve        # npx serve on :8000
make db           # Open DuckDB shell
make stats        # Detection statistics
```

## Key Files
- `src/burnoff/detect.py` - Core detection with cloud filtering and contrast checks
- `src/burnoff/cli.py` - CLI with `detect` (single) and `bulk` (batch) commands
- `queries/` - DuckDB SQL for loading, export, and analysis
- `index.html` - Single-file web map

## Detection Logic
1. Search Sentinel-2 L2A via Element84 STAC
2. Filter by scene cloud cover (<30%)
3. Check local cloud cover via SCL band (<30% in 2km buffer)
4. Require B12 > 0.5 AND B11 > 0.3 (reflectance)
5. Require flare 3x brighter than background median

## Notes
- Sentinel-2 COGs are UTM-projected; converted to WGS84 via proj4
- Use `npx serve` not `python -m http.server` (needs range requests)
