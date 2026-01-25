-- Export clustered flares as GeoJSON (full details for high zoom tiles)
--
-- Clustering: Overlap-based - two detections merge if circular footprints touch
--   merge_distance = radius_a + radius_b, with 50m floor for geolocation variance

SET VARIABLE min_detections = 2;
SET VARIABLE min_max_b12 = 0.75;
SET VARIABLE min_merge_distance = 50;

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
),

cluster_assignments AS (
    SELECT a.*,
        (SELECT MIN(b.det_id) FROM raw_detections b
         WHERE b.facility_id = a.facility_id
           AND haversine_m(a.flare_lon, a.flare_lat, b.flare_lon, b.flare_lat)
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
            'max_b12', ROUND(max_b12, 4), 'detection_count', detection_count,
            'detections', json(detections)
        )
    )), '[]')
) FROM filtered_flares;
