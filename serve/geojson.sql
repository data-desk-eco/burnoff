-- hotspots.sql's looks and hotspots as one geojson feature collection,
-- newest first: a hotspot is its pixels, a multipolygon, with its peak's
-- place and each pixel's b12 (pixel_b12, in the polygons' order); a look
-- has no geometry
.output
.mode list
.headers off
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ',' ORDER BY t DESC, k, f), '') || ']}'
FROM (SELECT datetime AS t, 1 AS k, json_object('type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Transform(ST_Collect(list_transform(px,
          lambda q: ST_MakeEnvelope(q.x - 10, q.y - 10, q.x + 10, q.y + 10))),
          crs, 'EPSG:4326', always_xy := true)), 'properties', json_object(
        'kind', 'hotspot', 'date', date, 'scene', scene, 'lon', lon,
        'lat', lat, 'max_b12', max_b12, 'avg_b12', avg_b12,
        'peak_b11', peak_b11, 'ratio', if(isinf(ratio), 1e308, ratio),
        'peakedness', peakedness, 'pixels', pixels, 'radiance', radiance,
        'saturated', saturated,
        'pixel_b12', list_transform(px, lambda q: q.b12)))::VARCHAR AS f
      FROM spots
      UNION ALL
      SELECT datetime, 0, json_object('type', 'Feature', 'geometry', NULL,
        'properties', json_object('kind', if(error IS NULL, 'look', 'error'),
        'date', datetime::DATE, 'scene', scene, 'tile', tile,
        'cloud', cloud, 'error', error))::VARCHAR
      FROM looks);
