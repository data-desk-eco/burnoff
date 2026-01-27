"""Sentinel-2 SWIR flare detection using DAFI v2 methodology.

Detects gas flares via thermal signature in L1C TOA reflectance:
1. NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 indicates thermal emission
2. Contrast, peakedness, and point-source filters reduce false positives
3. Cloud masking via L2A SCL band

References: Faruolo et al. 2024 (DAFI v2)
"""

import os
from dataclasses import dataclass
from datetime import date
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from pyproj import Transformer
from scipy import ndimage

# GDAL environment for remote COG/JP2 access
for key, val in {
    "GDAL_HTTP_UNSAFESSL": "YES",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.jp2",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_VERSION": "2",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": "10000000",
}.items():
    os.environ.setdefault(key, val)

STAC_API = "https://earth-search.aws.element84.com/v1"
L1C_BUCKET = "sentinel-s2-l1c"
L1C_REGION = "eu-central-1"

# Detection thresholds (TOA reflectance, 0-1+ scale)
B12_MIN = 0.3                 # Candidate pixel minimum
B11_MIN = 0.2                 # Candidate pixel minimum
PEAK_B12_MIN = 0.50           # Cluster peak minimum
CONTRAST_RATIO = 3.0          # Must be 3x brighter than background
BACKGROUND_FLOOR = 0.15       # Minimum background baseline
PEAKEDNESS_MIN = 1.15         # Peak must be 15% above cluster average
SATURATION = 1.0              # Reflectance > 1 = saturated

# Morphology filters
MAX_CLOUD_LOCAL = 0.3         # Max 30% local cloud cover
MAX_PIXELS = 50               # Max cluster size
LARGE_PIXELS = 30             # Large clusters need higher intensity
LARGE_B12_MIN = 0.70          # Min B12 for large clusters
WARM_FRACTION = 0.5           # Warm region threshold = peak * 0.5
WARM_MAX_PIXELS = 100         # Max warm region size
BUFFER_M = 6000               # Search radius (6km)


@dataclass
class Detection:
    """Single flare detection at max B12 pixel location."""
    date: date
    max_b12: float
    pixel_count: int
    flare_lon: float | None = None
    flare_lat: float | None = None
    cog_urls: dict | None = None
    bounds: tuple | None = None
    utm_bounds: tuple | None = None
    epsg: int | None = None
    avg_b12: float | None = None
    sun_elevation: float | None = None


@dataclass
class DetectionResult:
    """Aggregated results for a location."""
    lat: float
    lon: float
    start_date: date
    end_date: date
    images_searched: int
    images_with_detection: int
    detections: list[Detection]

    @property
    def occurrence_frequency(self) -> float | None:
        if self.images_searched == 0:
            return None
        return (self.images_with_detection / self.images_searched) * 100

    @property
    def max_b12(self) -> float | None:
        return max((d.max_b12 for d in self.detections), default=None)

    def to_dict(self) -> dict:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "images": self.images_searched,
            "detections": self.images_with_detection,
            "occurrence_frequency": self.occurrence_frequency,
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
                    "sun_elevation": d.sun_elevation,
                }
                for d in self.detections
            ],
        }


def _s3_to_http(url: str) -> str:
    """Convert s3://sentinel-s2-l1c/... to HTTPS URL."""
    if url.startswith("s3://"):
        path = url.replace(f"s3://{L1C_BUCKET}/", "")
        return f"https://{L1C_BUCKET}.s3.{L1C_REGION}.amazonaws.com/{path}"
    return url


def _dn_to_reflectance(dn: np.ndarray) -> np.ndarray:
    """Convert L1C DN to TOA reflectance (DN / 10000)."""
    return dn.astype(np.float32) / 10000.0


