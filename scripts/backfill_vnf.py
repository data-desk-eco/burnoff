#!/usr/bin/env python3
"""Daily VNF backfill: fetch recent nightly detections and append to the parquet.

Downloads nightly ez-format CSVs from EOG for dates after the last date in the
existing parquet, matches each detection to the nearest known flare by proximity,
and appends new daily rows.  When profiles are rebuilt (`make vnf`), the full
profile-based parquet replaces everything, including these backfill rows.

EOG credentials load from env → .env → gcloud Secret Manager (eog-env).

Downloads the current (public) parquet from the s2-flares archive first so rows
append to the live file, then writes web/vnf.parquet. Uploading is a separate
step — `make vnf-upload` (or `make vnf-backfill-deploy` to chain both). Set
BACKFILL_SKIP_DOWNLOAD=1 to backfill a purely local web/vnf.parquet instead.

Usage: uv run --with requests,beautifulsoup4,lxml,duckdb scripts/backfill_vnf.py
"""

import csv
import gzip
import io
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))

OUTPUT = os.path.join(PROJECT_ROOT, "web", "vnf.parquet")
BASE_URL = "https://eogdata.mines.edu/wwwdata/viirs_products/vnf/v30/rearrange"
SATELLITES = ["npp", "j01", "j02"]
WORKERS = 20
MATCH_RADIUS_KM = 5  # max distance to assign a detection to a known flare


def authenticate():
    from fetch_vnf_profiles import authenticate as eog_auth, verify_auth
    session, html = eog_auth()
    if not html or "site_" not in html:
        verify_auth(session)
    return session


# VNF parquet lives in the shared s2-flares CloudFerro archive at a stable, public
# key — download is anonymous; upload goes through scripts/upload_vnf.sh (auth + creds).
ARCHIVE_URL = "https://s3.WAW3-2.cloudferro.com/datadesk-archive/vnf/data.parquet"


def download_archive(dest):
    """Download the current (public) parquet from the archive. True on success."""
    import requests as req
    try:
        resp = req.get(ARCHIVE_URL, timeout=120)
        if resp.ok:
            with open(dest, "wb") as f:
                f.write(resp.content)
            print(f"  Downloaded {len(resp.content) / 1e6:.1f} MB from the archive")
            return True
        print(f"  Archive download failed: HTTP {resp.status_code}")
    except Exception as e:
        print(f"  Archive download error: {e}")
    return False




def haversine_km(lat1, lon1, lat2, lon2):
    import math
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def load_flare_positions(db):
    """Load known flare positions from existing parquet. Returns dict {flare_id: (lat, lon)}."""
    if not os.path.exists(OUTPUT):
        return {}
    rows = db.execute(f"""
        SELECT flare_id, FIRST(lat) AS lat, FIRST(lon) AS lon
        FROM '{OUTPUT}'
        GROUP BY flare_id
    """).fetchall()
    return {int(r[0]): (float(r[1]), float(r[2])) for r in rows}


def load_max_date(db):
    """Get the latest date in the existing parquet."""
    if not os.path.exists(OUTPUT):
        return None
    row = db.execute(f"SELECT MAX(date) FROM '{OUTPUT}'").fetchone()
    d = row[0] if row else None
    if d and not isinstance(d, date):
        from datetime import datetime
        d = datetime.strptime(str(d)[:10], "%Y-%m-%d").date()
    return d


def build_spatial_index(flare_positions):
    """Build a grid index for fast nearest-flare lookups."""
    from collections import defaultdict
    grid = defaultdict(list)
    for fid, (lat, lon) in flare_positions.items():
        key = (int(lat), int(lon))
        grid[key].append((fid, lat, lon))
    return grid


def find_nearest_flare(lat, lon, grid, radius_km):
    """Find the nearest known flare within radius. Returns flare_id or None."""
    import math
    clat, clon = int(lat), int(lon)
    best_dist = radius_km + 1
    best_fid = None
    search_deg = max(1, math.ceil(radius_km / 111))
    for dlat in range(-search_deg, search_deg + 1):
        for dlon in range(-search_deg, search_deg + 1):
            for fid, flat, flon in grid.get((clat + dlat, clon + dlon), []):
                d = haversine_km(lat, lon, flat, flon)
                if d < best_dist:
                    best_dist = d
                    best_fid = fid
    return best_fid if best_dist <= radius_km else None


def download_nightly(session, sat, d):
    """Download a single nightly ez CSV and return all rows."""
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
            # Only nighttime detections
            if row.get("Sunlit", "0") == "1":
                continue
            rows.append(row)
        return rows
    except Exception:
        return []


