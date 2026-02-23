#!/usr/bin/env python3
"""Fetch VNF multiyear profiles for facility-adjacent flares from EOG Nightfire.

Discovers all flare IDs by scraping the EOG profiles directory listing, peeks at
each profile (Range request for first ~512 bytes) to get lat/lon, filters by
proximity to LNG terminals and oil/gas accumulations, then downloads full profiles
for matches.  The multiyear index is optional metadata enrichment only.

Requires EOG_EMAIL and EOG_PASSWORD in .env.

Usage: uv run --with requests,beautifulsoup4,duckdb,lxml scripts/fetch_vnf_profiles.py
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

PROFILES_URL = "https://eogdata.mines.edu/wwwdata/downloads/vnf_profiles/profiles_multiyear"
INDEX_ZIP_URL = "https://eogdata.mines.edu/wwwdata/downloads/VNF_multiyear_2012-2021/multiyear_201204_202405_monthly.zip"

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
PROFILES_DIR = os.path.join(DATA_DIR, "vnf_profiles")
INDEX_DIR = os.path.join(DATA_DIR, "vnf_raw")
INDEX_CSV_NAME = "multiyear_flare_month_summary_all_run48.csv"
TERMINALS_GEOJSON = os.path.join(PROJECT_ROOT, "web", "terminals.geojson")
ACCUMULATIONS_GEOJSON = os.path.join(PROJECT_ROOT, "web", "accumulations.geojson")


# -- .env loader (no python-dotenv dependency) --------------------------------

def load_dotenv():
    """Read key=value pairs from .env file in project root."""
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


# -- Haversine ----------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# -- EOG Authentication -------------------------------------------------------

def authenticate():
    """Authenticate with EOG via OIDC and return session with valid cookies."""
    email = os.environ.get("EOG_EMAIL")
    password = os.environ.get("EOG_PASSWORD")
    if not email or not password:
        print("Error: Set EOG_EMAIL and EOG_PASSWORD in .env", file=sys.stderr)
        sys.exit(1)

    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"

    # Request protected URL — follows redirects to OIDC login page
    resp = session.get(f"{PROFILES_URL}/", allow_redirects=True)

    # Already authenticated (directory listing visible)
    if resp.ok and "site_" in resp.text:
        return session, resp.text

    # Parse the login form
    soup = BeautifulSoup(resp.text, "lxml")
    form = soup.find("form")
    if not form:
        print(f"Warning: No login form found at {resp.url}", file=sys.stderr)
        return session, ""

    action = form.get("action", resp.url)
    if not action.startswith("http"):
        action = urljoin(resp.url, action)

    # Collect all form fields (preserves CSRF tokens etc.)
    data = {}
    for inp in form.find_all("input"):
        name = inp.get("name")
        if name:
            data[name] = inp.get("value", "")

    # Fill credential fields
    for inp in form.find_all("input"):
        input_type = (inp.get("type") or "text").lower()
        input_name = (inp.get("name") or "").lower()
        if input_type in ("text", "email") or input_name in (
            "username", "email", "login", "j_username",
        ):
            data[inp["name"]] = email
        elif input_type == "password" or input_name in ("password", "credential"):
            data[inp["name"]] = password

    resp = session.post(action, data=data, allow_redirects=True)

    # Handle potential second step (consent page)
    if resp.ok and "<form" in resp.text.lower():
        soup2 = BeautifulSoup(resp.text, "lxml")
        form2 = soup2.find("form")
        if form2 and form2.get("action"):
            action2 = form2["action"]
            if not action2.startswith("http"):
                action2 = urljoin(resp.url, action2)
            data2 = {}
            for inp in form2.find_all("input"):
                name = inp.get("name")
                if name:
                    data2[name] = inp.get("value", "")
            session.post(action2, data=data2, allow_redirects=True)

    return session, ""


def verify_auth(session):
    """Verify authentication by requesting the profiles directory."""
    resp = session.get(f"{PROFILES_URL}/", allow_redirects=False)
    if resp.status_code in (301, 302):
        print("Authentication failed — still being redirected to login.", file=sys.stderr)
        print("Check EOG_EMAIL and EOG_PASSWORD in .env", file=sys.stderr)
        sys.exit(1)
    if not resp.ok:
        print(f"Warning: Profiles directory returned HTTP {resp.status_code}", file=sys.stderr)
    return resp.text


# -- Directory scraping -------------------------------------------------------

def scrape_flare_ids(html):
    """Parse directory listing HTML and return set of all flare IDs."""
    # Match links like site_12345_multiyear_vnf_series.csv
    pattern = re.compile(r"site_(\d+)_multiyear_vnf_series\.csv")
    ids = set()
    for m in pattern.finditer(html):
        ids.add(int(m.group(1)))
    return ids


# -- Location discovery -------------------------------------------------------

def load_known_locations(index_csv_path):
    """Load flare_id -> (lat, lon) from the index CSV if present."""
    locs = {}
    if not os.path.exists(index_csv_path):
        return locs
    import duckdb
    con = duckdb.connect()
    rows = con.execute(f"""
        SELECT CAST(id AS INTEGER) AS fid,
               AVG(CAST(lat AS DOUBLE)) AS lat,
               AVG(CAST(lon AS DOUBLE)) AS lon
        FROM read_csv('{index_csv_path}', auto_detect=true)
        GROUP BY CAST(id AS INTEGER)
    """).fetchall()
    con.close()
    for fid, lat, lon in rows:
        locs[fid] = (lat, lon)
    return locs


def load_profile_locations(profiles_dir):
    """Load flare_id -> (lat, lon) from existing profile CSVs (first data row)."""
    locs = {}
    if not os.path.isdir(profiles_dir):
        return locs
    for fname in os.listdir(profiles_dir):
        m = re.match(r"site_(\d+)\.csv", fname)
        if not m:
            continue
        fid = int(m.group(1))
        try:
            with open(os.path.join(profiles_dir, fname)) as f:
                reader = csv.reader(f)
                header = next(reader)
                lat_idx = header.index("Lat_GMTCO")
                lon_idx = header.index("Lon_GMTCO")
                row = next(reader)
                lat = float(row[lat_idx])
                lon = float(row[lon_idx])
                if -90 <= lat <= 90 and -180 <= lon <= 180:
                    locs[fid] = (lat, lon)
        except (StopIteration, ValueError, IndexError, OSError):
            continue
    return locs


def peek_profile_location(session, flare_id):
    """Range-request the first ~512 bytes of a profile to extract lat/lon."""
    url = f"{PROFILES_URL}/site_{flare_id}_multiyear_vnf_series.csv"
    try:
        resp = session.get(url, headers={"Range": "bytes=0-511"}, timeout=30)
        # Accept both 206 (partial) and 200 (server ignores Range)
        if resp.status_code not in (200, 206):
            return None
        text = resp.text
        lines = text.split("\n")
        if len(lines) < 2:
            return None
        header = lines[0].split(",")
        data = lines[1].split(",")
        lat_idx = header.index("Lat_GMTCO")
        lon_idx = header.index("Lon_GMTCO")
        lat = float(data[lat_idx])
        lon = float(data[lon_idx])
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            return (lat, lon)
    except (requests.RequestException, ValueError, IndexError):
        pass
    return None


def peek_batch(session, flare_ids, known_locs):
    """Peek at profiles in parallel to discover lat/lon for unknown flares."""
    unknown = [fid for fid in flare_ids if fid not in known_locs]
    if not unknown:
        return known_locs

    print(f"  Peeking at {len(unknown)} profiles for lat/lon...")
    locs = dict(known_locs)
    done = 0
    found = 0

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(peek_profile_location, session, fid): fid for fid in unknown}
        for future in as_completed(futures):
            fid = futures[future]
            result = future.result()
            done += 1
            if result:
                locs[fid] = result
                found += 1
            if done % 100 == 0 or done == len(unknown):
                sys.stdout.write(f"\r  {done}/{len(unknown)} peeked ({found} located)")
                sys.stdout.flush()

    print()
    return locs


# -- Facility loading ---------------------------------------------------------

def load_terminal_coords():
    """Load terminal (lat, lon) from terminals.geojson."""
    if not os.path.exists(TERMINALS_GEOJSON):
        print(f"Warning: {TERMINALS_GEOJSON} not found", file=sys.stderr)
        return []
    with open(TERMINALS_GEOJSON) as f:
        data = json.load(f)
    return [(feat["geometry"]["coordinates"][1],
             feat["geometry"]["coordinates"][0])
            for feat in data["features"]]


def load_accumulation_coords():
    """Load accumulation centroids from accumulations.geojson."""
    if not os.path.exists(ACCUMULATIONS_GEOJSON):
        print(f"Warning: {ACCUMULATIONS_GEOJSON} not found", file=sys.stderr)
        return []
    with open(ACCUMULATIONS_GEOJSON) as f:
        data = json.load(f)
    coords = []
    for feat in data["features"]:
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            ring = geom["coordinates"][0]
        elif geom["type"] == "MultiPolygon":
            ring = geom["coordinates"][0][0]
        else:
            continue
        clat = sum(c[1] for c in ring) / len(ring)
        clon = sum(c[0] for c in ring) / len(ring)
        coords.append((clat, clon))
    return coords


# -- Facility filtering -------------------------------------------------------

def filter_facility_adjacent(locs, term_coords, accum_coords, r_term, r_accum):
    """Return set of flare IDs within r_term km of a terminal or r_accum km of an accumulation."""
    adjacent = set()
    for fid, (flat, flon) in locs.items():
        for tlat, tlon in term_coords:
            if haversine_km(flat, flon, tlat, tlon) <= r_term:
                adjacent.add(fid)
                break
        if fid in adjacent:
            continue
        for alat, alon in accum_coords:
            if haversine_km(flat, flon, alat, alon) <= r_accum:
                adjacent.add(fid)
                break
    return adjacent


# -- Profile download ---------------------------------------------------------

def download_profile(session, flare_id):
    """Download a single VNF profile CSV. Returns (flare_id, success)."""
    url = f"{PROFILES_URL}/site_{flare_id}_multiyear_vnf_series.csv"
    try:
        resp = session.get(url, timeout=120)
        if resp.ok and "Date_Mscan" in resp.text[:500]:
            path = os.path.join(PROFILES_DIR, f"site_{flare_id}.csv")
            with open(path, "w") as f:
                f.write(resp.text)
            return flare_id, True
    except requests.RequestException as e:
        print(f"\n  Warning: flare {flare_id}: {e}", file=sys.stderr)
    return flare_id, False


# -- Index download -----------------------------------------------------------

def fetch_index(session):
    """Download and extract the multiyear flare index ZIP."""
    os.makedirs(INDEX_DIR, exist_ok=True)
    index_csv = os.path.join(INDEX_DIR, INDEX_CSV_NAME)
    if os.path.exists(index_csv):
        print(f"  Index already present: {index_csv}")
        return
    print("  Downloading multiyear flare index...")
    resp = session.get(INDEX_ZIP_URL, timeout=120)
    if not resp.ok:
        print(f"  Failed to download index: HTTP {resp.status_code}", file=sys.stderr)
        return
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        zf.extractall(INDEX_DIR)
    print(f"  Extracted to {INDEX_DIR}")


# -- Main ---------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Fetch VNF profiles for facility-adjacent flares"
    )
    parser.add_argument(
        "--max-age", type=int, default=0, metavar="DAYS",
        help="Skip profiles updated within DAYS days (0 = re-download all)",
    )
    parser.add_argument(
        "--fetch-index", action="store_true",
        help="Also download the multiyear index ZIP for metadata enrichment",
    )
    parser.add_argument(
        "--radius-terminal", type=float, default=6,
        help="Radius in km for terminal matching (default: 6)",
    )
    parser.add_argument(
        "--radius-accum", type=float, default=10,
        help="Radius in km for accumulation matching (default: 10)",
    )
    args = parser.parse_args()

    load_dotenv()
    os.makedirs(PROFILES_DIR, exist_ok=True)

    # 1. Authenticate
    print("Authenticating with EOG...")
    session, listing_html = authenticate()
    if not listing_html or "site_" not in listing_html:
        listing_html = verify_auth(session)
    print("  Authenticated")

    # 2. Optionally fetch index
    if args.fetch_index:
        fetch_index(session)

    # 3. Scrape directory listing for all flare IDs
    if "site_" not in listing_html:
        resp = session.get(f"{PROFILES_URL}/", timeout=60)
        listing_html = resp.text
    all_ids = scrape_flare_ids(listing_html)
    print(f"  {len(all_ids)} flares in directory listing")

    # 4. Build known locations from index + existing profiles
    index_csv = os.path.join(INDEX_DIR, INDEX_CSV_NAME)
    known_locs = load_known_locations(index_csv)
    if known_locs:
        print(f"  {len(known_locs)} locations from index")
    profile_locs = load_profile_locations(PROFILES_DIR)
    if profile_locs:
        print(f"  {len(profile_locs)} locations from existing profiles")
    # Merge: profile locations override index
    for fid, loc in profile_locs.items():
        known_locs[fid] = loc

    # 5. Peek at unknown flares via Range requests
    known_locs = peek_batch(session, all_ids, known_locs)
    located = sum(1 for fid in all_ids if fid in known_locs)
    print(f"  {located}/{len(all_ids)} flares with known locations")

    # 6. Load facility coordinates
    term_coords = load_terminal_coords()
    accum_coords = load_accumulation_coords()
    print(f"  {len(term_coords)} terminals, {len(accum_coords)} accumulations")

    if not term_coords and not accum_coords:
        print("Error: No facility coordinates available", file=sys.stderr)
        sys.exit(1)

    # 7. Filter by proximity
    adjacent = filter_facility_adjacent(
        {fid: known_locs[fid] for fid in all_ids if fid in known_locs},
        term_coords, accum_coords,
        args.radius_terminal, args.radius_accum,
    )
    print(f"  {len(adjacent)} flares near facilities")

    # 8. Skip fresh profiles if --max-age
    to_download = sorted(adjacent)
    if args.max_age > 0:
        cutoff = time.time() - args.max_age * 86400
        fresh = set()
        for fid in to_download:
            path = os.path.join(PROFILES_DIR, f"site_{fid}.csv")
            if os.path.exists(path) and os.path.getmtime(path) > cutoff:
                fresh.add(fid)
        skipped = len(fresh)
        to_download = [fid for fid in to_download if fid not in fresh]
        print(f"  {skipped} profiles fresh (< {args.max_age} days), {len(to_download)} to download")

    if not to_download:
        print("All profiles up to date.")
        return

    # 9. Download
    print(f"Downloading {len(to_download)} profiles...")
    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(download_profile, session, fid): fid for fid in to_download}
        for future in as_completed(futures):
            _, success = future.result()
            if success:
                ok += 1
            else:
                fail += 1
            sys.stdout.write(f"\r  {ok + fail}/{len(to_download)} ({fail} failed)")
            sys.stdout.flush()

    print(f"\nDone. {ok} downloaded, {fail} failed.")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
