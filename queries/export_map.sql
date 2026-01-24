-- Export flare locations as GeoJSON for PMTiles conversion
-- Each unique flare location becomes a feature with all detection dates embedded
WITH flare_detections AS (
    SELECT
        d.id as facility_id,
        d.name,
        e.flare_lon,
        e.flare_lat,
        MAX(e.max_b12) as max_b12,
        COUNT(*) as detection_count,
        json_group_array(
            json_object(
                'date', e.date,
                'max_b12', ROUND(e.max_b12, 4),
                'pixels', e.pixels,
                'cog_b12', e.cog_b12,
                'epsg', e.epsg,
                'utm_bounds', json_array(e.utm_minx, e.utm_miny, e.utm_maxx, e.utm_maxy)
            )
        ) as detections
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL AND e.flare_lat IS NOT NULL
    GROUP BY d.id, d.name, e.flare_lon, e.flare_lat
    HAVING COUNT(*) >= 6  -- Filter out one-off fires, require persistent flaring
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
                'detection_count', detection_count,
                'detections', json(detections)
            )
        )
    ), '[]')
)
FROM flare_detections;
