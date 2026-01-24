"""Core detection logic using Sentinel-2 SWIR bands."""

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

# Detection thresholds (reflectance units)
B12_THRESHOLD = 0.5  # SWIR2 (2190nm) - primary thermal indicator
B11_THRESHOLD = 0.3  # SWIR1 (1610nm) - confirmation band
MIN_PEAK_B12 = 0.8  # Minimum peak B12 for detection (absolute intensity filter)
MIN_CONTRAST_RATIO = 3.0  # Flare must be Nx brighter than background median
MAX_LOCAL_CLOUD_FRACTION = 0.3  # Max 30% cloud cover in local area
MAX_FLARE_PIXELS = 16  # Flares are point sources; reject large hot areas
CLUSTER_DISTANCE_M = 200  # Cluster flares within this distance


@dataclass
class Detection:
    """A single flare detection result."""
    date: date
    max_b12: float
    pixel_count: int
    # Actual location of max B12 pixel
    flare_lon: float | None = None
    flare_lat: float | None = None
    # COG URLs for on-demand rendering
    cog_urls: dict | None = None  # {b11, b12, visual} URLs
    bounds: tuple | None = None   # (minx, miny, maxx, maxy) in EPSG:4326
    utm_bounds: tuple | None = None  # (minx, miny, maxx, maxy) in native UTM
    epsg: int | None = None  # UTM zone EPSG code


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
    def detection_rate(self) -> float | None:
        if self.images_searched == 0:
            return None
        return self.images_with_detection / self.images_searched

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
            "detection_rate": self.detection_rate,
            "max_b12": self.max_b12,
            "detection_dates": [
                {
                    "date": d.date.isoformat(),
                    "max_b12": d.max_b12,
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


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Calculate distance between two points in meters."""
    R = 6371000  # Earth radius in meters
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlam = np.radians(lon2 - lon1)
    a = np.sin(dphi/2)**2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlam/2)**2
    return 2 * R * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def cluster_detections(detections: list[Detection], distance_m: float = CLUSTER_DISTANCE_M) -> list[Detection]:
    """Cluster nearby flare detections to reduce visual clutter.

    Detections within distance_m of each other are assigned to the same cluster.
    Each detection's flare location is updated to the cluster centroid.
    """
    if not detections:
        return detections

    # Filter out detections without valid coordinates
    valid = [d for d in detections if d.flare_lon is not None and d.flare_lat is not None]
    invalid = [d for d in detections if d.flare_lon is None or d.flare_lat is None]

    if not valid:
        return detections

    # Simple greedy clustering
    clusters: list[list[Detection]] = []

    for det in valid:
        assigned = False
        for cluster in clusters:
            # Check distance to cluster centroid
            centroid_lon = sum(d.flare_lon for d in cluster) / len(cluster)
            centroid_lat = sum(d.flare_lat for d in cluster) / len(cluster)
            dist = haversine_m(det.flare_lon, det.flare_lat, centroid_lon, centroid_lat)
            if dist <= distance_m:
                cluster.append(det)
                assigned = True
                break

        if not assigned:
            clusters.append([det])

    # Update each detection's flare location to cluster centroid
    result = []
    for cluster in clusters:
        centroid_lon = sum(d.flare_lon for d in cluster) / len(cluster)
        centroid_lat = sum(d.flare_lat for d in cluster) / len(cluster)

        for det in cluster:
            # Create new detection with updated coordinates
            result.append(Detection(
                date=det.date,
                max_b12=det.max_b12,
                pixel_count=det.pixel_count,
                flare_lon=centroid_lon,
                flare_lat=centroid_lat,
                cog_urls=det.cog_urls,
                bounds=det.bounds,
                utm_bounds=det.utm_bounds,
                epsg=det.epsg,
            ))

    return result + invalid


def search_stac(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    max_cloud: int = 30,
    buffer_deg: float = 0.05,
) -> list[dict]:
    """Search Element84 STAC API for Sentinel-2 L2A images."""
    bbox = [lon - buffer_deg, lat - buffer_deg, lon + buffer_deg, lat + buffer_deg]
    payload = {
        "collections": ["sentinel-2-l2a"],
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


def process_image(
    item: dict,
    lat: float,
    lon: float,
    buffer_m: int = 3000,
    b11_threshold: float = B11_THRESHOLD,
    b12_threshold: float = B12_THRESHOLD,
    min_peak_b12: float = MIN_PEAK_B12,
    min_contrast: float = MIN_CONTRAST_RATIO,
    max_local_cloud: float = MAX_LOCAL_CLOUD_FRACTION,
    max_pixels: int = 128,
) -> list[Detection]:
    """Process a single Sentinel-2 image and detect thermal anomalies.

    Detection requires:
    1. Local area mostly cloud-free (SCL band check)
    2. B12 and B11 above absolute thresholds
    3. Peak B12 above minimum intensity (absolute filter for real flares)
    4. B12 significantly brighter than local background (contrast ratio)

    Returns a list of detections (one per distinct flare cluster in the image).
    """
    try:
        b11_url = item["assets"]["swir16"]["href"]
        b12_url = item["assets"]["swir22"]["href"]
        scl_url = item["assets"].get("scl", {}).get("href")
        visual_url = item["assets"].get("visual", {}).get("href")
        epsg = item["properties"]["proj:epsg"]
        img_date = date.fromisoformat(item["properties"]["datetime"][:10])

        # Get scale/offset for reflectance conversion
        b11_band = item["assets"]["swir16"].get("raster:bands", [{}])[0]
        b12_band = item["assets"]["swir22"].get("raster:bands", [{}])[0]
        b11_scale = b11_band.get("scale", 0.0001)
        b11_offset = b11_band.get("offset", -0.1)
        b12_scale = b12_band.get("scale", 0.0001)
        b12_offset = b12_band.get("offset", -0.1)
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
                window = from_bounds(*utm_bounds, src.transform)
                out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
                scl = src.read(1, window=window, out_shape=out_shape)
                cloud_mask = np.isin(scl, [3, 8, 9, 10])
                cloud_fraction = cloud_mask.sum() / cloud_mask.size
                if cloud_fraction > max_local_cloud:
                    return []  # Too cloudy locally

        with rasterio.open(b11_url) as src:
            window = from_bounds(*utm_bounds, src.transform)
            out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
            b11 = src.read(1, window=window, out_shape=out_shape).astype(np.float32) * b11_scale + b11_offset

        with rasterio.open(b12_url) as src:
            window = from_bounds(*utm_bounds, src.transform)
            out_shape = (min(max_pixels, int(window.height)), min(max_pixels, int(window.width)))
            b12 = src.read(1, window=window, out_shape=out_shape).astype(np.float32) * b12_scale + b12_offset

        # Calculate background statistics (exclude potential flare pixels)
        # Use median of non-bright pixels as background reference
        background_mask = b12 < b12_threshold
        if background_mask.sum() < 10:
            # Not enough background pixels to compare
            return []
        background_median = np.median(b12[background_mask])

        # Find pixels that are both above threshold AND stand out from background
        mask = (b12 > b12_threshold) & (b11 > b11_threshold) & (b12 > background_median * min_contrast)

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

            # Get max B12 within this cluster
            cluster_b12 = np.where(cluster_mask, b12, 0)
            cluster_max_b12 = float(cluster_b12.max())

            # Check if this cluster meets the intensity threshold
            if cluster_max_b12 < min_peak_b12:
                continue

            # Find location of max B12 pixel in this cluster
            max_idx = np.unravel_index(cluster_b12.argmax(), cluster_b12.shape)
            row, col = max_idx

            # Convert pixel coords back to UTM
            col_frac = (col + 0.5) / b12.shape[1]
            row_frac = (row + 0.5) / b12.shape[0]
            flare_utm_x = utm_bounds[0] + col_frac * (utm_bounds[2] - utm_bounds[0])
            flare_utm_y = utm_bounds[3] - row_frac * (utm_bounds[3] - utm_bounds[1])

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
    buffer_m: int = 3000,
    workers: int = 8,
    b11_threshold: float = B11_THRESHOLD,
    b12_threshold: float = B12_THRESHOLD,
    min_peak_b12: float = MIN_PEAK_B12,
    min_contrast: float = MIN_CONTRAST_RATIO,
    max_local_cloud: float = MAX_LOCAL_CLOUD_FRACTION,
    progress_callback=None,
) -> DetectionResult:
    """
    Detect thermal anomalies at a location using Sentinel-2 SWIR bands.

    Args:
        lat: Latitude (WGS84)
        lon: Longitude (WGS84)
        start_date: Start of search period
        end_date: End of search period
        max_cloud: Maximum scene cloud cover percentage (default 30)
        buffer_m: Buffer around point in meters (default 3000)
        workers: Parallel workers for image processing (default 8)
        b11_threshold: SWIR1 threshold in reflectance (default 0.3)
        b12_threshold: SWIR2 threshold in reflectance (default 0.5)
        min_peak_b12: Minimum peak B12 for detection (default 0.8)
        min_contrast: Minimum ratio of flare brightness to background (default 3.0)
        max_local_cloud: Maximum local cloud fraction (default 0.3)
        progress_callback: Optional callback(current, total) for progress updates

    Returns:
        DetectionResult with all detections found
    """
    items = search_stac(lat, lon, start_date, end_date, max_cloud)

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
                process_image, item, lat, lon, buffer_m,
                b11_threshold, b12_threshold, min_peak_b12, min_contrast, max_local_cloud
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

    # Cluster nearby flare locations across all images
    detections = cluster_detections(detections)
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
