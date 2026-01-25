"""Core detection logic using Sentinel-2 SWIR bands.

Detects gas flares using a hybrid approach combining intensity thresholds,
local contrast, and thermal signature confirmation:

1. Intensity: B12 > 0.3 and B11 > 0.2 (pixel must be bright in SWIR)
2. Contrast: B12 > 3× local background median (must stand out)
3. Thermal: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 (SWIR > NIR confirms heat)
4. Cluster peak: max B12 ≥ 0.50 within connected component (permissive; SQL export filters at 0.75)

Inspired by DAFI v2 (Faruolo et al. 2024) but adapted for L2A surface reflectance.
"""

import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from pyproj import Transformer
from scipy import ndimage

# GDAL/rasterio environment for COG access
os.environ.setdefault("GDAL_HTTP_UNSAFESSL", "YES")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")  # HTTP/2 for multiplexing
os.environ.setdefault("GDAL_HTTP_MAX_CONNECTIONS", "8")  # Connection pool per host
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "10000000")  # 10MB cache

STAC_API = "https://earth-search.aws.element84.com/v1"

# Detection thresholds (L2A surface reflectance, 0-1 scale)
# These are intentionally permissive - stricter filtering happens in SQL export
B12_THRESHOLD = 0.3       # Min B12 (SWIR2) for candidate pixel
B11_THRESHOLD = 0.2       # Min B11 (SWIR1) for candidate pixel
MIN_PEAK_B12 = 0.50       # Min peak B12 within cluster (permissive; SQL export filters at 0.75)
MIN_CONTRAST_RATIO = 3.0  # Flare must be Nx brighter than local background
BACKGROUND_FLOOR = 0.15   # Minimum baseline for contrast calculation

# Peakedness: flares have a bright core, false positives (roofs, solar) are uniform
# Require max to be at least this factor above the cluster average
MIN_PEAKEDNESS = 1.15     # max_b12 >= 1.15 * avg_b12 (15% peak above average)

MAX_LOCAL_CLOUD_FRACTION = 0.3  # Max 30% cloud cover in local area
MAX_FLARE_PIXELS = 50     # Absolute max pixels (20m resolution = 1000m² per pixel)
# Size-dependent intensity: large low-intensity detections are often factory roofs/solar farms
LARGE_DETECTION_PIXELS = 30   # Above this threshold...
LARGE_DETECTION_MIN_B12 = 0.70  # ...require higher intensity
# Point source filter: check size of warm region around detection
# Solar farms have huge warm footprints; flares are compact point sources
WARM_REGION_FRACTION = 0.5    # Threshold = peak * this fraction
MAX_WARM_REGION_PIXELS = 75   # Max size of connected warm region
DEFAULT_BUFFER_M = 6000   # Search radius around terminal (6km)


@dataclass
class Detection:
    """A single flare detection result.

    Represents a raw detection at the actual max B12 pixel location.
    Clustering is done in SQL export, not here.
    """
    date: date
    max_b12: float
    pixel_count: int
    # Actual location of max B12 pixel (raw, unclustered)
    flare_lon: float | None = None
    flare_lat: float | None = None
    # COG URLs for on-demand rendering
    cog_urls: dict | None = None  # {b11, b12, visual} URLs
    bounds: tuple | None = None   # (minx, miny, maxx, maxy) in EPSG:4326
    utm_bounds: tuple | None = None  # (minx, miny, maxx, maxy) in native UTM
    epsg: int | None = None  # UTM zone EPSG code
    # DAFI v2: NHISWNIR value at detection (for diagnostics)
    nhiswnir: float | None = None
    # Peakedness: avg B12 in cluster (flares: max >> avg, false positives: max ≈ avg)
    avg_b12: float | None = None


