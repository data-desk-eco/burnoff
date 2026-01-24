-- Export flare locations WITHOUT detection details (for low zoom tiles)
-- Much smaller - just points with summary stats
-- Filters: max_b12 >= 0.75 (high confidence), detection_count >= 3 (temporal persistence)
WITH flare_detections AS (
    SELECT
        d.id as facility_id,
        d.name,
        e.flare_lon,
        e.flare_lat,
        MAX(e.max_b12) as max_b12,
        COUNT(*) as detection_count
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL AND e.flare_lat IS NOT NULL
    GROUP BY d.id, d.name, e.flare_lon, e.flare_lat
    HAVING MAX(e.max_b12) >= 0.75 AND COUNT(*) >= 3
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
FROM flare_detections;
