#!/usr/bin/env python3
"""Fetch VNF multiyear profiles from EOG Nightfire.

By default downloads ALL profiles.  Use --near-facilities to filter by
proximity to LNG terminals and oil/gas accumulations (the old behavior).

Credentials load from env → .env → gcloud Secret Manager (eog-env).

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

# -- Credentials --------------------------------------------------------------

def load_env(keys, secret="eog-env", project="data-desk-web"):
    """Load keys from env -> .env -> gcloud secret. Exits if any are missing."""
    env = {k: os.environ[k] for k in keys if k in os.environ}
    def absorb(text):
        for line in text.splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.removeprefix("export ").strip(), v.strip().strip("\"'"))
    if os.path.exists(".env"):
        absorb(open(".env").read())
    if any(k not in env for k in keys):
        import subprocess
        try:
            absorb(subprocess.check_output(
                ["gcloud", "secrets", "versions", "access", "latest",
                 "--secret", secret, "--project", project],
                text=True, stderr=subprocess.DEVNULL))
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass
    missing = [k for k in keys if k not in env]
    if missing:
        sys.exit(f"missing credentials: {', '.join(missing)}")
    return env


# -- EOG Authentication -------------------------------------------------------

def authenticate():
    """Authenticate with EOG via OIDC and return session with valid cookies."""
    env = load_env(["EOG_EMAIL", "EOG_PASSWORD"], secret="eog-env")
    email = env["EOG_EMAIL"]
    password = env["EOG_PASSWORD"]

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
    """Confirm auth by range-probing one profile — the directory listing has
    20k+ entries and is pathologically slow to fetch, so never touch it."""
    probe = next(iter(load_profile_ids()), 1)
    url = f"{PROFILES_URL}/site_{probe}_multiyear_vnf_series.csv"
    resp = session.get(url, headers={"Range": "bytes=0-511"},
                       allow_redirects=False, timeout=30)
    if resp.status_code in (301, 302) or "Date_Mscan" not in resp.text[:600]:
        sys.exit("Authentication failed — check EOG_EMAIL / EOG_PASSWORD")


# -- Flare-ID resolution ------------------------------------------------------

def load_profile_ids():
    """All flare IDs with an existing on-disk profile."""
    if not os.path.isdir(PROFILES_DIR):
        return set()
    return {int(m.group(1)) for f in os.listdir(PROFILES_DIR)
            if (m := re.match(r"site_(\d+)\.csv$", f))}


def load_index_ids():
    """All flare IDs catalogued in the multiyear index CSV."""
    index_csv = os.path.join(INDEX_DIR, INDEX_CSV_NAME)
    if not os.path.exists(index_csv):
        return set()
    import duckdb
    rows = duckdb.connect().execute(
        f"SELECT DISTINCT CAST(id AS INTEGER) FROM "
        f"read_csv('{index_csv}', auto_detect=true, ignore_errors=true)").fetchall()
    return {r[0] for r in rows}


# -- Haversine ----------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


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


# -- Facility loading & filtering ---------------------------------------------

def load_terminal_coords():
    if not os.path.exists(TERMINALS_GEOJSON):
        return []
    with open(TERMINALS_GEOJSON) as f:
        data = json.load(f)
    return [(feat["geometry"]["coordinates"][1],
             feat["geometry"]["coordinates"][0])
            for feat in data["features"]]


def load_accumulation_coords():
    if not os.path.exists(ACCUMULATIONS_GEOJSON):
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


def filter_facility_adjacent(locs, term_coords, accum_coords, r_term, r_accum):
    """Return set of flare IDs within radius of a terminal or accumulation."""
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

def download_profile(session, flare_id, retries=5):
    """Download one VNF profile CSV, retrying on EOG connection resets / throttling.
    Writes atomically (tmp + rename) so a kill can't leave a torn file."""
    url = f"{PROFILES_URL}/site_{flare_id}_multiyear_vnf_series.csv"
    for attempt in range(retries):
        try:
            resp = session.get(url, timeout=120)
            if resp.ok and "Date_Mscan" in resp.text[:500]:
                tmp = os.path.join(PROFILES_DIR, f".site_{flare_id}.tmp")
                with open(tmp, "w") as f:
                    f.write(resp.text)
                os.replace(tmp, os.path.join(PROFILES_DIR, f"site_{flare_id}.csv"))
                return flare_id, True
        except requests.RequestException:
            pass
        time.sleep(2 * (attempt + 1))
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
        description="Fetch VNF profiles from EOG Nightfire (all by default)"
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
        "--near-facilities", action="store_true",
        help="Only download profiles near LNG terminals / accumulations",
    )
    parser.add_argument(
        "--radius-terminal", type=float, default=6,
        help="Radius in km for terminal matching (default: 6, requires --near-facilities)",
    )
    parser.add_argument(
        "--radius-accum", type=float, default=10,
        help="Radius in km for accumulation matching (default: 10, requires --near-facilities)",
    )
    parser.add_argument(
        "--limit", type=int, default=0, metavar="N",
        help="Only download the first N profiles (0 = all; for testing)",
    )
    args = parser.parse_args()

    os.makedirs(PROFILES_DIR, exist_ok=True)

    # 1. Authenticate
    print("Authenticating with EOG...")
    session, _ = authenticate()
    verify_auth(session)
    print("  Authenticated")

    # 2. Optionally fetch index
    if args.fetch_index:
        fetch_index(session)

    # 3. Resolve flare IDs from the index CSV + existing profiles (both instant;
    #    the on-server directory listing is 20k+ entries and far too slow to scrape)
    all_ids = load_index_ids() | load_profile_ids()
    print(f"  {len(all_ids)} flares (index + on-disk)")

    # 4. Optionally filter to facility-adjacent flares
    if args.near_facilities:
        index_csv = os.path.join(INDEX_DIR, INDEX_CSV_NAME)
        known_locs = load_known_locations(index_csv)
        if known_locs:
            print(f"  {len(known_locs)} locations from index")
        profile_locs = load_profile_locations(PROFILES_DIR)
        if profile_locs:
            print(f"  {len(profile_locs)} locations from existing profiles")
        for fid, loc in profile_locs.items():
            known_locs[fid] = loc
        known_locs = peek_batch(session, all_ids, known_locs)

        term_coords = load_terminal_coords()
        accum_coords = load_accumulation_coords()
        print(f"  {len(term_coords)} terminals, {len(accum_coords)} accumulations")
        if not term_coords and not accum_coords:
            print("Error: No facility coordinates available", file=sys.stderr)
            sys.exit(1)
        adjacent = filter_facility_adjacent(
            {fid: known_locs[fid] for fid in all_ids if fid in known_locs},
            term_coords, accum_coords,
            args.radius_terminal, args.radius_accum,
        )
        print(f"  {len(adjacent)} flares near facilities")
        all_ids = adjacent

    # 5. Skip fresh profiles if --max-age
    to_download = sorted(all_ids)
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

    if args.limit:
        to_download = to_download[:args.limit]

    if not to_download:
        print("All profiles up to date.")
        return

    # 6. Download (EOG resets connections under load, so keep concurrency modest;
    #    download_profile retries with backoff to ride out the resets)
    print(f"Downloading {len(to_download)} profiles...")
    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
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
