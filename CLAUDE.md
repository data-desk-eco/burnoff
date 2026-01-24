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
- `src/burnoff/detect.py` - DAFI v2 detection algorithm
- `src/burnoff/cli.py` - CLI with `detect` (single) and `bulk` (batch) commands
- `queries/` - DuckDB SQL for loading, export, and analysis
- `index.html` - Single-file web map

## Detection Logic
Implements DAFI v2 algorithm (Faruolo et al. 2024):
1. Search Sentinel-2 L2A via Element84 STAC
2. Filter by scene cloud cover (<30%)
3. Check local cloud cover via SCL band (<30% in 3km buffer)
4. Primary test: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0
   - Positive values indicate thermal source (SWIR brighter than NIR)
5. Fallback: Extremely Hot Pixel (EP) test for saturated sources
   - B11 > 0.5 AND B8A < 0.3
6. Cluster detections within 50m, max 200 pixels per cluster
7. Track Occurrence Frequency (OF) = detections / images searched
8. Classify persistence: high (≥30%), mid-high (≥20%), mid-low (≥15%), low (≥10%), intermittent (<10%)

## Changing Detection Parameters
When modifying detection logic in `src/burnoff/detect.py`:
1. Re-run detections: `uv run burnoff bulk data/terminals-run.json -o data/detections.json --year 2025 --no-resume`
2. Rebuild geodata: `make refresh`
3. Commit all generated files (detections.json, .geojson, .pmtiles)

## Notes
- Sentinel-2 COGs are UTM-projected; converted to WGS84 via proj4
- Use `npx serve` not `python -m http.server` (needs range requests)
