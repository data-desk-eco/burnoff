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

-- Find the brightest detection in each cluster to anchor the location
cluster_anchors AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY cluster_id, facility_id ORDER BY max_b12 DESC) as rn
    FROM cluster_assignments
),

clustered_flares AS (
    SELECT
        c.cluster_id, c.facility_id, c.name,
        -- Anchor to brightest detection (avoids phantom centroids between nearby flares)
        MAX(CASE WHEN c.rn = 1 THEN c.flare_lon END) as flare_lon,
        MAX(CASE WHEN c.rn = 1 THEN c.flare_lat END) as flare_lat,
        MAX(c.max_b12) as max_b12,
        COUNT(DISTINCT c.date) as detection_count,
        json_group_array(json_object(
            'date', c.date, 'max_b12', ROUND(c.max_b12, 4), 'pixels', c.pixels,
            'cog_b12', c.cog_b12, 'epsg', c.epsg,
            'utm_bounds', json_array(c.utm_minx, c.utm_miny, c.utm_maxx, c.utm_maxy),
            'raw_lon', c.flare_lon, 'raw_lat', c.flare_lat
        )) as detections
    FROM cluster_anchors c
    GROUP BY c.cluster_id, c.facility_id, c.name
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
