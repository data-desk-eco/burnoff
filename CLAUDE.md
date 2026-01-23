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
make serve        # npx serve (supports range requests for PMTiles)
make db           # Open DuckDB shell
make stats        # Detection statistics
```

## Key Files
- `src/burnoff/cli.py` - CLI with `detect` (single) and `bulk` (batch) commands
- `queries/export_map.sql` - Exports individual detections as GeoJSON
- `index.html` - Single-file web map

## Data Flow
1. `burnoff bulk terminals.json -o detections.json --year 2024` - saves every 10 results
2. DuckDB loads JSON, stores in `detections` + `detection_events` tables
3. `export_map.sql` outputs GeoJSON with each detection at its max B12 pixel location
4. tippecanoe creates PMTiles with clustering

## Notes
- Sentinel-2 COGs are UTM-projected; bounds in DB are WGS84
- COG loading reads full image at reduced resolution (avoids projection math)
- Use `npx serve` not `python -m http.server` (needs range requests)
- Bulk process was at 94/458 terminals when stopped
