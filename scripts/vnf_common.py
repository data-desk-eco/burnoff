"""shared vnf output helpers for build_vnf.py and backfill_vnf.py.

the web map reads two tiers: a small quarterly rollup for the viewport
(windowed to the UI's quarter grid, last 4 calendar years) and the big daily
parquet only per flare on card open. both are hilbert-ordered over (lon, lat)
so remote bbox reads prune row groups spatially.
"""

HILBERT = ("ST_Hilbert(lon, lat, "
           "{'min_x': -180, 'min_y': -90, 'max_x': 180, 'max_y': 90}::BOX_2D)")


def write_rollup(db, daily_parquet, out):
    """flare x quarter aggregates from the daily parquet."""
    db.execute("INSTALL spatial; LOAD spatial")
    db.execute(f"""
        COPY (
            SELECT * FROM (
                SELECT
                    flare_id, any_value(lat) AS lat, any_value(lon) AS lon,
                    date_trunc('quarter', date)::DATE AS quarter,
                    count(*)::INT AS days,
                    count(*) FILTER (clear)::INT AS clear_days,
                    count(*) FILTER (detected)::INT AS detected_days,
                    round(coalesce(sum(rh_mw) FILTER (detected), 0), 2) AS rh_sum,
                    round(coalesce(max(rh_mw) FILTER (detected), 0), 2) AS rh_max,
                    any_value(type) AS type,
                    any_value(category) AS category,
                    any_value(country) AS country
                FROM '{daily_parquet}'
                WHERE date >= date_trunc('year', current_date) - INTERVAL 3 YEAR
                GROUP BY flare_id, quarter
            ) ORDER BY {HILBERT}, flare_id, quarter
        ) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 20000)
    """)