def main():
    import duckdb

    db = duckdb.connect()

    # Refresh from the (public) archive unless told to work purely locally
    if not os.environ.get("BACKFILL_SKIP_DOWNLOAD"):
        print("Downloading current parquet from the archive...")
        download_archive(OUTPUT)

    # Load existing state
    flare_positions = load_flare_positions(db)
    max_date = load_max_date(db)

    if not flare_positions:
        print("No existing parquet with flare positions found. Run `make vnf` first.")
        sys.exit(1)

    print(f"Loaded {len(flare_positions)} known flares, latest date: {max_date}")

    # Determine date range to backfill
    yesterday = date.today() - timedelta(days=1)
    start = max_date + timedelta(days=1) if max_date else yesterday - timedelta(days=7)

    if start > yesterday:
        print("Already up to date.")
        return

    num_days = (yesterday - start).days + 1
    print(f"Backfilling {num_days} day(s): {start} to {yesterday}")

    # Authenticate with EOG
    print("Authenticating with EOG...")
    session = authenticate()
    print("  Authenticated")

    # Build spatial index for flare matching
    grid = build_spatial_index(flare_positions)

    # Download nightly data
    jobs = []
    d = start
    while d <= yesterday:
        for sat in SATELLITES:
            jobs.append((sat, d))
        d += timedelta(days=1)

    print(f"Fetching {len(jobs)} files ({len(SATELLITES)} satellites x {num_days} days)...")

    all_rows = []
    done = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(download_nightly, session, sat, d): (sat, d)
            for sat, d in jobs
        }
        for future in as_completed(futures):
            rows = future.result()
            done += 1
            if rows:
                all_rows.extend(rows)
            if done % 50 == 0 or done == len(jobs):
                elapsed = time.time() - t0
                rate = done / elapsed if elapsed > 0 else 0
                sys.stdout.write(
                    f"\r  {done}/{len(jobs)} files "
                    f"({len(all_rows)} rows, {rate:.0f} files/s)  "
                )
                sys.stdout.flush()

    print(f"\n  {len(all_rows)} total nightly rows")

    if not all_rows:
        print("No new nightly data found.")
        return

    # Match detections to known flares
    print("Matching detections to known flares...")
    # Group by (flare_id, date) for daily aggregation
    from collections import defaultdict
    daily = defaultdict(list)  # (flare_id, date_str) -> list of pass dicts
    matched = 0
    unmatched = 0

    for row in all_rows:
        try:
            lat = float(row["Lat_GMTCO"])
            lon = float(row["Lon_GMTCO"])
        except (ValueError, KeyError):
            continue

        fid = find_nearest_flare(lat, lon, grid, MATCH_RADIUS_KM)
        if fid is None:
            unmatched += 1
            continue

        matched += 1
        date_str = row.get("Date_Mscan", "")[:10].replace("/", "-")
        cloud_mask = int(row.get("Cloud_Mask", 1))
        temp_bb = float(row.get("Temp_BB", 999999))
        rh = float(row.get("RH", 999999))

        daily[(fid, date_str)].append({
            "cloud_mask": cloud_mask,
            "temp_bb": temp_bb,
            "rh": rh,
        })

    print(f"  {matched} matched, {unmatched} unmatched (no known flare within {MATCH_RADIUS_KM} km)")

    if not daily:
        print("No matched detections to append.")
        return

    # Build new rows (same aggregation logic as build_vnf.py)
    new_rows = []
    for (fid, date_str), passes in daily.items():
        clear = any(p["cloud_mask"] == 0 for p in passes)
        detected = any(p["cloud_mask"] == 0 and p["temp_bb"] != 999999 for p in passes)
        clear_detected = [p for p in passes if p["cloud_mask"] == 0 and p["temp_bb"] != 999999]
        rh_mw = (sum(p["rh"] for p in clear_detected if p["rh"] != 999999) /
                 len([p for p in clear_detected if p["rh"] != 999999])) if any(
            p["rh"] != 999999 for p in clear_detected) else 0
        temp_k = (sum(p["temp_bb"] for p in clear_detected) /
                  len(clear_detected)) if clear_detected else 0
        lat, lon = flare_positions[fid]

        new_rows.append((
            fid, lat, lon, date_str,
            clear, detected, rh_mw, temp_k,
            0,  # nightly ez CSVs carry no Flow_Rate; filled on next full profile build
            len(passes), "", "", "",
        ))

    print(f"  {len(new_rows)} new daily rows to append")

    # Read existing parquet and append
    print("Appending to parquet...")
    db.execute(f"""
        CREATE TABLE existing AS SELECT * FROM '{OUTPUT}'
    """)

    # Remove any existing rows for dates we're backfilling (in case of re-run)
    date_strs = list(set(date_str for _, date_str in daily.keys()))
    date_list = ", ".join(f"'{d}'" for d in date_strs)
    deleted = db.execute(f"""
        DELETE FROM existing WHERE CAST(date AS VARCHAR) IN ({date_list})
    """).fetchone()

    # Insert new rows
    db.execute("""
        CREATE TABLE new_rows (
            flare_id INT, lat DOUBLE, lon DOUBLE, date DATE,
            clear BOOLEAN, detected BOOLEAN, rh_mw DOUBLE, temp_k DOUBLE,
            flow_mcm DOUBLE, n_passes INT, type VARCHAR, category VARCHAR,
            country VARCHAR
        )
    """)
    db.executemany("INSERT INTO new_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", new_rows)
    db.execute("INSERT INTO existing SELECT * FROM new_rows")

    total = db.execute("SELECT count(*) FROM existing").fetchone()[0]
    # hilbert order keeps row-group lat/lon stats tight for remote bbox reads
    # (same ordering as build_vnf.py)
    db.execute("INSTALL spatial; LOAD spatial")
    db.execute(f"""
        COPY (SELECT * FROM existing
              ORDER BY ST_Hilbert(lon, lat,
                  {{'min_x': -180, 'min_y': -90, 'max_x': 180, 'max_y': 90}}::BOX_2D),
                  flare_id, date)
        TO '{os.path.abspath(OUTPUT)}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
    """)

    size_mb = os.path.getsize(os.path.abspath(OUTPUT)) / 1e6
    print(f"  Written {total:,} rows ({size_mb:.1f} MB)")

    print("Done. Run `make vnf-upload` to push web/vnf.parquet to the archive.")


if __name__ == "__main__":
    main()
