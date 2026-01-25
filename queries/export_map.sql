-- Export clustered flares as GeoJSON
--
-- Simple clustering: 20m radius around each flare, overlaps merge
-- (centers ≤ 40m apart = same cluster)

LOAD spatial;

SET VARIABLE min_detections = 2;
SET VARIABLE min_max_b12 = 0.9;
SET VARIABLE merge_distance = 40;  -- 20m radius * 2 = 40m merge threshold

WITH
raw_detections AS (
    SELECT
        d.id as facility_id, d.name,
        e.flare_lon, e.flare_lat, e.date, e.max_b12, e.pixels,
        e.cog_b12, e.epsg, e.utm_minx, e.utm_miny, e.utm_maxx, e.utm_maxy,
        row_number() OVER () as det_id
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL
      AND e.max_b12 > getvariable('min_max_b12')
),

-- Simple clustering: assign each detection to the smallest det_id within merge distance
cluster_assignments AS (
    SELECT a.*,
        (SELECT MIN(b.det_id) FROM raw_detections b
         WHERE b.facility_id = a.facility_id
           AND ST_Distance_Sphere(
               ST_Point(a.flare_lon, a.flare_lat),
               ST_Point(b.flare_lon, b.flare_lat)
           ) <= getvariable('merge_distance')
        ) as cluster_id
    FROM raw_detections a
),

clustered_flares AS (
    SELECT
        cluster_id, facility_id, name,
        -- Simple centroid (unweighted mean of all detections in cluster)
        AVG(flare_lon) as flare_lon,
        AVG(flare_lat) as flare_lat,
        MAX(max_b12) as max_b12,
        COUNT(DISTINCT date) as detection_count,
        json_group_array(json_object(
            'date', date, 'max_b12', ROUND(max_b12, 4), 'pixels', pixels,
            'cog_b12', cog_b12, 'epsg', epsg,
            'utm_bounds', json_array(utm_minx, utm_miny, utm_maxx, utm_maxy),
            'raw_lon', flare_lon, 'raw_lat', flare_lat
        )) as detections
    FROM cluster_assignments
    GROUP BY cluster_id, facility_id, name
),

filtered_flares AS (
    SELECT * FROM clustered_flares
    WHERE detection_count >= getvariable('min_detections')
)

SELECT json_object(
    'type', 'FeatureCollection',
    'features', COALESCE(json_group_array(json_object(
        'type', 'Feature',
        'geometry', json_object('type', 'Point', 'coordinates', json_array(flare_lon, flare_lat)),
        'properties', json_object(
            'facility_id', facility_id, 'name', name,
            'max_b12', ROUND(max_b12, 4), 'detection_count', detection_count,
            'detections', json(detections)
        )
    )), '[]')
) FROM filtered_flares;
