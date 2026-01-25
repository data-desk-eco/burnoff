-- Export clustered flares as GeoJSON (summary only for low zoom tiles)
-- Same clustering as export_map.sql, without per-detection details

SET VARIABLE min_detections = 2;
SET VARIABLE min_max_b12 = 0.75;
SET VARIABLE min_merge_distance = 50;

WITH
raw_detections AS (
    SELECT
        d.id as facility_id, d.name,
        e.flare_lon, e.flare_lat, e.date, e.max_b12, e.pixels,
        row_number() OVER () as det_id
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL
),

cluster_assignments AS (
    SELECT a.*,
        (SELECT MIN(b.det_id) FROM raw_detections b
         WHERE b.facility_id = a.facility_id
           AND ST_Distance_Sphere(ST_Point(a.flare_lon, a.flare_lat), ST_Point(b.flare_lon, b.flare_lat))
               <= GREATEST(getvariable('min_merge_distance'),
                           detection_radius_m(a.pixels) + detection_radius_m(b.pixels))
        ) as cluster_id
    FROM raw_detections a
),

clustered_flares AS (
    SELECT
        cluster_id, facility_id, name,
        AVG(flare_lon) as flare_lon, AVG(flare_lat) as flare_lat,
        MAX(max_b12) as max_b12,
        COUNT(DISTINCT date) as detection_count
    FROM cluster_assignments
    GROUP BY cluster_id, facility_id, name
),

filtered_flares AS (
    SELECT * FROM clustered_flares
    WHERE max_b12 >= getvariable('min_max_b12')
      AND detection_count >= getvariable('min_detections')
)

SELECT json_object(
    'type', 'FeatureCollection',
    'features', COALESCE(json_group_array(json_object(
        'type', 'Feature',
        'geometry', json_object('type', 'Point', 'coordinates', json_array(flare_lon, flare_lat)),
        'properties', json_object(
            'facility_id', facility_id, 'name', name,
            'max_b12', ROUND(max_b12, 4), 'detection_count', detection_count
        )
    )), '[]')
) FROM filtered_flares;
