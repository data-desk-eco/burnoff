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

-- Load detection summaries (join with terminals to get id and name)
INSERT OR REPLACE INTO detections
SELECT
    t.id,
    t.name,
    CAST(d.lat AS DOUBLE),
    CAST(d.lon AS DOUBLE),
    CAST(d.start_date AS DATE),
    CAST(d.end_date AS DATE),
    CAST(d.images AS INTEGER),
    CAST(d.detections AS INTEGER),
    CAST(d.occurrence_frequency AS DOUBLE),
    d.persistence_level,
    CAST(d.max_b12 AS DOUBLE)
FROM read_json('data/detections.json') d
LEFT JOIN terminals t ON ABS(d.lat - t.lat) < 0.001 AND ABS(d.lon - t.lon) < 0.001;

-- Load individual detection events with COG metadata
-- Centroid-based detections from detect.py - clustering done in export_map.sql
INSERT OR REPLACE INTO detection_events
SELECT DISTINCT ON (lat, lon, date, flare_lat, flare_lon)
    lat, lon, date, max_b12, avg_b12, pixels, flare_lon, flare_lat,
    max_pixel_lon, max_pixel_lat,
    cog_b11, cog_b12, cog_visual,
    bounds_minx, bounds_miny, bounds_maxx, bounds_maxy,
    utm_minx, utm_miny, utm_maxx, utm_maxy, epsg
FROM (
    SELECT
        CAST(d.lat AS DOUBLE) as lat,
        CAST(d.lon AS DOUBLE) as lon,
        CAST(e.date AS DATE) as date,
        CAST(e.max_b12 AS DOUBLE) as max_b12,
        CAST(json_extract(e, '$.avg_b12') AS DOUBLE) as avg_b12,
        CAST(e.pixels AS INTEGER) as pixels,
        json_extract(e, '$.flare_lon')::DOUBLE as flare_lon,
        json_extract(e, '$.flare_lat')::DOUBLE as flare_lat,
        json_extract(e, '$.max_pixel_lon')::DOUBLE as max_pixel_lon,
        json_extract(e, '$.max_pixel_lat')::DOUBLE as max_pixel_lat,
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
    WHERE d.detection_dates IS NOT NULL
) sub;
