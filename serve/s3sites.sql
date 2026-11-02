-- s3box.sql's spots as sites, one geojson feature a site, from every hotspot
-- the store holds within m of the box (pebbles), so the same pebbles give the
-- same sites whatever box or window asks: sites.sql's constrained single
-- linkage at slstr's scale. a pebble sits on its 250 m pixel, in its
-- longitude's utm zone, in whole cm; pixels within 750 m are linked, shortest
-- first (ties by place), each link joining two sites unless they hold two
-- pebbles of one granule, two flares lit at once (a granule's hotspots are its
-- 8-connected clusters, so a flare is one of them). 750 m, as a hotspot's
-- corrected place (api.sql's s3at) is still within ~500 m of its flare 9 times
-- in 10. a site is named by its pebbles' mean place rounded to 250 m
-- (s3:<lat>,<lon>). the box's sites with a detection in the window: looks,
-- [[date, cloud], …], the obscured share of the 0.02° square under the site,
-- its clearest granule a night; and each night's detection, the site's hotspots
-- in its brightest granule, summed, and their pixels (px, s3_detect's)
CREATE OR REPLACE TEMP TABLE pb AS
SELECT cm(lon, lat) AS c, {z: cm(lon, lat).z, x: cm(lon, lat).x // 25000,
         y: cm(lon, lat).y // 25000} AS p, granule AS d
FROM (SELECT DISTINCT granule, lon, lat FROM s3at('det'))
WHERE near(lon, lat);
CREATE OR REPLACE TEMP TABLE nd AS
SELECT row_number() OVER (ORDER BY p.z, p.x, p.y) AS n, p,
       list({d: d, x: c.x, y: c.y}) AS q
FROM pb GROUP BY p;
CREATE OR REPLACE TEMP TABLE ln AS
SELECT row_number() OVER (ORDER BY l, a.n, b.n) AS r, a.n AS a, b.n AS b
FROM nd a JOIN nd b ON b.p.z = a.p.z AND b.n > a.n
  AND abs(b.p.x - a.p.x) <= 3 AND abs(b.p.y - a.p.y) <= 3,
LATERAL (SELECT (b.p.x - a.p.x) ** 2 + (b.p.y - a.p.y) ** 2 AS l)
WHERE l <= 9;
CREATE OR REPLACE TEMP TABLE cn AS
WITH RECURSIVE w(n, c) USING KEY (n) AS (
  SELECT n, n FROM nd
  UNION ALL
  SELECT e.y, min(w.c) FROM w JOIN (SELECT a AS x, b AS y FROM ln
    UNION ALL SELECT b, a FROM ln) e ON e.x = w.n
  JOIN recurring.w o ON o.n = e.y WHERE w.c < o.c GROUP BY e.y)
SELECT n, c, row_number() OVER (PARTITION BY c ORDER BY n) AS i FROM w;
CREATE OR REPLACE TEMP TABLE lc AS
SELECT x.c, row_number() OVER (PARTITION BY x.c ORDER BY r) AS r,
       x.i AS a, y.i AS b
FROM ln JOIN cn x ON x.n = ln.a JOIN cn y ON y.n = ln.b;
CREATE OR REPLACE TEMP TABLE gs AS
WITH RECURSIVE k(c, r, q, g) USING KEY (c) AS (
  SELECT c, 0, list(q ORDER BY i), range(1, count(*) + 1)
  FROM cn JOIN nd USING (n) GROUP BY c
  UNION ALL
  SELECT k.c, k.r + 1, k.q, if(i <> j AND NOT coalesce(clash3(grp(k.q, k.g,
           i), grp(k.q, k.g, j)), false), list_transform(k.g, lambda x:
           if(x = j, i, x)), k.g)
  FROM k JOIN lc ON lc.c = k.c AND lc.r = k.r + 1,
  LATERAL (SELECT least(k.g[a], k.g[b]) AS i, greatest(k.g[a], k.g[b]) AS j))
SELECT x.n, y.n AS s FROM k JOIN cn x USING (c) JOIN cn y
  ON y.c = k.c AND y.i = k.g[x.i];
CREATE OR REPLACE TEMP TABLE nds AS SELECT nd.p, gs.s FROM nd JOIN gs USING (n);
-- a site's place: its pebbles' mean, rounded to 250 m, in lon/lat
CREATE OR REPLACE TEMP TABLE st AS
SELECT s, ST_X(q) AS lon, ST_Y(q) AS lat,
       's3:' || printf('%.5f', ST_Y(q)) || ',' || printf('%.5f', ST_X(q))
         AS id
FROM (SELECT s, ST_Transform(ST_Point(round(sum(c.x) / count(*) / 25000)
        * 250, round(sum(c.y) / count(*) / 25000) * 250), any_value(c.z),
        'EPSG:4326', always_xy := true) AS q
      FROM pb JOIN nds USING (p) GROUP BY s)
WHERE ST_X(q) BETWEEN getvariable('w') AND getvariable('e')
  AND ST_Y(q) BETWEEN getvariable('s') AND getvariable('n');
-- a night's detection: the site's hotspots in a granule, summed, and of a
-- night's granules the brightest
CREATE OR REPLACE TEMP TABLE hs AS
SELECT nds.s AS t, h.granule, any_value(h.date) AS date,
       any_value(h.datetime) AS datetime,
       sum(h.rh) AS rh,
       sum(h.rh * h.temperature) / nullif(sum(h.rh) FILTER (
         h.temperature IS NOT NULL), 0) AS temperature,
       sum(h.pixels)::INT AS pixels, flatten(list(h.px)) AS px,
       count(*)::INT AS hotspots,
       bool_and(h.confirmed) AS confirmed, bool_or(h.saturated) AS saturated,
       sum(h.lon * h.rh) / nullif(sum(h.rh), 0) AS lon,
       sum(h.lat * h.rh) / nullif(sum(h.rh), 0) AS lat
FROM (SELECT *, {z: cm(lon, lat).z, x: cm(lon, lat).x // 25000,
               y: cm(lon, lat).y // 25000} AS p FROM spots) h
JOIN nds USING (p) SEMI JOIN st ON st.s = nds.s
GROUP BY nds.s, h.granule;
-- a site's look a granule: the square under it, of the granule's cell; a
-- night's clearest
CREATE OR REPLACE TEMP TABLE lk AS
SELECT st.s AS t, s3night(c.t, st.lon) AS date,
       min(1 - (from_json(c.squares, '[["DOUBLE"]]')[u.k + 1])[2]) AS cloud
FROM st, LATERAL (SELECT floor(round(st.lon * 10, 6))::INT AS ci,
                         floor(round(st.lat * 10, 6))::INT AS cj,
                         (floor(round(st.lat * 50, 6))::INT
                          - floor(round(st.lat * 10, 6))::INT * 5) * 5
                         + floor(round(st.lon * 50, 6))::INT
                         - floor(round(st.lon * 10, 6))::INT * 5 AS k) u
JOIN c3 c ON c.i = u.ci AND c.j = u.cj
WHERE c.sza >= 90
  AND (from_json(c.squares, '[["DOUBLE"]]')[u.k + 1])[1] > 0
GROUP BY ALL;
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ',' ORDER BY f), '') || ']}' AS geojson
FROM (SELECT json_object('type', 'Feature', 'geometry', json_object('type',
        'Point', 'coordinates', [st.lon, st.lat]), 'properties', json_object(
        'id', st.id,
        'looks', (SELECT coalesce(list(json_array(date, round(cloud, 3))
                   ORDER BY date), []) FROM lk WHERE lk.t = st.s),
        'detections', d.ds, 'detection_count', len(d.ds)))::VARCHAR AS f
      FROM st JOIN (SELECT t, list(json_object('date', date, 'datetime',
              datetime, 'granule', granule, 'lon', lon, 'lat', lat, 'rh', rh,
              'temperature', temperature, 'pixels', pixels, 'px', px,
              'hotspots',
              hotspots, 'confirmed', confirmed, 'saturated', saturated)
              ORDER BY date) AS ds
            FROM (FROM hs QUALIFY row_number() OVER (PARTITION BY t, date
                                ORDER BY rh DESC, granule) = 1)
            GROUP BY t) d ON d.t = st.s);