@dataclass
class DetectionResult:
    """Aggregated detection results for a location."""
    lat: float
    lon: float
    start_date: date
    end_date: date
    images_searched: int
    images_with_detection: int
    detections: list[Detection]

    @property
    def occurrence_frequency(self) -> float | None:
        """DAFI v2 Occurrence Frequency: detection days / total images (%)."""
        if self.images_searched == 0:
            return None
        return (self.images_with_detection / self.images_searched) * 100

    @property
    def persistence_level(self) -> str | None:
        """DAFI v2 persistence classification based on OF."""
        of = self.occurrence_frequency
        if of is None:
            return None
        if of >= 30:
            return "high"
        elif of >= 20:
            return "mid-high"
        elif of >= 15:
            return "mid-low"
        elif of >= 10:
            return "low"
        else:
            return "intermittent"

    @property
    def max_b12(self) -> float | None:
        if not self.detections:
            return None
        return max(d.max_b12 for d in self.detections)

    def to_dict(self) -> dict:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "images": self.images_searched,
            "detections": self.images_with_detection,
            "occurrence_frequency": self.occurrence_frequency,
            "persistence_level": self.persistence_level,
            "max_b12": self.max_b12,
            "detection_dates": [
                {
                    "date": d.date.isoformat(),
                    "max_b12": d.max_b12,
                    "avg_b12": d.avg_b12,
                    "pixels": d.pixel_count,
                    "flare_lon": d.flare_lon,
                    "flare_lat": d.flare_lat,
                    "cog": d.cog_urls,
                    "bounds": d.bounds,
                    "utm_bounds": d.utm_bounds,
                    "epsg": d.epsg,
                }
                for d in self.detections
            ],
        }


def search_stac(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    max_cloud: int = 30,
    buffer_deg: float = 0.05,
    collection: str = "sentinel-2-l2a",
) -> list[dict]:
    """Search Element84 STAC API for Sentinel-2 images.

    Args:
        collection: STAC collection to search (sentinel-2-l2a default, l1c requires S3 auth)
    """
    bbox = [lon - buffer_deg, lat - buffer_deg, lon + buffer_deg, lat + buffer_deg]
    payload = {
        "collections": [collection],
        "bbox": bbox,
        "datetime": f"{start_date}T00:00:00Z/{end_date}T23:59:59Z",
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
    }

    items = []
    url = f"{STAC_API}/search"

    with httpx.Client(timeout=30) as client:
        while url:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            items.extend(data.get("features", []))

            # Handle pagination
            next_link = next((l for l in data.get("links", []) if l.get("rel") == "next"), None)
            if next_link and next_link.get("body"):
                url = next_link["href"]
                payload = next_link["body"]
            else:
                url = None

    return items


def match_l2a_items(l1c_items: list[dict], l2a_items: list[dict]) -> dict[str, dict]:
    """Match L1C items with corresponding L2A items for SCL cloud mask.

    Returns a dict mapping L1C item datetime to L2A item.
    Matches are based on same datetime and tile.
    """
    l2a_by_key = {}
    for item in l2a_items:
        # Key by datetime and tile
        dt = item["properties"]["datetime"][:10]
        tile = item["properties"].get("s2:mgrs_tile", "")
        key = f"{dt}_{tile}"
        l2a_by_key[key] = item

    matched = {}
    for item in l1c_items:
        dt = item["properties"]["datetime"][:10]
        tile = item["properties"].get("s2:mgrs_tile", "")
        key = f"{dt}_{tile}"
        if key in l2a_by_key:
            matched[item["id"]] = l2a_by_key[key]

    return matched


