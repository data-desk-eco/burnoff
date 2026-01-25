# Burnoff

Sentinel-2 SWIR flare detection at LNG export terminals.

## Quick Start

```
make refresh    # Build from current detections
make serve      # Dev server on :8000
make deploy     # Upload to GCS
```

## Detection

Uses Sentinel-2 L1C at native 20m resolution. L1C preserves full thermal signal
without atmospheric correction clipping.

**Algorithm:**
1. Find pixels with B12 ≥ 0.75 (bright SWIR)
2. Group into connected components (4-connectivity)
3. Output centroid of each component
4. Cluster across dates where footprints overlap (≤40m apart)

**Export filters:** peak B12 > 0.9, ≥6 detections per year

## Project Structure

```
burnoff/
├── src/burnoff/     # Python detection CLI
├── web/             # Map viewer (HTML/CSS/JS)
├── queries/         # DuckDB SQL
├── data/            # Generated files (gitignored)
└── Makefile
```

## Requirements

- Python 3.12+ with uv
- DuckDB CLI
- tippecanoe