def _search_stac(lat: float, lon: float, start: date, end: date,
                 max_cloud: int, collection: str) -> list[dict]:
    """Search Element84 STAC for Sentinel-2 images."""
    bbox = [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05]
    payload = {
        "collections": [collection],
        "bbox": bbox,
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
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
            next_link = next((l for l in data.get("links", []) if l.get("rel") == "next"), None)
            if next_link and next_link.get("body"):
                url, payload = next_link["href"], next_link["body"]
            else:
                url = None
    return items


def _search_l1c_l2a(lat: float, lon: float, start: date, end: date,
                    max_cloud: int) -> list[tuple[dict, dict | None]]:
    """Search L1C images with matched L2A for cloud masks, deduplicated by date."""
    with ThreadPoolExecutor(max_workers=2) as ex:
        l1c_f = ex.submit(_search_stac, lat, lon, start, end, max_cloud, "sentinel-2-l1c")
        l2a_f = ex.submit(_search_stac, lat, lon, start, end, max_cloud, "sentinel-2-l2a")
        l1c_items, l2a_items = l1c_f.result(), l2a_f.result()

    # Index L2A by date+tile
    l2a_by_key = {}
    for item in l2a_items:
        dt = item["properties"]["datetime"][:10]
        tile = item["properties"].get("s2:mgrs_tile", "")
        l2a_by_key[f"{dt}_{tile}"] = item

    # Match and deduplicate by date (keep lowest cloud cover)
    by_date = {}
    for l1c in l1c_items:
        dt = l1c["properties"]["datetime"][:10]
        tile = l1c["properties"].get("s2:mgrs_tile", "")
        cloud = l1c["properties"].get("eo:cloud_cover", 100)
        l2a = l2a_by_key.get(f"{dt}_{tile}")

        if dt not in by_date or cloud < by_date[dt][2]:
            by_date[dt] = (l1c, l2a, cloud)

    return [(l1c, l2a) for l1c, l2a, _ in by_date.values()]


def _read_band(url: str, utm_bounds: tuple, transform_back=None) -> tuple[np.ndarray, tuple]:
    """Read band within UTM bounds, return (reflectance, actual_bounds)."""
    with rasterio.open(url) as src:
        clipped = (
            max(utm_bounds[0], src.bounds.left),
            max(utm_bounds[1], src.bounds.bottom),
            min(utm_bounds[2], src.bounds.right),
            min(utm_bounds[3], src.bounds.top),
        )
        window = from_bounds(*clipped, src.transform)
        dn = src.read(1, window=window)
        return _dn_to_reflectance(dn), clipped


def _process_image(l1c: dict, lat: float, lon: float, buffer_m: int = BUFFER_M,
                   l2a: dict | None = None) -> list[Detection]:
    """Process single L1C image using DAFI v2 algorithm."""
    try:
        # Get URLs
        b11_url = _s3_to_http(l1c["assets"]["swir16"]["href"])
        b12_url = _s3_to_http(l1c["assets"]["swir22"]["href"])
        b8a_url = l1c["assets"].get("nir08", {}).get("href")
        if b8a_url:
            b8a_url = _s3_to_http(b8a_url)
        visual_url = l1c["assets"].get("visual", {}).get("href")
        if visual_url:
            visual_url = _s3_to_http(visual_url)

        epsg = l1c["properties"]["proj:epsg"]
        img_date = date.fromisoformat(l1c["properties"]["datetime"][:10])
        sun_elevation = l1c["properties"].get("view:sun_elevation")

        # L2A URLs for cloud mask and visualization
        scl_url = viz_b11 = viz_b12 = viz_visual = None
        if l2a and "scl" in l2a.get("assets", {}):
            scl_url = l2a["assets"]["scl"]["href"]
            viz_b11 = l2a["assets"].get("swir16", {}).get("href")
            viz_b12 = l2a["assets"].get("swir22", {}).get("href")
            viz_visual = l2a["assets"].get("visual", {}).get("href")
    except (KeyError, IndexError):
        return []

    # Coordinate transforms
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    to_wgs = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    x, y = to_utm.transform(lon, lat)
    utm_bounds = (x - buffer_m, y - buffer_m, x + buffer_m, y + buffer_m)
    wgs_bounds = (*to_wgs.transform(utm_bounds[0], utm_bounds[1]),
                  *to_wgs.transform(utm_bounds[2], utm_bounds[3]))

    try:
        # Check local cloud cover
        if scl_url:
            with rasterio.open(scl_url) as src:
                clipped = (
                    max(utm_bounds[0], src.bounds.left),
                    max(utm_bounds[1], src.bounds.bottom),
                    min(utm_bounds[2], src.bounds.right),
                    min(utm_bounds[3], src.bounds.top),
                )
                window = from_bounds(*clipped, src.transform)
                scl = src.read(1, window=window)
                cloud_frac = np.isin(scl, [3, 8, 9, 10]).sum() / scl.size
                if cloud_frac > MAX_CLOUD_LOCAL:
                    return []

        # Read SWIR bands at native 20m resolution
        b11, _ = _read_band(b11_url, utm_bounds)
        b12, actual_bounds = _read_band(b12_url, utm_bounds)

        # Read NIR for thermal signature
        b8a = None
        if b8a_url:
            try:
                b8a, _ = _read_band(b8a_url, utm_bounds)
            except Exception:
                pass

        # === DAFI v2 DETECTION ===

        # 1. Brightness threshold
        bright = (b12 > B12_MIN) & (b11 > B11_MIN)

        # 2. Contrast vs background
        bg_pixels = b12[b12 < B12_MIN]
        if bg_pixels.size < 10:
            return []
        bg_baseline = max(float(np.median(bg_pixels)), BACKGROUND_FLOOR)
        contrast = b12 > (bg_baseline * CONTRAST_RATIO)

        # 3. Thermal signature (NHISWNIR > 0 means SWIR > NIR)
        nhiswnir = np.zeros_like(b11)
        if b8a is not None:
            denom = b11 + b8a
            valid = denom > 0.01
            np.divide(b11 - b8a, denom, out=nhiswnir, where=valid)
            thermal = (nhiswnir > 0) | (b11 > SATURATION) | (b12 > SATURATION)
        else:
            thermal = b11 > SATURATION

        mask = bright & contrast & thermal
        if not mask.any():
            return []

        # Find connected components
        labeled, n_features = ndimage.label(mask)
        cog_urls = {"b11": viz_b11 or b11_url, "b12": viz_b12 or b12_url,
                    "visual": viz_visual or visual_url}

        detections = []
        for label_id in range(1, n_features + 1):
            cluster = labeled == label_id
            n_pixels = int(cluster.sum())

            if n_pixels > MAX_PIXELS:
                continue

            cluster_b12 = np.where(cluster, b12, 0)
            peak_b12 = float(cluster_b12.max())
            avg_b12 = float(b12[cluster].mean())

            if peak_b12 < PEAK_B12_MIN:
                continue

            # Large clusters need higher intensity
            if n_pixels > LARGE_PIXELS and peak_b12 < LARGE_B12_MIN:
                continue

            # Peakedness filter (skip for single pixel)
            if n_pixels > 1 and peak_b12 < PEAKEDNESS_MIN * avg_b12:
                continue

            # Single pixel needs higher confidence
            if n_pixels == 1 and peak_b12 < 0.65:
                continue

            # Point source filter
            row, col = np.unravel_index(cluster_b12.argmax(), cluster_b12.shape)
            warm = b12 > (peak_b12 * WARM_FRACTION)
            warm_labeled, _ = ndimage.label(warm)
            if (warm_labeled == warm_labeled[row, col]).sum() > WARM_MAX_PIXELS:
                continue

            # Convert to lat/lon
            col_frac = (col + 0.5) / b12.shape[1]
            row_frac = (row + 0.5) / b12.shape[0]
            utm_x = actual_bounds[0] + col_frac * (actual_bounds[2] - actual_bounds[0])
            utm_y = actual_bounds[3] - row_frac * (actual_bounds[3] - actual_bounds[1])
            flare_lon, flare_lat = to_wgs.transform(utm_x, utm_y)

            detections.append(Detection(
                date=img_date,
                max_b12=peak_b12,
                pixel_count=n_pixels,
                flare_lon=flare_lon,
                flare_lat=flare_lat,
                cog_urls=cog_urls,
                bounds=wgs_bounds,
                utm_bounds=utm_bounds,
                epsg=int(epsg),
                avg_b12=avg_b12,
                sun_elevation=sun_elevation,
            ))

        return detections
    except Exception:
        return []


# Public alias for CLI
search_stac = _search_stac


def detect(lat: float, lon: float, start_date: date, end_date: date,
           max_cloud: int = 30, buffer_m: int = BUFFER_M, workers: int = 8,
           progress_callback=None) -> DetectionResult:
    """Detect gas flares at a location using DAFI v2 algorithm."""
    pairs = _search_l1c_l2a(lat, lon, start_date, end_date, max_cloud)

    if not pairs:
        return DetectionResult(lat=lat, lon=lon, start_date=start_date,
                               end_date=end_date, images_searched=0,
                               images_with_detection=0, detections=[])

    detections = []
    images_with_detection = 0
    completed = 0

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_process_image, l1c, lat, lon, buffer_m, l2a): l1c
                   for l1c, l2a in pairs}

        for future in as_completed(futures):
            completed += 1
            if progress_callback:
                progress_callback(completed, len(pairs))

            results = future.result()
            if results:
                images_with_detection += 1
                detections.extend(results)

    detections.sort(key=lambda d: d.date)

    return DetectionResult(
        lat=lat, lon=lon, start_date=start_date, end_date=end_date,
        images_searched=len(pairs), images_with_detection=images_with_detection,
        detections=detections,
    )
