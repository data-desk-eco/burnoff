# Burnoff

Client-side Sentinel-2 SWIR flare detection at LNG facilities.

## Quick Start

```
make serve     # Dev server on :8000
```

Open the map, navigate to an LNG terminal, and click **Detect**. The app downloads
and processes Sentinel-2 L2A imagery directly in your browser using a Web Worker.

## How It Works

Flares emit strongly in shortwave infrared. Burnoff reads cloud-optimized GeoTIFF
bands (B12, B11, B8A) from Element84's STAC catalog via windowed HTTP range requests,
runs the full DAFI v2 detection algorithm client-side, and clusters detections across
dates using Union-Find.

**Detection pipeline:**
1. STAC search for L2A images in viewport (last 6 months, <30% cloud)
2. Per-image: brightness, contrast, thermal signature (NHISWNIR), connected components
3. Cross-date clustering (≤41m), anchored to brightest detection per cluster

## Project Structure

```
burnoff/
├── web/
│   ├── index.html           # Entry point
│   ├── app.js               # Map viewer + clustering
│   ├── detect-worker.js     # Detection algorithm (Web Worker)
│   └── style.css            # UI styles
└── Makefile
```

## References

Faruolo et al. (2024) [The DAFI v2 algorithm for gas flare detection](https://doi.org/10.1088/1748-9326/ad82fb)
