-- hotspots.sql's spots as sites, one geojson feature a site, from every
-- date's detections the store holds within m of the box (pebbles), so the
-- same pebbles give the same sites whatever box or window asks. a pebble
-- sits on its peak's 20 m pixel, in its longitude's utm zone, in whole cm
-- (sums exact, so ties fall the same way). each pixel heaps 2 for each date
-- a pebble on it, 1 on its four neighbours; a pixel points at its tallest
-- neighbour (ties to the greater x, y) and a pebble climbs to a top, a
-- hill. a hill joins the largest larger one within 60 m whose dates it
-- does not share (two flares lit on one date are two sites), and so on to
-- a site, named by its pebbles' mean place rounded to 40 m
-- (live:<lat>,<lon>): the mean settles as dates come, where a top can flip
-- between pixels. the box's sites with a detection in the window: looks,
-- [[date, cloud], …], the obscured share of the 640 m square under the
-- site, its clearest scene a date; and each date's brightest detection,
-- its pixels as [b12, lon, lat × 4 corners]. measured on the archive's
-- detections (AGENTS.md)
.output
.mode list
.headers off
CREATE MACRO cm(lon, lat) AS (SELECT {z: z, x: round(ST_X(p) * 100)::BIGINT,
  y: round(ST_Y(p) * 100)::BIGINT} FROM (SELECT z, ST_Transform(ST_Point(lon,
    lat), 'EPSG:4326', z, always_xy := true) AS p
  FROM (SELECT 'EPSG:' || (if(lat < 0, 32700, 32600)
          + floor((lon + 180) / 6)::INT % 60 + 1) AS z)));
CREATE MACRO pix(c) AS {z: c.z, x: c.x // 2000, y: c.y // 2000};
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
SELECT cm(lon, lat) AS c, pix(cm(lon, lat)) AS p,
       split_part(scene, '_', 3)[:8] AS date
FROM (SELECT scene, lon::DOUBLE AS lon, lat::DOUBLE AS lat
      FROM sqlite_query('db', getvariable('sq'))
      UNION SELECT scene, lon, lat FROM det)
WHERE near(lon, lat);
CREATE TEMP TABLE hp AS
SELECT {z: p.z, x: p.x + d[1], y: p.y + d[2]} AS p,
       sum(2 - abs(d[1]) - abs(d[2])) AS h
FROM (SELECT DISTINCT p, date FROM pb),
     unnest([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) a(d)
GROUP BY 1;
CREATE TEMP TABLE up AS
SELECT a.p, arg_max(b.p, (b.h, b.p.x, b.p.y)) AS u
FROM hp a JOIN hp b ON b.p.z = a.p.z AND abs(b.p.x - a.p.x) <= 1
  AND abs(b.p.y - a.p.y) <= 1
GROUP BY a.p;
CREATE TEMP TABLE top AS
WITH RECURSIVE c(p, u) AS (FROM up SEMI JOIN (SELECT DISTINCT p FROM pb)
    USING (p)
  UNION ALL SELECT c.p, up.u FROM c JOIN up ON up.p = c.u AND up.u <> up.p)
SELECT c.p, c.u AS t FROM c JOIN up ON up.p = c.u AND up.u = up.p;
-- hills: their pebbles' sums and dates; each joins the largest larger
-- within 60 m whose dates it lacks, and on to a site (s)
CREATE TEMP TABLE hl AS
SELECT t, sum(c.x) AS sx, sum(c.y) AS sy, count(*) AS k,
       list(DISTINCT date) AS ds, len(list(DISTINCT date)) AS n
FROM pb JOIN top USING (p) GROUP BY t;
CREATE TEMP TABLE jn AS
WITH RECURSIVE l AS (
  SELECT a.t, coalesce(arg_max(b.t, (b.n, b.t.x, b.t.y)), a.t) AS u
  FROM hl a LEFT JOIN hl b ON b.t.z = a.t.z
    AND (b.n, b.t.x, b.t.y) > (a.n, a.t.x, a.t.y)
    AND (b.sx // b.k - a.sx // a.k) ** 2 + (b.sy // b.k - a.sy // a.k) ** 2
        <= 6000 ** 2
    AND NOT list_has_any(a.ds, b.ds)
  GROUP BY a.t),
c(t, u) AS (FROM l UNION ALL SELECT c.t, l.u FROM c JOIN l ON l.t = c.u
            AND l.u <> l.t)
SELECT c.t, c.u AS s FROM c JOIN l ON l.t = c.u AND l.u = l.t;
-- a site's place: its pebbles' mean, rounded to 40 m, in lon/lat
CREATE TEMP TABLE st AS
SELECT s, ST_X(q) AS lon, ST_Y(q) AS lat,
       'live:' || printf('%.5f', ST_Y(q)) || ',' || printf('%.5f', ST_X(q))
         AS id
FROM (SELECT s, ST_Transform(ST_Point(round(sum(sx) / sum(k) / 4000) * 40,
        round(sum(sy) / sum(k) / 4000) * 40), s.z, 'EPSG:4326',
        always_xy := true) AS q
      FROM hl JOIN jn USING (t) GROUP BY s)
WHERE ST_X(q) BETWEEN getvariable('w') AND getvariable('e')
  AND ST_Y(q) BETWEEN getvariable('s') AND getvariable('n');
CREATE TEMP TABLE hs AS
SELECT h.*, st.s AS t FROM spots h JOIN top ON top.p = pix(cm(h.lon, h.lat))
JOIN jn USING (t) JOIN st USING (s);
-- every scene's squares, in its crs, and the one under each site
CREATE TEMP TABLE sq AS
SELECT scene, v.x, v.y, v.cloud
FROM (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j, cloud))
        AS v FROM held
      UNION ALL SELECT scene, unnest(q) FROM obs);
CREATE TEMP TABLE lk AS
SELECT t, date, min(cloud) AS cloud
FROM (SELECT st.s AS t, sc.datetime::DATE AS date, arg_min(sq.cloud,
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
                   []) FROM lk WHERE lk.t = st.s),
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
            GROUP BY t) d ON d.t = st.s);
