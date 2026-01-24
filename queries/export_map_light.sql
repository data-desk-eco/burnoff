-- Export flare locations WITHOUT detection details (for low zoom tiles)
-- Much smaller - just points with summary stats
-- Uses same clustering logic as export_map.sql

-- Haversine distance macro (returns meters)
CREATE OR REPLACE MACRO haversine_m(lon1, lat1, lon2, lat2) AS (
    6371000 * 2 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
    ))
);

-- Configuration (same as export_map.sql)
SET VARIABLE cluster_distance_m = 150;
SET VARIABLE min_detections = 3;
SET VARIABLE min_max_b12 = 0.75;

WITH
raw_detections AS (
    SELECT
        d.id as facility_id,
        d.name,
        e.flare_lon,
        e.flare_lat,
        e.date,
        e.max_b12,
        row_number() OVER () as det_id
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL AND e.flare_lat IS NOT NULL
),

cluster_leaders AS (
    SELECT
        a.det_id,
        a.facility_id,
        a.name,
        a.flare_lon,
        a.flare_lat,
        a.date,
        a.max_b12,
        (SELECT MIN(b.det_id)
         FROM raw_detections b
         WHERE b.facility_id = a.facility_id
           AND haversine_m(a.flare_lon, a.flare_lat, b.flare_lon, b.flare_lat) <= getvariable('cluster_distance_m')
        ) as leader_id
    FROM raw_detections a
),

final_clusters AS (
    SELECT
        a.det_id,
        a.facility_id,
        a.name,
        a.flare_lon,
        a.flare_lat,
        a.date,
        a.max_b12,
        (SELECT MIN(b.leader_id)
         FROM cluster_leaders b
         WHERE b.facility_id = a.facility_id
           AND haversine_m(a.flare_lon, a.flare_lat, b.flare_lon, b.flare_lat) <= getvariable('cluster_distance_m')
        ) as cluster_id
    FROM cluster_leaders a
),

clustered_flares AS (
    SELECT
        cluster_id,
        facility_id,
        name,
        AVG(flare_lon) as flare_lon,
        AVG(flare_lat) as flare_lat,
        MAX(max_b12) as max_b12,
        COUNT(DISTINCT date) as detection_count
    FROM final_clusters
    GROUP BY cluster_id, facility_id, name
),

filtered_flares AS (
    SELECT *
    FROM clustered_flares
    WHERE max_b12 >= getvariable('min_max_b12')
      AND detection_count >= getvariable('min_detections')
)

SELECT json_object(
    'type', 'FeatureCollection',
    'features', COALESCE(json_group_array(
        json_object(
            'type', 'Feature',
            'geometry', json_object(
                'type', 'Point',
                'coordinates', json_array(flare_lon, flare_lat)
            ),
            'properties', json_object(
                'facility_id', facility_id,
                'name', name,
                'max_b12', ROUND(max_b12, 4),
                'detection_count', detection_count
            )
        )
    ), '[]')
)
FROM filtered_flares;
