-- hotspots.sql's spots as sites, one geojson feature a site, as aerial keeps
-- them: the detections within 100 m of the first (oldest first, greedy), id
-- live:<lat>,<lon>@<tile>_<date> after it; looks, [[date, cloud], …], the
-- obscured share of the 640 m square under the site, its clearest scene a
-- date; and each date's brightest detection, its pixels as [b12, lon, lat
-- × 4 corners]
.output
.mode list
.headers off
CREATE MACRO metres(a, b, c, d) AS
  111320 * sqrt(((c - a) * cos(radians(b))) ** 2 + (d - b) ** 2);
CREATE MACRO ll(q, c, crs) AS ST_Transform(ST_Point(q.x + c[1], q.y + c[2]),
  crs, 'EPSG:4326', always_xy := true);
CREATE TEMP TABLE h AS
SELECT row_number() OVER (ORDER BY datetime, lat, lon) AS k, * FROM spots;
CREATE TEMP TABLE seeds AS
WITH RECURSIVE r(k, ss) AS (
  SELECT 0, []::STRUCT(lon DOUBLE, lat DOUBLE, k BIGINT)[]
  UNION ALL
  SELECT h.k, if(list_bool_or(list_transform(r.ss, lambda z:
           metres(z.lon, z.lat, h.lon, h.lat) <= 100)), r.ss,
           list_append(r.ss, {lon: h.lon, lat: h.lat, k: h.k}))
  FROM r JOIN h ON h.k = r.k + 1)
SELECT unnest(ss, recursive := true) FROM r
WHERE k = (SELECT coalesce(max(k), 0) FROM h);
CREATE TEMP TABLE hs AS
SELECT h.*, (SELECT min(z.k) FROM seeds z
                   WHERE metres(z.lon, z.lat, h.lon, h.lat) <= 100) AS site
FROM h;
CREATE TEMP TABLE st AS
SELECT h.k AS site, h.lon, h.lat, 'live:' || printf('%.5f', h.lat) || ','
         || printf('%.5f', h.lon) || '@' || split_part(h.scene, '_', 6)[2:]
         || '_' || h.date AS id
FROM seeds JOIN h USING (k);
-- every scene's squares, in its crs, and the one under each site
CREATE TEMP TABLE sq AS
SELECT scene, v.x, v.y, v.cloud
FROM (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j, cloud))
        AS v FROM held
      UNION ALL SELECT scene, unnest(q) FROM obs);
CREATE TEMP TABLE lk AS
SELECT site, date, min(cloud) AS cloud
FROM (SELECT st.site, sc.datetime::DATE AS date, arg_min(sq.cloud,
        (sq.x - ST_X(p)) ** 2 + (sq.y - ST_Y(p)) ** 2) AS cloud
      FROM st JOIN sc ON true, LATERAL (SELECT ST_Transform(ST_Point(st.lon,
        st.lat), 'EPSG:4326', sc.crs, always_xy := true) AS p)
      JOIN sq ON sq.scene = sc.scene AND abs(sq.x - ST_X(p)) <= 320
        AND abs(sq.y - ST_Y(p)) <= 320
      GROUP BY ALL)
GROUP BY ALL;
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ','), '') || ']}'
FROM (SELECT json_object('type', 'Feature', 'geometry', json_object('type',
        'Point', 'coordinates', [st.lon, st.lat]), 'properties', json_object(
        'id', st.id, 'tile', split_part(st.id, '@', 2)[:5],
        'looks', (SELECT coalesce(list(json_array(date, cloud) ORDER BY date),
                   []) FROM lk WHERE lk.site = st.site),
        'detections', d.ds, 'detection_count', len(d.ds)))::VARCHAR AS f
      FROM st JOIN (SELECT site, list(json_object('date', date, 'scene',
              scene, 'lon', lon, 'lat', lat, 'max_b12', max_b12, 'avg_b12',
              avg_b12, 'peak_b11', peak_b11, 'ratio', if(isinf(ratio), 1e308,
              ratio), 'peakedness', peakedness, 'pixels', pixels,
              'radiance', radiance, 'saturated', saturated, 'px',
              list_transform(px, lambda q: list_prepend(q.b12,
                flatten(list_transform([[-10, -10], [10, -10], [10, 10],
                  [-10, 10]], lambda c: [ST_X(ll(q, c, crs)),
                                ST_Y(ll(q, c, crs))])))))
              ORDER BY date) AS ds
            FROM (FROM hs QUALIFY row_number() OVER (PARTITION BY site, date
                                ORDER BY max_b12 DESC) = 1)
            GROUP BY site) d USING (site));
