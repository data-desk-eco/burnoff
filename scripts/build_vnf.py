#!/usr/bin/env python3
"""Build VNF Parquet from EOG profile CSVs.

Each row in the output = one flare x one date, with booleans for clear-sky
and detected.  The web query computes real cloud-free counts directly.

All flares with profiles are included.  OGIM point features (gas processing
plants, compressor stations, LNG facilities, refineries, terminals, offshore
platforms, etc.) are spatially joined to enrich flares near gas industry
infrastructure.  The multiyear index provides additional metadata (type,
category, country).

Requires OGIM v2.7 GeoPackage at ~/Tools/firedamp/data/OGIM_v2.7.gpkg
(or symlinked into data/).

Usage: uv run --with duckdb scripts/build_vnf.py
"""
import os, math, sqlite3
import duckdb

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DATA = os.path.join(PROJECT_ROOT, "data")
LEGACY_DATA = os.path.expanduser("~/Research/lng-flaring/data")
DATA_DIR = LOCAL_DATA if os.path.isdir(os.path.join(LOCAL_DATA, "vnf_profiles")) else LEGACY_DATA
PROFILE_GLOB = os.path.join(DATA_DIR, "vnf_profiles/site_*.csv")
INDEX_CSV = os.path.join(DATA_DIR, "vnf_raw/multiyear_flare_month_summary_all_run48.csv")
OUTPUT = os.path.join(PROJECT_ROOT, "web", "vnf.parquet")

# OGIM GeoPackage — try local data/ first, then firedamp
OGIM_GPKG = os.path.join(LOCAL_DATA, "OGIM_v2.7.gpkg")
if not os.path.exists(OGIM_GPKG):
    OGIM_GPKG = os.path.expanduser("~/Tools/firedamp/data/OGIM_v2.7.gpkg")

OGIM_RADIUS_KM = 10

# Point feature layers in OGIM (no pipelines, no wells, no fields/basins/blocks)
OGIM_LAYERS = [
    "Gathering_and_Processing",
    "Natural_Gas_Compressor_Stations",
    "LNG_Facilities",
    "Crude_Oil_Refineries",
    "Petroleum_Terminals",
    "Offshore_Platforms",
    "Stations_Other",
    "Tank_Battery",
]

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

db = duckdb.connect()
db.execute("SET temp_directory='/tmp/duckdb_vnf'")
db.execute("SET memory_limit='4GB'")

# --- 1. Load OGIM point features ---
print("Loading OGIM facilities...")
if not os.path.exists(OGIM_GPKG):
    print(f"  Warning: {OGIM_GPKG} not found, no facility enrichment")
    ogim_facilities = []
else:
    ogim_facilities = []
    con = sqlite3.connect(OGIM_GPKG)
    for layer in OGIM_LAYERS:
        rows = con.execute(f"""
            SELECT LATITUDE, LONGITUDE, FAC_TYPE, FAC_NAME
            FROM "{layer}"
            WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
        """).fetchall()
        ogim_facilities.extend(rows)
    con.close()
    print(f"  {len(ogim_facilities)} point features across {len(OGIM_LAYERS)} layers")

# --- 2. Load ALL profiles, compute stable avg position per flare ---
print("Loading profiles...")
db.execute(f"""
    CREATE TABLE passes AS
    SELECT
        CAST(flare_id AS INTEGER) AS flare_id,
        CAST(Date_Mscan AS DATE) AS date,
        CAST(Lat_GMTCO AS DOUBLE) AS pass_lat,
        CAST(Lon_GMTCO AS DOUBLE) AS pass_lon,
        CAST(Cloud_Mask AS INTEGER) AS cloud_mask,
        CAST(Temp_BB AS DOUBLE) AS temp_bb,
        CAST(RH AS DOUBLE) AS rh,
        CAST(Flow_Rate AS DOUBLE) AS flow
    FROM read_csv('{PROFILE_GLOB}',
        auto_detect=true, union_by_name=true, ignore_errors=true)
    WHERE CAST(Sunlit AS INTEGER) = 0
""")
pass_count = db.execute("SELECT count(*) FROM passes").fetchone()[0]
print(f"  {pass_count:,} nighttime passes")

# Stable position per flare: average of all pass coordinates
db.execute("""
    CREATE TABLE flare_pos AS
    SELECT flare_id, AVG(pass_lat) AS lat, AVG(pass_lon) AS lon
    FROM passes
    GROUP BY flare_id
""")
flare_count = db.execute("SELECT count(*) FROM flare_pos").fetchone()[0]
print(f"  {flare_count} flares in profiles")

