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

## Detection Algorithm

Uses Sentinel-2 L2A surface reflectance (B8A, B11, B12 bands) via Element84 STAC.
Search radius: 6km around each terminal.

**Per-pixel detection** (must pass ALL tests):
1. **Intensity**: B12 > 0.3 AND B11 > 0.2 (bright in SWIR)
2. **Contrast**: B12 > 3× local background median (stands out from surroundings)
3. **Thermal**: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 (SWIR > NIR confirms heat)

**Per-cluster filtering** (at detection time, permissive):
4. Peak B12 ≥ 0.5 within connected component
5. Cluster size ≤ 200 pixels (point source, not large fire)
6. Scene cloud cover < 30%, local cloud cover < 30% (via SCL band)

**Export filtering** (in SQL, stricter):
7. Peak B12 ≥ 0.75 (high confidence flares only)
8. Detection count ≥ 2 (temporal persistence)
9. Overlap-based clustering across dates (see below)

**Output metrics**:
- Occurrence Frequency (OF) = detection days / images searched
- Persistence: high (≥30%), mid-high (≥20%), mid-low (≥15%), low (≥10%), intermittent (<10%)

## Spatial Clustering (Cross-Date)

Detections from different dates are clustered using **overlap-based clustering**:
- Each detection is approximated as a circle: `radius = sqrt(pixels / π) × 20m`
- Two detections merge if their circles overlap: `distance ≤ radius_a + radius_b`
- Minimum merge distance of 50m (floor: 20m pixel + 10m geolocation + 20m viewing angle)

This adaptive approach:
- Keeps large flares together even when centroids drift between dates
- Keeps distinct small flares separate unless they truly overlap spatially

## Changing Detection Parameters
When modifying detection logic in `src/burnoff/detect.py`:
1. Re-run detections: `uv run burnoff bulk data/terminals-run.json -o data/detections.json --year 2025`
2. Rebuild geodata: `make refresh`
3. Commit all generated files (detections.json, .geojson, .pmtiles)

## Notes
- Sentinel-2 COGs are UTM-projected; converted to WGS84 via proj4
- Use `npx serve` not `python -m http.server` (needs range requests)
