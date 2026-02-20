#!/usr/bin/env python3
"""Build VNF Parquet from multiyear index + V4.0 nightly CSVs.

Usage: uv run --with duckdb scripts/build_vnf.py
"""
import os
import duckdb

DATA_DIR = os.path.expanduser("~/Research/lng-flaring/data")
INDEX_CSV = os.path.join(DATA_DIR, "vnf_raw/multiyear_flare_month_summary_all_run48.csv")
NIGHTLY_V40 = os.path.join(DATA_DIR, "vnf_nightly/*/*/VNF_npp_d*_eog_v40.csv.gz")
NIGHTLY_V30 = os.path.join(DATA_DIR, "vnf_nightly/*/*/VNF_j01_d*_noaa_v30*.csv.gz")
OUTPUT = os.path.join(os.path.dirname(__file__), "..", "web", "vnf.parquet")

db = duckdb.connect()

print("Loading multiyear index...")
db.execute(f"""
    CREATE TABLE idx AS
    SELECT
        CAST(id AS INTEGER) AS flare_id,
        CAST(lat AS DOUBLE) AS lat,
        CAST(lon AS DOUBLE) AS lon,
        strptime(month, '%d-%b-%Y')::DATE AS date,
        CAST(rh AS DOUBLE) AS rh_mw,
        CAST(t_mean AS DOUBLE) AS temp_k,
        CAST(nobs AS INTEGER) AS nobs,
        CAST(ndtct AS INTEGER) AS ndtct,
        type,
        category,
        country
    FROM read_csv('{INDEX_CSV}', auto_detect=true)
    WHERE CAST(rh AS DOUBLE) > 0
      AND CAST(rh AS DOUBLE) < 999
""")
idx_count = db.execute("SELECT count(*) FROM idx").fetchone()[0]
print(f"  {idx_count:,} rows from multiyear index")

import glob

nightly_parts = []

# V4.0 nightly (VNF_npp files, older format)
if glob.glob(NIGHTLY_V40):
    print("Loading V4.0 nightly observations...")
    db.execute(f"""
        CREATE TABLE v40 AS
        SELECT
            CAST(id_iremitter AS INTEGER) AS flare_id,
            CAST(Lat_iremitter AS DOUBLE) AS lat,
            CAST(Lon_iremitter AS DOUBLE) AS lon,
            CAST(Date_Mscan AS DATE) AS date,
            AVG(CAST(RH_primary AS DOUBLE)) AS rh_mw,
            AVG(CAST(Temp_primary AS DOUBLE)) AS temp_k,
            COUNT(*) AS nobs,
            COUNT(CASE WHEN CAST(RH_primary AS DOUBLE) > 0 THEN 1 END) AS ndtct,
            FIRST(CAST(Type_iremitter AS VARCHAR)) AS type,
            FIRST(CAST(Category_iremitter AS VARCHAR)) AS category,
            '' AS country
        FROM read_csv('{NIGHTLY_V40}',
            auto_detect=true,
            union_by_name=true,
            ignore_errors=true
        )
        WHERE CAST(id_iremitter AS VARCHAR) NOT IN ('999999.0', '')
          AND id_iremitter IS NOT NULL
          AND CAST(Date_Mscan AS DATE) >= (SELECT MAX(date) FROM idx)
          AND CAST(RH_primary AS DOUBLE) < 999
        GROUP BY flare_id, lat, lon, date
    """)
    v40_count = db.execute("SELECT count(*) FROM v40").fetchone()[0]
    print(f"  {v40_count:,} daily site-aggregated rows from V4.0")
    nightly_parts.append("SELECT * FROM v40")

# V3.0 nightly (VNF_j01 files, newer format)
if glob.glob(NIGHTLY_V30):
    print("Loading V3.0 nightly observations...")
    db.execute(f"""
        CREATE TABLE v30 AS
        SELECT
            CAST(id AS INTEGER) AS flare_id,
            AVG(CAST(Lat_GMTCO AS DOUBLE)) AS lat,
            AVG(CAST(Lon_GMTCO AS DOUBLE)) AS lon,
            CAST(Date_Mscan AS DATE) AS date,
            AVG(CAST(RH AS DOUBLE)) AS rh_mw,
            AVG(CAST(Temp_BB AS DOUBLE)) AS temp_k,
            COUNT(*) AS nobs,
            COUNT(CASE WHEN CAST(RH AS DOUBLE) > 0 THEN 1 END) AS ndtct,
            '' AS type,
            '' AS category,
            '' AS country
        FROM read_csv('{NIGHTLY_V30}',
            auto_detect=true,
            union_by_name=true,
            ignore_errors=true
        )
        WHERE CAST(id AS VARCHAR) NOT IN ('999999', '0', '')
          AND id IS NOT NULL
          AND CAST(Date_Mscan AS DATE) >= (SELECT MAX(date) FROM idx)
          AND CAST(RH AS DOUBLE) < 999
        GROUP BY flare_id, date
    """)
    v30_count = db.execute("SELECT count(*) FROM v30").fetchone()[0]
    print(f"  {v30_count:,} daily site-aggregated rows from V3.0")
    nightly_parts.append("SELECT * FROM v30")

union_parts = ["SELECT * FROM idx"] + nightly_parts
union_sql = " UNION ALL ".join(union_parts)

print("Writing parquet...")
db.execute(f"""
    COPY (
        SELECT * FROM ({union_sql})
        ORDER BY lat, lon, date
    ) TO '{os.path.abspath(OUTPUT)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
""")

size_mb = os.path.getsize(os.path.abspath(OUTPUT)) / 1e6
total = db.execute("SELECT count(*) FROM idx UNION ALL SELECT count(*) FROM v40").fetchall()
print(f"Done: {os.path.abspath(OUTPUT)} ({size_mb:.1f} MB)")