def process_image(
    item: dict,
    lat: float,
    lon: float,
    buffer_m: int = DEFAULT_BUFFER_M,
    max_local_cloud: float = MAX_LOCAL_CLOUD_FRACTION,
    max_pixels: int = 128,
) -> list[Detection]:
    """Process a single Sentinel-2 L2A image using DAFI v2 algorithm.

    DAFI v2 detection criteria (Faruolo et al. 2024):
    1. Local area mostly cloud-free (SCL band check)
    2. Primary: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 (SWIR > NIR = thermal)
    3. Fallback: Extremely Hot Pixel (EP) test for saturated sources

    Returns a list of detections (one per distinct flare cluster in the image).
    """
    try:
        b11_url = item["assets"]["swir16"]["href"]
        b12_url = item["assets"]["swir22"]["href"]
        b8a_url = item["assets"].get("nir08", {}).get("href")  # B8A (865nm) NIR band
        scl_url = item["assets"].get("scl", {}).get("href")
        visual_url = item["assets"].get("visual", {}).get("href")
        epsg = item["properties"]["proj:epsg"]
        img_date = date.fromisoformat(item["properties"]["datetime"][:10])

        # Get scale/offset for reflectance conversion from raster:bands metadata
        b11_band = item["assets"]["swir16"].get("raster:bands", [{}])[0]
        b12_band = item["assets"]["swir22"].get("raster:bands", [{}])[0]
        b8a_band = item["assets"].get("nir08", {}).get("raster:bands", [{}])[0] if b8a_url else {}

        # L2A default: scale=0.0001, offset=-0.1 (values 0-10000 -> -0.1 to 0.9 reflectance)
        b11_scale = b11_band.get("scale", 0.0001)
        b11_offset = b11_band.get("offset", -0.1)
        b12_scale = b12_band.get("scale", 0.0001)
        b12_offset = b12_band.get("offset", -0.1)
        b8a_scale = b8a_band.get("scale", 0.0001) if b8a_band else 0.0001
        b8a_offset = b8a_band.get("offset", -0.1) if b8a_band else -0.1
    except (KeyError, IndexError):
        return []

    # Transform coordinates to image CRS
    transformer_to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    transformer_to_wgs = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    x, y = transformer_to_utm.transform(lon, lat)
    utm_bounds = (x - buffer_m, y - buffer_m, x + buffer_m, y + buffer_m)

    # Convert bounds back to WGS84 for storage
    min_lon, min_lat = transformer_to_wgs.transform(utm_bounds[0], utm_bounds[1])
    max_lon, max_lat = transformer_to_wgs.transform(utm_bounds[2], utm_bounds[3])
    wgs_bounds = (min_lon, min_lat, max_lon, max_lat)

    try:
        # Check local cloud cover using SCL band
        # SCL classes: 8=cloud_medium_prob, 9=cloud_high_prob, 10=thin_cirrus, 3=cloud_shadow
        if scl_url:
            with rasterio.open(scl_url) as src:
                img_bounds = src.bounds
                clipped = (
                    max(utm_bounds[0], img_bounds.left),
                    max(utm_bounds[1], img_bounds.bottom),
                    min(utm_bounds[2], img_bounds.right),
                    min(utm_bounds[3], img_bounds.top),
                )
                window = from_bounds(*clipped, src.transform)
                out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
                scl = src.read(1, window=window, out_shape=out_shape)
                cloud_mask = np.isin(scl, [3, 8, 9, 10])
                cloud_fraction = cloud_mask.sum() / cloud_mask.size
                if cloud_fraction > max_local_cloud:
                    return []  # Too cloudy locally

        with rasterio.open(b11_url) as src:
            img_bounds = src.bounds
            clipped = (
                max(utm_bounds[0], img_bounds.left),
                max(utm_bounds[1], img_bounds.bottom),
                min(utm_bounds[2], img_bounds.right),
                min(utm_bounds[3], img_bounds.top),
            )
            window = from_bounds(*clipped, src.transform)
            out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
            b11 = src.read(1, window=window, out_shape=out_shape).astype(np.float32) * b11_scale + b11_offset

        with rasterio.open(b12_url) as src:
            img_bounds = src.bounds
            clipped_bounds = (
                max(utm_bounds[0], img_bounds.left),
                max(utm_bounds[1], img_bounds.bottom),
                min(utm_bounds[2], img_bounds.right),
                min(utm_bounds[3], img_bounds.top),
            )
            window = from_bounds(*clipped_bounds, src.transform)
            out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
            b12 = src.read(1, window=window, out_shape=out_shape).astype(np.float32) * b12_scale + b12_offset
            actual_bounds = clipped_bounds

        # Read NIR band (B8A) for NHISWNIR calculation
        b8a = None
        if b8a_url:
            try:
                with rasterio.open(b8a_url) as src:
                    img_bounds = src.bounds
                    clipped = (
                        max(utm_bounds[0], img_bounds.left),
                        max(utm_bounds[1], img_bounds.bottom),
                        min(utm_bounds[2], img_bounds.right),
                        min(utm_bounds[3], img_bounds.top),
                    )
                    window = from_bounds(*clipped, src.transform)
                    out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
                    b8a = src.read(1, window=window, out_shape=out_shape).astype(np.float32) * b8a_scale + b8a_offset
            except Exception:
                b8a = None

        # === HYBRID DETECTION ALGORITHM ===
        # Combines intensity thresholds, contrast ratio, and thermal signature

        # 1. Intensity thresholds - pixel must be bright in SWIR
        bright_mask = (b12 > B12_THRESHOLD) & (b11 > B11_THRESHOLD)

        # 2. Contrast ratio - must stand out from local background
        # Calculate background as median of non-bright pixels
        background_pixels = b12[b12 < B12_THRESHOLD]
        if background_pixels.size < 10:
            return []  # Not enough background to compare
        background_median = float(np.median(background_pixels))
        background_baseline = max(background_median, BACKGROUND_FLOOR)
        contrast_mask = b12 > (background_baseline * MIN_CONTRAST_RATIO)

        # 3. Thermal signature - NHISWNIR > 0 confirms heat source
        # NHISWNIR = (B11 - B8A) / (B11 + B8A), positive = SWIR brighter than NIR
        nhiswnir = np.zeros_like(b11)
        if b8a is not None:
            denominator = b11 + b8a
            valid = denominator > 0.01
            np.divide(b11 - b8a, denominator, out=nhiswnir, where=valid)
            thermal_mask = nhiswnir > 0
        else:
            # Fallback if B8A unavailable: require higher B11
            thermal_mask = b11 > 0.4

        # Combined: must pass ALL three tests
        mask = bright_mask & contrast_mask & thermal_mask

        if not mask.any():
            return []

        # Find connected components (separate flare clusters)
        labeled, num_features = ndimage.label(mask)

        detections = []
        for label_id in range(1, num_features + 1):
            cluster_mask = labeled == label_id
            pixel_count = int(cluster_mask.sum())

            # Skip clusters that are too large (not point sources)
            if pixel_count > MAX_FLARE_PIXELS:
                continue

            # 4. Cluster intensity check - peak B12 must be high
            cluster_b12 = np.where(cluster_mask, b12, 0)
            cluster_max_b12 = float(cluster_b12.max())

            # Skip clusters below peak intensity threshold
            if cluster_max_b12 < MIN_PEAK_B12:
                continue

            # Size-dependent intensity: large detections need higher intensity
            # Filters factory roofs, solar farms that are warm but not flares
            if pixel_count > LARGE_DETECTION_PIXELS and cluster_max_b12 < LARGE_DETECTION_MIN_B12:
                continue

            # 5. Peakedness filter - flares have a bright core, false positives are uniform
            # Real flares: max >> avg (bright core, dimmer edges)
            # False positives (roofs, solar): max ≈ avg (uniform brightness)
            cluster_vals = b12[cluster_mask]
            cluster_avg_b12 = float(np.mean(cluster_vals))

            if pixel_count == 1:
                # Single pixel: can't use peakedness (max = avg), require higher B12
                if cluster_max_b12 < 0.65:
                    continue  # Single pixel needs higher confidence
            else:
                # Multi-pixel: apply peakedness filter
                if cluster_max_b12 < MIN_PEAKEDNESS * cluster_avg_b12:
                    continue  # Too uniform, likely not a flare

            # Get NHISWNIR at max B12 location
            max_idx = np.unravel_index(cluster_b12.argmax(), cluster_b12.shape)
            row, col = max_idx
            cluster_nhiswnir = float(nhiswnir[row, col]) if b8a is not None else None

            # 6. Point source filter - check full extent of warm region
            # Flares are compact; solar farms have huge warm footprints
            warm_threshold = cluster_max_b12 * WARM_REGION_FRACTION
            warm_mask = b12 > warm_threshold
            warm_labeled, _ = ndimage.label(warm_mask)
            warm_region_size = int((warm_labeled == warm_labeled[row, col]).sum())
            if warm_region_size > MAX_WARM_REGION_PIXELS:
                continue

            # Convert pixel coords back to UTM using actual window bounds
            col_frac = (col + 0.5) / b12.shape[1]
            row_frac = (row + 0.5) / b12.shape[0]
            flare_utm_x = actual_bounds[0] + col_frac * (actual_bounds[2] - actual_bounds[0])
            flare_utm_y = actual_bounds[3] - row_frac * (actual_bounds[3] - actual_bounds[1])

            # Convert to WGS84
            flare_lon, flare_lat = transformer_to_wgs.transform(flare_utm_x, flare_utm_y)

            detections.append(Detection(
                date=img_date,
                max_b12=cluster_max_b12,
                pixel_count=pixel_count,
                flare_lon=flare_lon,
                flare_lat=flare_lat,
                cog_urls={"b11": b11_url, "b12": b12_url, "visual": visual_url},
                bounds=wgs_bounds,
                utm_bounds=utm_bounds,
                epsg=int(epsg),
                nhiswnir=cluster_nhiswnir,
                avg_b12=cluster_avg_b12,
            ))

        return detections
    except Exception:
        pass

    return []