# --- 3. OGIM spatial join — nearest facility within radius ---
print(f"Joining with OGIM ({OGIM_RADIUS_KM} km radius)...")
flares = db.execute("SELECT flare_id, lat, lon FROM flare_pos").fetchall()
facility_rows = []  # (flare_id, facility_type, facility_name)
matched = 0

if ogim_facilities:
    # Build a rough spatial index: bin facilities into 1-degree cells
    from collections import defaultdict
    grid = defaultdict(list)
    for flat, flon, ftype, fname in ogim_facilities:
        key = (int(flat), int(flon))
        grid[key].append((flat, flon, ftype or '', fname or ''))

    # For each flare, check nearby cells
    search_deg = math.ceil(OGIM_RADIUS_KM / 111)  # ~111 km per degree
    for fid, flat, flon in flares:
        best_dist = OGIM_RADIUS_KM + 1
        best_type = ''
        best_name = ''
        clat, clon = int(flat), int(flon)
        for dlat in range(-search_deg, search_deg + 1):
            for dlon in range(-search_deg, search_deg + 1):
                for olat, olon, otype, oname in grid.get((clat + dlat, clon + dlon), []):
                    d = haversine_km(flat, flon, olat, olon)
                    if d < best_dist:
                        best_dist = d
                        best_type = otype
                        best_name = oname
        if best_dist <= OGIM_RADIUS_KM:
            facility_rows.append((fid, best_type, best_name))
            matched += 1

print(f"  {matched}/{flare_count} flares within {OGIM_RADIUS_KM} km of an OGIM facility")

db.execute("CREATE TABLE facility_info (flare_id INTEGER, facility_type VARCHAR, facility_name VARCHAR)")
if facility_rows:
    db.executemany("INSERT INTO facility_info VALUES (?, ?, ?)", facility_rows)

# --- 4. Daily aggregation (all flares) ---
print("Aggregating daily...")
db.execute("""
    CREATE TABLE daily AS
    SELECT
        flare_id, date,
        BOOL_OR(cloud_mask = 0) AS clear,
        BOOL_OR(cloud_mask = 0 AND temp_bb != 999999) AS detected,
        AVG(rh) FILTER (
            WHERE cloud_mask = 0 AND temp_bb != 999999 AND rh != 999999
        ) AS rh_mw,
        AVG(temp_bb) FILTER (
            WHERE cloud_mask = 0 AND temp_bb != 999999
        ) AS temp_k,
        AVG(flow) FILTER (
            WHERE cloud_mask = 0 AND temp_bb != 999999 AND flow != 999999
        ) AS flow_mcm,
        COUNT(*) AS n_passes
    FROM passes
    GROUP BY flare_id, date
""")
count = db.execute("SELECT count(*) FROM daily").fetchone()[0]
print(f"  {count:,} daily rows")

# --- 5. Flare index for metadata enrichment (optional) ---
if os.path.exists(INDEX_CSV):
    print("Loading flare index for metadata...")
    db.execute(f"""
        CREATE TABLE flare_meta AS
        SELECT
            CAST(id AS INTEGER) AS flare_id,
            FIRST(type) AS type,
            FIRST(category) AS category,
            FIRST(country) AS country
        FROM read_csv('{INDEX_CSV}', auto_detect=true)
        GROUP BY CAST(id AS INTEGER)
    """)
else:
    print("No flare index found, skipping metadata")
    db.execute("CREATE TABLE flare_meta (flare_id INTEGER, type VARCHAR, category VARCHAR, country VARCHAR)")

# --- 6. Join coordinates + metadata, write parquet ---
print("Writing parquet...")
db.execute(f"""
    COPY (
        SELECT
            d.flare_id, p.lat, p.lon, d.date,
            d.clear, d.detected,
            COALESCE(d.rh_mw, 0) AS rh_mw,
            COALESCE(d.temp_k, 0) AS temp_k,
            COALESCE(d.flow_mcm, 0) AS flow_mcm,
            d.n_passes,
            COALESCE(m.type, '') AS type,
            COALESCE(m.category, '') AS category,
            COALESCE(m.country, '') AS country,
            COALESCE(fi.facility_type, '') AS facility_type,
            COALESCE(fi.facility_name, '') AS facility_name
        FROM daily d
        JOIN flare_pos p ON d.flare_id = p.flare_id
        LEFT JOIN flare_meta m ON d.flare_id = m.flare_id
        LEFT JOIN facility_info fi ON d.flare_id = fi.flare_id
        ORDER BY d.flare_id, d.date
    ) TO '{os.path.abspath(OUTPUT)}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
""")

size_mb = os.path.getsize(os.path.abspath(OUTPUT)) / 1e6
print(f"Done: {size_mb:.1f} MB, {count:,} rows")
