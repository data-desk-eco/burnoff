-- Load data from JSON files

-- Load terminals (handle optional type field)
INSERT OR REPLACE INTO terminals
SELECT
    id,
    name,
    lat,
    lon,
    json_extract_string(t, '$.type') as type
FROM read_json('data/terminals.json') t;

-- Load detection summaries
INSERT OR REPLACE INTO detections
SELECT
    CAST(id AS INTEGER),
    name,
    CAST(lat AS DOUBLE),
    CAST(lon AS DOUBLE),
    CAST(start_date AS DATE),
    CAST(end_date AS DATE),
    CAST(images AS INTEGER),
    CAST(detections AS INTEGER),
    -- occurrence_frequency is already a percentage (0-100) from detect.py
    CAST(occurrence_frequency AS DOUBLE),
    persistence_level,
    CAST(max_b12 AS DOUBLE)
FROM read_json('data/detections.json');

-- Load individual detection events with COG metadata
-- json_extract returns NULL for missing keys (backwards compatible)
-- Use DISTINCT ON to deduplicate events with same terminal/date/flare location
INSERT OR REPLACE INTO detection_events
SELECT DISTINCT ON (lat, lon, date, flare_lat, flare_lon)
    lat, lon, date, max_b12, pixels, flare_lon, flare_lat,
    original_flare_lon, original_flare_lat,
    cog_b11, cog_b12, cog_visual,
    bounds_minx, bounds_miny, bounds_maxx, bounds_maxy,
    utm_minx, utm_miny, utm_maxx, utm_maxy, epsg,
    detection_count
FROM (
    SELECT
        CAST(d.lat AS DOUBLE) as lat,
        CAST(d.lon AS DOUBLE) as lon,
        CAST(e.date AS DATE) as date,
        CAST(e.max_b12 AS DOUBLE) as max_b12,
        CAST(e.pixels AS INTEGER) as pixels,
        json_extract(e, '$.flare_lon')::DOUBLE as flare_lon,
        json_extract(e, '$.flare_lat')::DOUBLE as flare_lat,
        -- Original coords before clustering (falls back to flare coords if not present)
        COALESCE(json_extract(e, '$.original_flare_lon')::DOUBLE, json_extract(e, '$.flare_lon')::DOUBLE) as original_flare_lon,
        COALESCE(json_extract(e, '$.original_flare_lat')::DOUBLE, json_extract(e, '$.flare_lat')::DOUBLE) as original_flare_lat,
        e.cog.b11 as cog_b11,
        e.cog.b12 as cog_b12,
        e.cog.visual as cog_visual,
        e.bounds[1] as bounds_minx,
        e.bounds[2] as bounds_miny,
        e.bounds[3] as bounds_maxx,
        e.bounds[4] as bounds_maxy,
        json_extract(e, '$.utm_bounds[0]')::DOUBLE as utm_minx,
        json_extract(e, '$.utm_bounds[1]')::DOUBLE as utm_miny,
        json_extract(e, '$.utm_bounds[2]')::DOUBLE as utm_maxx,
        json_extract(e, '$.utm_bounds[3]')::DOUBLE as utm_maxy,
        json_extract(e, '$.epsg')::INTEGER as epsg,
        json_extract(e, '$.detection_count')::INTEGER as detection_count
    FROM read_json('data/detections.json', union_by_name=true) d,
         unnest(d.detection_dates) as t(e)
    WHERE d.detection_dates IS NOT NULL
) sub;
