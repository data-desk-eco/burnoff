"""Core detection logic using Sentinel-2 SWIR bands.

Detects gas flares using DAFI v2 methodology (Faruolo et al. 2024) with
L1C top-of-atmosphere radiance data:

1. Thermal index: NHISWNIR = (L_SWIR1 - L_NIR) / (L_SWIR1 + L_NIR) > 0
   (SWIR brighter than NIR indicates thermal emission, not solar reflection)
2. Extremely hot pixel (EP): L_SWIR1 ≥ 70 W/(m²·sr·μm) for saturated sources
3. Cluster filters: size, peakedness, point-source checks

Uses L1C radiance to preserve full thermal signal without atmospheric clipping.
Cloud masking via L2A SCL band fetched separately.
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

# GDAL/rasterio environment for remote access (COG and JP2)
os.environ.setdefault("GDAL_HTTP_UNSAFESSL", "YES")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.jp2")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")  # HTTP/2 for multiplexing
os.environ.setdefault("GDAL_HTTP_MAX_CONNECTIONS", "8")  # Connection pool per host
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "10000000")  # 10MB cache

STAC_API = "https://earth-search.aws.element84.com/v1"

# Sentinel-2 L1C S3 bucket (public, non-requester-pays via HTTP)
L1C_S3_BUCKET = "sentinel-s2-l1c"
L1C_S3_REGION = "eu-central-1"

# Detection thresholds (L1C TOA reflectance, 0-1+ scale)
# Based on DAFI v2 (Faruolo et al. 2024) methodology adapted for reflectance
# NHISWNIR > 0 is primary test (B11 > B8A indicates thermal emission)
# EP test: saturated SWIR with low visible indicates extreme heat

# Reflectance thresholds for candidate pixels
B12_THRESHOLD = 0.3           # Min B12 reflectance for candidate pixel
B11_THRESHOLD = 0.2           # Min B11 reflectance for candidate pixel
MIN_PEAK_B12 = 0.50           # Min peak B12 reflectance within cluster
CONNECTIVITY_B12 = 0.75       # Higher threshold for connectivity (grabs bright core only)

# Saturation indicates extreme thermal emission (flares can saturate SWIR)
SATURATION_THRESHOLD = 1.0    # Reflectance > 1.0 indicates saturation

# Contrast and morphology filters
MIN_CONTRAST_RATIO = 3.0      # Flare must be Nx brighter than local background
BACKGROUND_FLOOR = 0.15       # Minimum baseline for contrast calculation
MIN_PEAKEDNESS = 1.15         # max >= 1.15 * avg (15% peak above average)

MAX_LOCAL_CLOUD_FRACTION = 0.3  # Max 30% cloud cover in local area
MAX_FLARE_PIXELS = 50         # Absolute max pixels (20m resolution = 400m² per pixel)
LARGE_DETECTION_PIXELS = 30   # Above this threshold...
LARGE_DETECTION_MIN_B12 = 0.70  # ...require higher reflectance
WARM_REGION_FRACTION = 0.5    # Threshold = peak * this fraction
MAX_WARM_REGION_PIXELS = 100  # Max size of connected warm region
DEFAULT_BUFFER_M = 6000       # Search radius around terminal (6km)


@dataclass
class Detection:
    """A single flare detection result.

    flare_lon/lat = centroid of bright region (primary location)
    max_pixel_lon/lat = brightest pixel location (for comparison)
    """
    date: date
    max_b12: float  # Peak B12 reflectance
    pixel_count: int  # Number of pixels in bright region
    # Centroid of bright region (primary location)
    flare_lon: float | None = None
    flare_lat: float | None = None
    # Max pixel location (for comparison/debugging)
    max_pixel_lon: float | None = None
    max_pixel_lat: float | None = None
    # Image URLs for on-demand rendering
    cog_urls: dict | None = None  # {b11, b12, visual} URLs
    bounds: tuple | None = None   # (minx, miny, maxx, maxy) in EPSG:4326
    utm_bounds: tuple | None = None  # (minx, miny, maxx, maxy) in native UTM
    epsg: int | None = None  # UTM zone EPSG code
    # DAFI v2: NHISWNIR value at detection (for diagnostics)
    nhiswnir: float | None = None
    # Avg B12 in bright region
    avg_b12: float | None = None


def s3_to_http(s3_url: str) -> str:
    """Convert S3 URL to HTTP URL for public access.

    s3://sentinel-s2-l1c/tiles/... -> https://sentinel-s2-l1c.s3.eu-central-1.amazonaws.com/tiles/...
    """
    if s3_url.startswith("s3://"):
        path = s3_url.replace(f"s3://{L1C_S3_BUCKET}/", "")
        return f"https://{L1C_S3_BUCKET}.s3.{L1C_S3_REGION}.amazonaws.com/{path}"
    return s3_url  # Already HTTP


def dn_to_reflectance(dn: np.ndarray) -> np.ndarray:
    """Convert Sentinel-2 L1C DN values to TOA reflectance.

    L1C stores quantized TOA reflectance: ρ = DN / 10000
    Values > 1.0 indicate saturation (common for thermal sources in SWIR).

    Args:
        dn: Digital number array (uint16)

    Returns:
        TOA reflectance (0-1+, can exceed 1.0 for saturated pixels)
    """
    return dn.astype(np.float32) / 10000.0


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
                    "flare_lon": d.flare_lon,  # Centroid
                    "flare_lat": d.flare_lat,
                    "max_pixel_lon": d.max_pixel_lon,  # Brightest pixel
                    "max_pixel_lat": d.max_pixel_lat,
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
    collection: str = "sentinel-2-l1c",
) -> list[dict]:
    """Search Element84 STAC API for Sentinel-2 images.

    Args:
        collection: STAC collection to search (sentinel-2-l1c for radiance data)
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


