-- Export individual detection events as GeoJSON for PMTiles conversion
-- Each detection event becomes a separate feature at its actual detected location
SELECT json_object(
    'type', 'FeatureCollection',
    'features', COALESCE(json_group_array(
        json_object(
            'type', 'Feature',
            'geometry', json_object(
                'type', 'Point',
                'coordinates', json_array(
                    COALESCE(e.flare_lon, (e.bounds_minx + e.bounds_maxx) / 2),
                    COALESCE(e.flare_lat, (e.bounds_miny + e.bounds_maxy) / 2)
                )
            ),
            'properties', json_object(
                'facility_id', d.id,
                'name', d.name,
                'date', e.date,
                'max_b12', ROUND(e.max_b12, 4),
                'pixels', e.pixels,
                'cog_b12', e.cog_b12,
                'cog_visual', e.cog_visual,
                'bounds', json_array(e.bounds_minx, e.bounds_miny, e.bounds_maxx, e.bounds_maxy),
                'utm_bounds', json_array(e.utm_minx, e.utm_miny, e.utm_maxx, e.utm_maxy),
                'epsg', e.epsg
            )
        )
    ), '[]')
)
FROM detections d
JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
WHERE e.bounds_minx IS NOT NULL;