def detect(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    max_cloud: int = 30,
    buffer_m: int = DEFAULT_BUFFER_M,
    workers: int = 8,
    max_local_cloud: float = MAX_LOCAL_CLOUD_FRACTION,
    progress_callback=None,
) -> DetectionResult:
    """
    Detect gas flares at a location using DAFI v2 algorithm.

    Implements Faruolo et al. (2024) methodology:
    - Uses Sentinel-2 L2A surface reflectance
    - Uses SCL band for cloud masking
    - Primary: NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 indicates thermal source
    - Tracks Occurrence Frequency (OF) for persistence classification

    Outputs raw detections - clustering and temporal filtering done in SQL export.

    Args:
        lat: Latitude (WGS84)
        lon: Longitude (WGS84)
        start_date: Start of search period
        end_date: End of search period
        max_cloud: Maximum scene cloud cover percentage (default 30)
        buffer_m: Buffer around point in meters (default 6000)
        workers: Parallel workers for image processing (default 8)
        max_local_cloud: Maximum local cloud fraction (default 0.3)
        progress_callback: Optional callback(current, total) for progress updates

    Returns:
        DetectionResult with raw detections and occurrence frequency stats
    """
    # Search L2A images (L1C not accessible via public HTTPS COGs)
    items = search_stac(lat, lon, start_date, end_date, max_cloud, collection="sentinel-2-l2a")

    if not items:
        return DetectionResult(
            lat=lat, lon=lon, start_date=start_date, end_date=end_date,
            images_searched=0, images_with_detection=0, detections=[],
        )

    detections = []
    images_with_detection = 0
    completed = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                process_image, item, lat, lon, buffer_m, max_local_cloud
            ): item
            for item in items
        }

        for future in as_completed(futures):
            completed += 1
            if progress_callback:
                progress_callback(completed, len(items))

            results = future.result()
            if results:
                images_with_detection += 1
                detections.extend(results)

    # Sort by date - clustering and temporal filtering now done in SQL export
    detections.sort(key=lambda d: d.date)

    return DetectionResult(
        lat=lat,
        lon=lon,
        start_date=start_date,
        end_date=end_date,
        images_searched=len(items),
        images_with_detection=images_with_detection,
        detections=detections,
    )