def search_l1c_with_l2a(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    max_cloud: int = 30,
    buffer_deg: float = 0.05,
) -> list[tuple[dict, dict | None]]:
    """Search for L1C images and match with L2A for SCL cloud masks.

    Returns list of (l1c_item, l2a_item) tuples. l2a_item may be None if no match.
    """
    # Search both collections in parallel
    with ThreadPoolExecutor(max_workers=2) as executor:
        l1c_future = executor.submit(
            search_stac, lat, lon, start_date, end_date, max_cloud, buffer_deg, "sentinel-2-l1c"
        )
        l2a_future = executor.submit(
            search_stac, lat, lon, start_date, end_date, max_cloud, buffer_deg, "sentinel-2-l2a"
        )
        l1c_items = l1c_future.result()
        l2a_items = l2a_future.result()

    # Build lookup for L2A by date+tile
    l2a_by_key = {}
    for item in l2a_items:
        dt = item["properties"]["datetime"][:10]
        tile = item["properties"].get("s2:mgrs_tile", "")
        key = f"{dt}_{tile}"
        l2a_by_key[key] = item

    # Match L1C with L2A
    result = []
    for l1c in l1c_items:
        dt = l1c["properties"]["datetime"][:10]
        tile = l1c["properties"].get("s2:mgrs_tile", "")
        key = f"{dt}_{tile}"
        l2a = l2a_by_key.get(key)
        result.append((l1c, l2a))

    return result


