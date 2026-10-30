-- hotspots.sql's spots as sites, one geojson feature a site. a site is a
-- top of the heap the detections build over every date: each the store
-- holds within m of the box drops a pebble on its peak's 20 m pixel (in
-- its longitude's utm zone), a date's at most one; a pebble heaps 5 - d²
-- on the pixels within 2 (d in pixels, integers, so sums are exact); each
-- pixel points at its tallest neighbour, itself if none is taller (ties to
-- the greater x, y), and a pebble climbs to a top. so the same pebbles give
-- the same sites, named by place (live:<lat>,<lon>), whatever box or
-- window asks, while every slope to a box's tops lies within m. the box's
-- tops with a detection in the window are its sites: looks, [[date,
-- cloud], …], the obscured share of the 640 m square under the top, its
-- clearest scene a date; and each date's brightest detection, its pixels
-- as [b12, lon, lat × 4 corners]
.output
.mode list
.headers off
CREATE MACRO pix(lon, lat) AS (SELECT {z: z, x: floor(ST_X(p) / 20)::INT,
  y: floor(ST_Y(p) / 20)::INT} FROM (SELECT z, ST_Transform(ST_Point(lon,
    lat), 'EPSG:4326', z, always_xy := true) AS p
  FROM (SELECT 'EPSG:' || (if(lat < 0, 32700, 32600)
          + floor((lon + 180) / 6)::INT % 60 + 1) AS z)));
CREATE MACRO near(lon, lat) AS lat BETWEEN getvariable('s') - getvariable('m')
  AND getvariable('n') + getvariable('m') AND lon BETWEEN getvariable('w')
  - getvariable('m') / cos(radians(lat)) AND getvariable('e')
  + getvariable('m') / cos(radians(lat));
CREATE MACRO ll(q, c, crs) AS ST_Transform(ST_Point(q.x + c[1], q.y + c[2]),
  crs, 'EPSG:4326', always_xy := true);
SET VARIABLE sq = 'SELECT scene, lon, lat FROM hotspots WHERE v = '''
  || getvariable('v') || ''' AND lat BETWEEN '
  || (getvariable('s') - 1.5 * getvariable('m')) || ' AND '
  || (getvariable('n') + 1.5 * getvariable('m'));
CREATE TEMP TABLE pb AS
SELECT pix(lon, lat) AS p, count(DISTINCT split_part(scene, '_', 3)[:8]) AS n
FROM (SELECT scene, lon::DOUBLE AS lon, lat::DOUBLE AS lat
      FROM sqlite_query('db', getvariable('sq'))
      UNION SELECT scene, lon, lat FROM det)
WHERE near(lon, lat) GROUP BY p;
CREATE TEMP TABLE hp AS
SELECT {z: p.z, x: p.x + dx, y: p.y + dy} AS p,
       sum(n * (5 - dx * dx - dy * dy)) AS h
FROM pb, range(-2, 3) a(dx), range(-2, 3) b(dy)
WHERE dx * dx + dy * dy <= 4 GROUP BY 1;
CREATE TEMP TABLE up AS
SELECT a.p, arg_max(b.p, (b.h, b.p.x, b.p.y)) AS u
FROM hp a JOIN hp b ON b.p.z = a.p.z AND abs(b.p.x - a.p.x) <= 1
  AND abs(b.p.y - a.p.y) <= 1
GROUP BY a.p;
CREATE TEMP TABLE top AS
WITH RECURSIVE c(p, u) AS (FROM up SEMI JOIN pb USING (p)
  UNION ALL SELECT c.p, up.u FROM c JOIN up ON up.p = c.u AND up.u <> up.p)
SELECT c.p, c.u AS t FROM c JOIN up ON up.p = c.u AND up.u = up.p;
CREATE TEMP TABLE st AS
SELECT t, ST_X(q) AS lon, ST_Y(q) AS lat,
       'live:' || printf('%.5f', ST_Y(q)) || ',' || printf('%.5f', ST_X(q))
         AS id
FROM (SELECT DISTINCT t, ST_Transform(ST_Point(t.x * 20 + 10, t.y * 20 + 10),
        t.z, 'EPSG:4326', always_xy := true) AS q FROM top)
WHERE ST_X(q) BETWEEN getvariable('w') AND getvariable('e')
  AND ST_Y(q) BETWEEN getvariable('s') AND getvariable('n');
CREATE TEMP TABLE hs AS
SELECT h.*, st.t FROM spots h JOIN top ON top.p = pix(h.lon, h.lat)
JOIN st USING (t);
-- every scene's squares, in its crs, and the one under each site
CREATE TEMP TABLE sq AS
SELECT scene, v.x, v.y, v.cloud
FROM (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j, cloud))
        AS v FROM held
      UNION ALL SELECT scene, unnest(q) FROM obs);
CREATE TEMP TABLE lk AS
SELECT t, date, min(cloud) AS cloud
FROM (SELECT st.t, sc.datetime::DATE AS date, arg_min(sq.cloud,
        (sq.x - ST_X(p)) ** 2 + (sq.y - ST_Y(p)) ** 2) AS cloud
      FROM st JOIN sc ON true, LATERAL (SELECT ST_Transform(ST_Point(st.lon,
        st.lat), 'EPSG:4326', sc.crs, always_xy := true) AS p)
      JOIN sq ON sq.scene = sc.scene AND abs(sq.x - ST_X(p)) <= 320
        AND abs(sq.y - ST_Y(p)) <= 320
      GROUP BY ALL)
GROUP BY ALL;
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ',' ORDER BY f), '') || ']}'
FROM (SELECT json_object('type', 'Feature', 'geometry', json_object('type',
        'Point', 'coordinates', [st.lon, st.lat]), 'properties', json_object(
        'id', st.id,
        'looks', (SELECT coalesce(list(json_array(date, cloud) ORDER BY date),
                   []) FROM lk WHERE lk.t = st.t),
        'detections', d.ds, 'detection_count', len(d.ds)))::VARCHAR AS f
      FROM st JOIN (SELECT t, list(json_object('date', date, 'scene',
              scene, 'lon', lon, 'lat', lat, 'max_b12', max_b12, 'avg_b12',
              avg_b12, 'peak_b11', peak_b11, 'ratio', if(isinf(ratio), 1e308,
              ratio), 'peakedness', peakedness, 'pixels', pixels,
              'radiance', radiance, 'saturated', saturated, 'px',
              list_transform(px, lambda q: list_prepend(q.b12,
                flatten(list_transform([[-10, -10], [10, -10], [10, 10],
                  [-10, 10]], lambda c: [ST_X(ll(q, c, crs)),
                                ST_Y(ll(q, c, crs))])))))
              ORDER BY date) AS ds
            FROM (FROM hs QUALIFY row_number() OVER (PARTITION BY t, date
                                ORDER BY max_b12 DESC, scene) = 1)
            GROUP BY t) d USING (t));
