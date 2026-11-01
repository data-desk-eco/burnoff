-- s3box.sql's looks and hotspots as one geojson feature collection, newest
-- first: a hotspot is a point, its cluster's s5-weighted place, with its
-- radiant heat (rh, MW), planck's temperature (K) and pixels; a look has no
-- geometry
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ',' ORDER BY t DESC, k, f), '')
       || ']}' AS geojson
FROM (SELECT datetime AS t, 1 AS k, json_object('type', 'Feature',
        'geometry', json_object('type', 'Point', 'coordinates', [lon, lat]),
        'properties', json_object('kind', 'hotspot', 'date', date,
        'datetime', datetime, 'granule', granule, 'lon', lon, 'lat', lat,
        'rh', rh, 'temperature', temperature, 'pixels', pixels, 's5', s5,
        's6', s6, 'confirmed', confirmed, 'saturated', saturated))::VARCHAR
        AS f
      FROM spots WHERE lon BETWEEN getvariable('w') AND getvariable('e')
        AND lat BETWEEN getvariable('s') AND getvariable('n')
      UNION ALL
      SELECT datetime, 0, json_object('type', 'Feature', 'geometry', NULL,
        'properties', json_object('kind', if(error IS NULL, 'look', 'error'),
        'date', date, 'datetime', datetime, 'granule', granule,
        'clear', clear, 'sza', sza, 'error', error))::VARCHAR
      FROM looks);
