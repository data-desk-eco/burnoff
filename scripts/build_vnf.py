#!/usr/bin/env python3
"""Build VNF Parquet from EOG profile CSVs.

Each row in the output = one flare x one date, with booleans for clear-sky
and detected.  The web query computes real cloud-free counts directly.

All flares with profiles are included.  The multiyear index provides EOG's own
metadata (type, category, country) — nothing else is joined in; the archive
carries raw EOG data only, attribution is downstream consumers' job.

Rows are ordered along a Hilbert curve over (lon, lat) so remote bbox reads
prune row groups spatially (the web map's hot path); web/flares.parquet is a
tiny per-flare position index so single-flare deep links can resolve an id to
a location first and read spatially too.

Usage: uv run --with duckdb scripts/build_vnf.py
"""
import os
import duckdb

HILBERT = ("ST_Hilbert(lon, lat, "
           "{'min_x': -180, 'min_y': -90, 'max_x': 180, 'max_y': 90}::BOX_2D)")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DATA = os.path.join(PROJECT_ROOT, "data")
LEGACY_DATA = os.path.expanduser("~/Research/lng-flaring/data")
DATA_DIR = LOCAL_DATA if os.path.isdir(os.path.join(LOCAL_DATA, "vnf_profiles")) else LEGACY_DATA
PROFILE_GLOB = os.path.join(DATA_DIR, "vnf_profiles/site_*.csv")
INDEX_CSV = os.path.join(DATA_DIR, "vnf_raw/multiyear_flare_month_summary_all_run48.csv")
OUTPUT = os.path.join(PROJECT_ROOT, "web", "vnf.parquet")

db = duckdb.connect()
db.execute("INSTALL spatial; LOAD spatial")
db.execute("SET temp_directory='/tmp/duckdb_vnf'")
db.execute("SET memory_limit='4GB'")

# --- 1. Load ALL profiles, compute stable avg position per flare ---
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

# --- 2. Daily aggregation (all flares) ---
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

# --- 3. Flare index for metadata enrichment (optional) ---
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

# --- 4. Join coordinates + metadata, write parquet ---
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
            COALESCE(m.country, '') AS country
        FROM daily d
        JOIN flare_pos p ON d.flare_id = p.flare_id
        LEFT JOIN flare_meta m ON d.flare_id = m.flare_id
        ORDER BY {HILBERT}, d.flare_id, d.date
    ) TO '{os.path.abspath(OUTPUT)}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
""")

db.execute(f"""
    COPY (SELECT flare_id, lat, lon FROM flare_pos ORDER BY flare_id)
    TO '{os.path.join(PROJECT_ROOT, "web", "flares.parquet")}'
    (FORMAT PARQUET, COMPRESSION ZSTD)
""")

size_mb = os.path.getsize(os.path.abspath(OUTPUT)) / 1e6
print(f"Done: {size_mb:.1f} MB, {count:,} rows")