def process_image(
    l1c_item: dict,
    lat: float,
    lon: float,
    buffer_m: int = DEFAULT_BUFFER_M,
    max_local_cloud: float = MAX_LOCAL_CLOUD_FRACTION,
    l2a_item: dict | None = None,
) -> list[Detection]:
    """Process a single Sentinel-2 L1C image using DAFI v2 algorithm.

    DAFI v2 detection criteria (Faruolo et al. 2024):
    1. Local area mostly cloud-free (SCL band from L2A)
    2. Primary: NHISWNIR = (L_B11 - L_B8A) / (L_B11 + L_B8A) > 0 (thermal signature)
    3. Fallback: Extremely Hot Pixel (EP) test for saturated sources

    Args:
        l1c_item: Sentinel-2 L1C STAC item (radiance data)
        l2a_item: Optional L2A item for SCL cloud mask

    Returns a list of detections (one per distinct flare cluster in the image).
    """
    try:
        # L1C band URLs (S3 format, need conversion)
        b11_url = s3_to_http(l1c_item["assets"]["swir16"]["href"])
        b12_url = s3_to_http(l1c_item["assets"]["swir22"]["href"])
        b8a_url = l1c_item["assets"].get("nir08", {}).get("href")
        if b8a_url:
            b8a_url = s3_to_http(b8a_url)
        visual_url = l1c_item["assets"].get("visual", {}).get("href")
        if visual_url:
            visual_url = s3_to_http(visual_url)

        epsg = l1c_item["properties"]["proj:epsg"]
        img_date = date.fromisoformat(l1c_item["properties"]["datetime"][:10])

        # L2A URLs for cloud masking and visualization (COGs work with geotiff.js)
        scl_url = None
        viz_b11_url = None
        viz_b12_url = None
        viz_visual_url = None
        if l2a_item and "scl" in l2a_item.get("assets", {}):
            scl_url = l2a_item["assets"]["scl"]["href"]
            # Use L2A COGs for frontend visualization (geotiff.js doesn't support JP2)
            viz_b11_url = l2a_item["assets"].get("swir16", {}).get("href")
            viz_b12_url = l2a_item["assets"].get("swir22", {}).get("href")
            viz_visual_url = l2a_item["assets"].get("visual", {}).get("href")
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
        # Check local cloud cover using SCL band from L2A
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
                scl = src.read(1, window=window)  # Native resolution
                cloud_mask = np.isin(scl, [3, 8, 9, 10])
                cloud_fraction = cloud_mask.sum() / cloud_mask.size
                if cloud_fraction > max_local_cloud:
                    return []  # Too cloudy locally

        # Read L1C bands and convert to TOA reflectance
        with rasterio.open(b11_url) as src:
            img_bounds = src.bounds
            clipped = (
                max(utm_bounds[0], img_bounds.left),
                max(utm_bounds[1], img_bounds.bottom),
                min(utm_bounds[2], img_bounds.right),
                min(utm_bounds[3], img_bounds.top),
            )
            window = from_bounds(*clipped, src.transform)
            b11_dn = src.read(1, window=window)  # Native 20m resolution
            b11 = dn_to_reflectance(b11_dn)

        with rasterio.open(b12_url) as src:
            img_bounds = src.bounds
            clipped_bounds = (
                max(utm_bounds[0], img_bounds.left),
                max(utm_bounds[1], img_bounds.bottom),
                min(utm_bounds[2], img_bounds.right),
                min(utm_bounds[3], img_bounds.top),
            )
            window = from_bounds(*clipped_bounds, src.transform)
            b12_dn = src.read(1, window=window)  # Native 20m resolution
            b12 = dn_to_reflectance(b12_dn)
            actual_bounds = clipped_bounds
            pixel_size = src.res[0]  # Should be 20m for SWIR bands

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
                    b8a_dn = src.read(1, window=window)  # Native 20m resolution
                    b8a = dn_to_reflectance(b8a_dn)
            except Exception:
                b8a = None

        # === CONNECTED COMPONENT CENTROID DETECTION ===
        # Find bright regions and compute their centroids
        # Output both centroid (primary) and max pixel location (for comparison)

        # Mask of bright pixels for connected components
        bright_mask = b12 >= CONNECTIVITY_B12

        if not bright_mask.any():
            return []

        # Find connected components
        labeled, num_features = ndimage.label(bright_mask)

        # Compute NHISWNIR for thermal signature validation
        nhiswnir = np.zeros_like(b11)
        if b8a is not None:
            denominator = b11 + b8a
            valid = denominator > 0.01
            np.divide(b11 - b8a, denominator, out=nhiswnir, where=valid)

        # Use L2A COGs for visualization (browser-friendly), fall back to L1C JP2
        cog_b11 = viz_b11_url or b11_url
        cog_b12 = viz_b12_url or b12_url
        cog_visual = viz_visual_url or visual_url

        detections = []
        for label_id in range(1, num_features + 1):
            component_mask = labeled == label_id
            pixel_count = int(component_mask.sum())

            if pixel_count < 1:
                continue

            # Get component pixel coordinates and values
            rows, cols = np.where(component_mask)
            b12_vals = b12[component_mask]

            # Component stats
            max_b12 = float(b12_vals.max())
            avg_b12 = float(b12_vals.mean())

            # Skip if below threshold
            if max_b12 < MIN_PEAK_B12:
                continue

            # CENTROID: unweighted center of bright region
            centroid_row = float(rows.mean())
            centroid_col = float(cols.mean())

            # MAX PIXEL: location of brightest pixel
            max_idx = b12_vals.argmax()
            max_row, max_col = rows[max_idx], cols[max_idx]

            # Convert centroid to lat/lon (primary location)
            col_frac = (centroid_col + 0.5) / b12.shape[1]
            row_frac = (centroid_row + 0.5) / b12.shape[0]
            centroid_utm_x = actual_bounds[0] + col_frac * (actual_bounds[2] - actual_bounds[0])
            centroid_utm_y = actual_bounds[3] - row_frac * (actual_bounds[3] - actual_bounds[1])
            centroid_lon, centroid_lat = transformer_to_wgs.transform(centroid_utm_x, centroid_utm_y)

            # Convert max pixel to lat/lon (for comparison)
            col_frac = (max_col + 0.5) / b12.shape[1]
            row_frac = (max_row + 0.5) / b12.shape[0]
            max_utm_x = actual_bounds[0] + col_frac * (actual_bounds[2] - actual_bounds[0])
            max_utm_y = actual_bounds[3] - row_frac * (actual_bounds[3] - actual_bounds[1])
            max_lon, max_lat = transformer_to_wgs.transform(max_utm_x, max_utm_y)

            peak_nhiswnir = float(nhiswnir[max_row, max_col]) if b8a is not None else None

            detections.append(Detection(
                date=img_date,
                max_b12=max_b12,
                pixel_count=pixel_count,
                flare_lon=centroid_lon,  # Primary: centroid
                flare_lat=centroid_lat,
                cog_urls={"b11": cog_b11, "b12": cog_b12, "visual": cog_visual},
                bounds=wgs_bounds,
                utm_bounds=utm_bounds,
                epsg=int(epsg),
                nhiswnir=peak_nhiswnir,
                avg_b12=avg_b12,
                max_pixel_lon=max_lon,  # Secondary: max pixel location
                max_pixel_lat=max_lat,
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
    - Uses Sentinel-2 L1C TOA radiance (preserves full thermal signal)
    - Uses L2A SCL band for cloud masking
    - Primary: NHISWNIR = (L_B11 - L_B8A) / (L_B11 + L_B8A) > 0 indicates thermal source
    - Fallback: EP test for extremely hot pixels (L_B11 ≥ 70 W/m²/sr/μm)

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
    # Search L1C images with matched L2A for SCL cloud masks
    item_pairs = search_l1c_with_l2a(lat, lon, start_date, end_date, max_cloud)

    if not item_pairs:
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
                process_image, l1c_item, lat, lon, buffer_m, max_local_cloud, l2a_item
            ): l1c_item
            for l1c_item, l2a_item in item_pairs
        }

        for future in as_completed(futures):
            completed += 1
            if progress_callback:
                progress_callback(completed, len(item_pairs))

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
        images_searched=len(item_pairs),
        images_with_detection=images_with_detection,
        detections=detections,
    )
