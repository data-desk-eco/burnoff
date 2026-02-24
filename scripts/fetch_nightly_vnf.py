#!/usr/bin/env python3
"""Download nightly VNF data for a bounding box and build a raw-detection parquet.

Each row in the output is a single satellite detection at its actual
lat/lon, with a unique synthetic flare_id.  This lets the map show
every individual detection point, revealing unprofiled flare locations.

Usage: uv run --with requests,beautifulsoup4,lxml,duckdb scripts/fetch_nightly_vnf.py
"""

import csv
import gzip
import io
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))

# -- Configuration --

BBOX = {
    "lat_min": 32.13,
    "lat_max": 32.19,
    "lon_min": -103.87,
    "lon_max": -103.80,
}

START_DATE = date(2023, 1, 1)
SATELLITES = ["npp", "j01", "j02"]
BASE_URL = "https://eogdata.mines.edu/wwwdata/viirs_products/vnf/v30/rearrange"
OUTPUT = os.path.join(PROJECT_ROOT, "web", "vnf_nightly.parquet")
WORKERS = 20


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


def authenticate():
    from fetch_vnf_profiles import authenticate as eog_auth, verify_auth
    session, html = eog_auth()
    if not html or "site_" not in html:
        verify_auth(session)
    return session


def download_and_filter(session, sat, d, bbox):
    """Download a single nightly ez CSV and return rows in the bounding box."""
    url = (f"{BASE_URL}/{d.year}/{d.month:02d}/{sat}/"
           f"VNF_{sat}_d{d.strftime('%Y%m%d')}_noaa_v30-ez.csv.gz")
    try:
        resp = session.get(url, timeout=60)
        if resp.status_code == 404:
            return []
        if not resp.ok:
            return []
        data = gzip.decompress(resp.content)
        text = data.decode("utf-8", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        rows = []
        for row in reader:
            try:
                lat = float(row["Lat_GMTCO"])
                lon = float(row["Lon_GMTCO"])
            except (ValueError, KeyError):
                continue
            if (bbox["lat_min"] <= lat <= bbox["lat_max"] and
                    bbox["lon_min"] <= lon <= bbox["lon_max"]):
                rows.append(row)
        return rows
    except Exception:
        return []


def main():
    load_dotenv()

    print("Authenticating with EOG...")
    session = authenticate()
    print("  Authenticated")

    today = date.today()
    num_days = (today - START_DATE).days + 1

    # Build all (satellite, date) jobs
    jobs = []
    d = START_DATE
    while d <= today:
        for sat in SATELLITES:
            jobs.append((sat, d))
        d += timedelta(days=1)

    print(f"Fetching {len(jobs)} files ({START_DATE} to {today}, {len(SATELLITES)} satellites)...")
    print(f"  {WORKERS} parallel workers")

    all_rows = []
    done = 0
    hits = 0
    errors = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(download_and_filter, session, sat, d, BBOX): (sat, d)
            for sat, d in jobs
        }
        for future in as_completed(futures):
            rows = future.result()
            done += 1
            if rows:
                all_rows.extend(rows)
                hits += len(rows)

            if done % 100 == 0 or done == len(jobs):
                elapsed = time.time() - t0
                rate = done / elapsed if elapsed > 0 else 0
                eta = (len(jobs) - done) / rate if rate > 0 else 0
                sys.stdout.write(
                    f"\r  {done}/{len(jobs)} files "
                    f"({hits} rows found, {rate:.0f} files/s, "
                    f"ETA {eta:.0f}s)  "
                )
                sys.stdout.flush()

    elapsed = time.time() - t0
    print(f"\n  Done in {elapsed:.0f}s. {len(all_rows)} total rows in bbox.")

    if not all_rows:
        print("No data found in bounding box.")
        return

    # Build raw detection parquet
    import duckdb
    db = duckdb.connect()

    db.execute("""CREATE TABLE nightly (
        flare_id INT, lat DOUBLE, lon DOUBLE, date DATE,
        clear BOOLEAN, detected BOOLEAN, rh_mw DOUBLE, temp_k DOUBLE,
        n_passes INT, type VARCHAR, category VARCHAR, country VARCHAR,
        facility_type VARCHAR, facility_name VARCHAR
    )""")

    synthetic_id = 90001
    det_count = 0

    for row in sorted(all_rows, key=lambda r: r.get("Date_Mscan", "")):
        lat = float(row["Lat_GMTCO"])
        lon = float(row["Lon_GMTCO"])
        date_str = row.get("Date_Mscan", "")[:10].replace("/", "-")
        temp_bb = float(row.get("Temp_BB", 999999))
        rh = float(row.get("RH", 999999))

        detected = temp_bb != 999999
        rh_val = rh if detected and rh != 999999 else 0
        temp_val = temp_bb if detected else 0
        if detected:
            det_count += 1

        db.execute(
            "INSERT INTO nightly VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [synthetic_id, lat, lon, date_str, True, detected,
             rh_val, temp_val, 1, "", "", "US", "", ""]
        )
        synthetic_id += 1

    print(f"  {det_count} confirmed detections, {len(all_rows) - det_count} triggers without fit")

    db.execute(f"""
        COPY nightly TO '{os.path.abspath(OUTPUT)}'
        (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    size_kb = os.path.getsize(os.path.abspath(OUTPUT)) / 1024
    print(f"Wrote {len(all_rows)} rows to {OUTPUT} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
