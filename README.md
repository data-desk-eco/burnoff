# Burnoff

Client-side Sentinel-2 SWIR flare detection.

## Quick Start

```
make serve     # Dev server on :8000
```

Open the map, navigate to an area of interest, select date quarters, and click
**Detect**. The app downloads and processes Sentinel-2 L2A imagery directly in
your browser using a Web Worker.

Detection results sync peer-to-peer between all open sessions via WebRTC. When
you run a detection, other peers automatically split the work and share results
in real time.

## How It Works

Flares emit strongly in shortwave infrared. Burnoff reads cloud-optimized GeoTIFF
bands (B12, B11, B8A) from Element84's STAC catalog via windowed HTTP range requests,
runs a version of the DAFI v2 detection algorithm client-side, and clusters
detections across dates using anchor-based merging within 50m.

**Detection pipeline:**
1. STAC search for L2A images in viewport (<30% cloud)
2. Per-image: brightness, contrast, thermal signature (NHISWNIR), connected components
3. Cross-date clustering, anchored to brightest detection per cluster

## Project Structure

```
burnoff/
├── web/
│   ├── index.html           # Entry point
│   ├── app.js               # Map viewer, clustering, P2P sync
│   ├── detect-worker.js     # Detection algorithm (Web Worker)
│   └── style.css            # UI styles
├── test/                    # Determinism + P2P tests
├── Makefile
└── package.json
```

## References

Faruolo et al. (2024) [The DAFI v2 algorithm for gas flare detection](https://doi.org/10.1088/1748-9326/ad82fb)
