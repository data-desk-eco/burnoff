# Burnoff

Sentinel-2 SWIR flare detection at LNG facilities.

## Stack
- Python CLI (`uv run burnoff`) for detection
- DuckDB for data storage/transforms
- PMTiles + tippecanoe for vector tiles
- MapLibre GL JS 5.x with globe projection
- GeoTIFF.js for COG visualization

## Commands
```bash
make all          # Full pipeline: detect -> db -> geojson -> pmtiles
make refresh      # Rebuild geodata from current detections.json
make serve        # npx serve on :8000
make db           # Open DuckDB shell
make stats        # Detection statistics
```

## Key Files
- `src/burnoff/cli.py` - CLI with `detect` (single) and `bulk` (batch) commands
- `src/burnoff/detect.py` - Core detection logic using Sentinel-2 SWIR bands
- `queries/` - DuckDB SQL for loading, export, and analysis
- `index.html` - Single-file web map

## Data Flow
1. `burnoff bulk terminals.json -o detections.json --year 2024`
2. DuckDB loads JSON into `detections` table
3. `export_map.sql` outputs GeoJSON with each detection at max B12 pixel location
4. tippecanoe creates PMTiles

## Notes
- Sentinel-2 COGs are UTM-projected; bounds in DB are WGS84
- Use `npx serve` not `python -m http.server` (needs range requests for PMTiles)
