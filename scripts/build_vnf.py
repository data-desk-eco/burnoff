#!/usr/bin/env python3
"""Build VNF Parquet from EOG profile CSVs.

Each row in the output = one flare x one date, with booleans for clear-sky
and detected.  The web query computes real cloud-free counts directly.

Profiles are the primary data source.  The multiyear index is used only for
metadata enrichment (type, category, country).  Stable per-flare coordinates
are computed from the profiles themselves (avg of all nighttime passes).

Usage: uv run --with duckdb scripts/build_vnf.py
"""
import os, json, math
import duckdb

DATA_DIR = os.path.expanduser("~/Research/lng-flaring/data")
PROFILE_GLOB = os.path.join(DATA_DIR, "vnf_profiles/site_*.csv")
INDEX_CSV = os.path.join(DATA_DIR, "vnf_raw/multiyear_flare_month_summary_all_run48.csv")
TERMINALS = os.path.join(os.path.dirname(__file__), "..", "web", "terminals.geojson")
OUTPUT = os.path.join(os.path.dirname(__file__), "..", "web", "vnf.parquet")

RADIUS_KM = 6

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

db = duckdb.connect()

# --- 1. Terminal coordinates ---
with open(os.path.abspath(TERMINALS)) as f:
    terminals = json.load(f)
term_coords = [(feat["geometry"]["coordinates"][1],
                feat["geometry"]["coordinates"][0])
               for feat in terminals["features"]]
print(f"{len(term_coords)} terminals")

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
        CAST(RH AS DOUBLE) AS rh
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

# --- 3. Terminal-adjacent filter using profile-derived positions ---
flares = db.execute("SELECT flare_id, lat, lon FROM flare_pos").fetchall()
adj = set()
for fid, flat, flon in flares:
    for tlat, tlon in term_coords:
        if haversine_km(flat, flon, tlat, tlon) <= RADIUS_KM:
            adj.add(fid)
            break
print(f"  {len(adj)} within {RADIUS_KM} km of a terminal")

adj_list = ",".join(str(x) for x in sorted(adj))
db.execute(f"CREATE TABLE adj_ids AS SELECT unnest([{adj_list}]) AS flare_id")

# --- 4. Daily aggregation for adjacent flares ---
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
        COUNT(*) AS n_passes
    FROM passes
    WHERE flare_id IN (SELECT flare_id FROM adj_ids)
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
            d.n_passes,
            COALESCE(m.type, '') AS type,
            COALESCE(m.category, '') AS category,
            COALESCE(m.country, '') AS country
        FROM daily d
        JOIN flare_pos p ON d.flare_id = p.flare_id
        LEFT JOIN flare_meta m ON d.flare_id = m.flare_id
        ORDER BY p.lat, p.lon, d.date
    ) TO '{os.path.abspath(OUTPUT)}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
""")

size_mb = os.path.getsize(os.path.abspath(OUTPUT)) / 1e6
print(f"Done: {size_mb:.1f} MB, {count:,} rows")
