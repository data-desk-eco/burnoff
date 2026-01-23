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
    CAST(detection_rate AS DOUBLE),
    CAST(max_b12 AS DOUBLE)
FROM read_json('data/detections.json');

-- Load individual detection events with COG metadata
-- json_extract returns NULL for missing keys (backwards compatible)
INSERT OR REPLACE INTO detection_events
SELECT
    CAST(d.lat AS DOUBLE) as lat,
    CAST(d.lon AS DOUBLE) as lon,
    CAST(e.date AS DATE) as date,
    CAST(e.max_b12 AS DOUBLE) as max_b12,
    CAST(e.pixels AS INTEGER) as pixels,
    json_extract(e, '$.flare_lon')::DOUBLE as flare_lon,
    json_extract(e, '$.flare_lat')::DOUBLE as flare_lat,
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
    json_extract(e, '$.epsg')::INTEGER as epsg
FROM read_json('data/detections.json', union_by_name=true) d,
     unnest(d.detection_dates) as t(e)
WHERE d.detection_dates IS NOT NULL;
