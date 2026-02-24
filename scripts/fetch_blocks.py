#!/usr/bin/env python3
"""Fetch oil/gas blocks and concessions from MapStand WMS (global).

Tiles the world, fetches KML via GetMap (all features per tile in one
request), converts to GeoJSON.  Requires MAPSTAND_APIKEY in .env.

Usage: uv run scripts/fetch_blocks.py
"""

import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "web")

WMS_BASE = "https://app.mapstand.com/geoserver/ows/mps"
HEADERS = {"Referer": "https://app.mapstand.com/"}

# Layers to download with their bounding boxes (from GetCapabilities)
LAYERS = {
    "mps:mps_mapping_block": {
        "output": "blocks.geojson",
        "bbox": (-33, -87, 64, 36),  # S, W, N, E
    },
    "mps:mps_mapping_licenceheader": {
        "output": "concessions.geojson",
        "bbox": (-54, -102, 80, 179),
    },
}

TILE_DEG = 10  # degrees per tile
WORKERS = 8


# -- .env loader -------------------------------------------------------------

def load_dotenv():
    env_path = os.path.join(PROJECT_ROOT, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


# -- KML parsing -------------------------------------------------------------

def parse_props(desc_html):
    """Extract key/value pairs from KML description HTML."""
    props = {}
    for m in re.finditer(
        r'class="atr-name">(.*?)</span>.*?class="atr-value">(.*?)</span>',
        desc_html, re.DOTALL,
    ):
        props[m.group(1).strip()] = m.group(2).strip()
    return props


def parse_coords(text):
    """Parse KML coordinate string to [[lon, lat], ...] ring."""
    ring = []
    for triplet in text.strip().split():
        parts = triplet.split(",")
        ring.append([float(parts[0]), float(parts[1])])
    return ring


def parse_geometry(placemark):
    """Extract GeoJSON geometry from a KML Placemark."""
    mg = placemark.find(".//kml:MultiGeometry", KML_NS)
    if mg is not None:
        polys = []
        for poly in mg.findall("kml:Polygon", KML_NS):
            outer = poly.find(
                ".//kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS
            )
            if outer is not None:
                polys.append([parse_coords(outer.text)])
        if len(polys) == 1:
            return {"type": "Polygon", "coordinates": polys[0]}
        return {"type": "MultiPolygon", "coordinates": polys}
    poly = placemark.find(".//kml:Polygon", KML_NS)
    if poly is not None:
        outer = poly.find(
            ".//kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS
        )
        if outer is not None:
            return {"type": "Polygon", "coordinates": [parse_coords(outer.text)]}
    return None


# -- Tile fetching -----------------------------------------------------------

def fetch_tile(apikey, cookie, layer, lon_min, lat_min, lon_max, lat_max):
    """Fetch a single tile as KML and return parsed features."""
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.1.1",
        "REQUEST": "GetMap",
        "FORMAT": "application/vnd.google-earth.kml+xml",
        "LAYERS": layer,
        "SRS": "EPSG:4326",
        "BBOX": f"{lon_min},{lat_min},{lon_max},{lat_max}",
        "WIDTH": "256",
        "HEIGHT": "256",
        "apikey": apikey,
    }
    url = WMS_BASE + "?" + urlencode(params)
    headers = {**HEADERS}
    if cookie:
        headers["Cookie"] = cookie
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=60) as resp:
            kml = ET.parse(resp)
    except (URLError, HTTPError, ET.ParseError) as e:
        return [], str(e)

    features = []
    for pm in kml.findall(".//kml:Placemark", KML_NS):
        fid = pm.get("id", "")
        desc = pm.find("kml:description", KML_NS)
        props = parse_props(desc.text) if desc is not None and desc.text else {}
        geom = parse_geometry(pm)
        if geom:
            features.append({
                "type": "Feature",
                "id": fid,
                "geometry": geom,
                "properties": props,
            })
    return features, None


def generate_tiles(lat_min, lon_min, lat_max, lon_max, step):
    """Generate (lon_min, lat_min, lon_max, lat_max) tiles."""
    lat = lat_min
    while lat < lat_max:
        lon = lon_min
        while lon < lon_max:
            yield (lon, lat, min(lon + step, lon_max), min(lat + step, lat_max))
            lon += step
        lat += step


# -- Main --------------------------------------------------------------------

def download_layer(apikey, cookie, layer, cfg):
    """Download all features for a layer and return deduplicated GeoJSON."""
    lat_min, lon_min, lat_max, lon_max = cfg["bbox"]
    tiles = list(generate_tiles(lat_min, lon_min, lat_max, lon_max, TILE_DEG))
    print(f"  {len(tiles)} tiles to scan")

    all_features = {}
    errors = 0
    done = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {}
        for tile in tiles:
            f = pool.submit(fetch_tile, apikey, cookie, layer, *tile)
            futures[f] = tile

        for future in as_completed(futures):
            done += 1
            features, err = future.result()
            if err:
                errors += 1
            for feat in features:
                fid = feat["id"]
                if fid not in all_features:
                    all_features[fid] = feat
            if done % 20 == 0 or done == len(tiles):
                sys.stdout.write(
                    f"\r  {done}/{len(tiles)} tiles, "
                    f"{len(all_features)} unique features"
                )
                sys.stdout.flush()

    print()
    if errors:
        print(f"  {errors} tile errors")
    return list(all_features.values())


def simplify_block_props(props):
    """Clean block properties."""
    return {
        "name": props.get("block_name", ""),
        "status": props.get("block_status", ""),
        "country": props.get("admin_area_name", ""),
        "area_sqkm": props.get("mps_est_area_sqkm", ""),
        "shore_status": props.get("mps_est_shore_status", ""),
        "source": props.get("mps_datasource_tags", ""),
    }


def simplify_licence_props(props):
    """Clean licence/concession properties."""
    return {
        "name": props.get("name", ""),
        "status": props.get("lc_status", ""),
        "type": props.get("lc_type", ""),
        "country": props.get("admin_area_name", ""),
        "area_sqkm": props.get("mps_est_area_sqkm", ""),
        "shore_status": props.get("mps_est_shore_status", ""),
        "operator": props.get("adm_co_name", ""),
        "source": props.get("mps_datasource_tags", ""),
    }


def main():
    load_dotenv()
    apikey = os.environ.get("MAPSTAND_APIKEY")
    cookie = f"djam_stk={apikey}" if apikey else ""
    # Also try session cookie from env
    session_id = os.environ.get("MAPSTAND_SESSION")
    if session_id:
        cookie += f"; sessionid={session_id}"

    if not apikey:
        print("error: MAPSTAND_APIKEY not set (check .env)", file=sys.stderr)
        sys.exit(1)

    simplifiers = {
        "mps:mps_mapping_block": simplify_block_props,
        "mps:mps_mapping_licenceheader": simplify_licence_props,
    }

    for layer, cfg in LAYERS.items():
        print(f"\n{layer} → {cfg['output']}")
        features = download_layer(apikey, cookie, layer, cfg)

        simplify = simplifiers.get(layer)
        if simplify:
            for feat in features:
                feat["properties"] = simplify(feat["properties"])

        geojson = {"type": "FeatureCollection", "features": features}
        out_path = os.path.join(OUTPUT_DIR, cfg["output"])
        with open(out_path, "w") as f:
            json.dump(geojson, f)
        size_kb = os.path.getsize(out_path) / 1024
        print(f"  wrote {len(features)} features → {out_path} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
