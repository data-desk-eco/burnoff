-- box.sql's spots as sites, one geojson feature a site, from every
-- date's detections the store holds within m of the box (pebbles), so the
-- same pebbles give the same sites whatever box or window asks. a pebble
-- sits on its peak's 20 m pixel, in its longitude's utm zone, in whole cm.
-- sites are constrained single linkage: pixels within 40 m are linked,
-- shortest first (ties by place), each link joining two sites unless they
-- hold pebbles of one date over 30 m apart, two flares lit at once (one
-- flare seen from two tiles' overlap is nearer). a site is named by its
-- pebbles' mean place rounded to 40 m (live:<lat>,<lon>), which settles as
-- dates come. the box's sites with a detection in the window: looks,
-- [[date, cloud], …], the obscured share of the 640 m square under the
-- site, its clearest scene a date; and each date's brightest detection,
-- its pixels as [b12, lon, lat × 4 corners]. measured on the archive's
-- detections (AGENTS.md)
CREATE OR REPLACE TEMP TABLE pb AS
SELECT cm(lon, lat) AS c, pix(cm(lon, lat)) AS p,
       split_part(scene, '_', 3)[:8] AS date
FROM (SELECT scene, lon, lat FROM db.hotspots
      WHERE lat BETWEEN getvariable('s')
        - 1.5 * getvariable('m') AND getvariable('n') + 1.5 * getvariable('m')
      UNION SELECT scene, lon, lat FROM det)
WHERE near(lon, lat);
-- nodes: the pebbles' pixels in order (n), each with its pebbles (date,
-- x, y); links: two within 40 m, shortest first (r)
CREATE OR REPLACE TEMP TABLE nd AS
SELECT row_number() OVER (ORDER BY p.z, p.x, p.y) AS n, p,
       list({d: date, x: c.x, y: c.y}) AS q
FROM pb GROUP BY p;
CREATE OR REPLACE TEMP TABLE ln AS
SELECT row_number() OVER (ORDER BY l, a.n, b.n) AS r, a.n AS a, b.n AS b
FROM nd a JOIN nd b ON b.p.z = a.p.z AND b.n > a.n
  AND abs(b.p.x - a.p.x) <= 2 AND abs(b.p.y - a.p.y) <= 2,
LATERAL (SELECT (b.p.x - a.p.x) ** 2 + (b.p.y - a.p.y) ** 2 AS l)
WHERE l <= 4;
CREATE OR REPLACE TEMP TABLE gs AS
FROM linked('nd', 'ln', false);
CREATE OR REPLACE TEMP TABLE nds AS SELECT nd.p, gs.s FROM nd JOIN gs USING (n);
-- a site's place: its pebbles' mean, rounded to 40 m, in lon/lat
CREATE OR REPLACE TEMP TABLE st AS
SELECT s, ST_X(q) AS lon, ST_Y(q) AS lat,
       'live:' || printf('%.5f', ST_Y(q)) || ',' || printf('%.5f', ST_X(q))
         AS id
FROM (SELECT s, ST_Transform(ST_Point(round(sum(c.x) / count(*) / 4000) * 40,
        round(sum(c.y) / count(*) / 4000) * 40), any_value(c.z), 'EPSG:4326',
        always_xy := true) AS q
      FROM pb JOIN nds USING (p) GROUP BY s)
WHERE ST_X(q) BETWEEN getvariable('w') AND getvariable('e')
  AND ST_Y(q) BETWEEN getvariable('s') AND getvariable('n');
CREATE OR REPLACE TEMP TABLE hs AS
SELECT h.* EXCLUDE (p), nds.s AS t
FROM (SELECT *, pix(cm(lon, lat)) AS p FROM spots) h JOIN nds USING (p)
SEMI JOIN st ON st.s = nds.s;
-- every scene's squares, in its crs, and the one under each site (ties
-- to the least x, then y)
CREATE OR REPLACE TEMP TABLE sq AS
SELECT scene, v.x, v.y, v.cloud
FROM (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j, cloud))
        AS v FROM held
      UNION ALL SELECT scene, unnest(q) FROM obs);
CREATE OR REPLACE TEMP TABLE lk AS
SELECT t, date, min(cloud) AS cloud
FROM (SELECT pt.s AS t, sc.scene, sc.datetime::DATE AS date,
             arg_min(sq.cloud, ((sq.x - px) ** 2 + (sq.y - py) ** 2, sq.x,
               sq.y)) AS cloud
      FROM (SELECT s, crs, ST_X(p) AS px, ST_Y(p) AS py
            FROM st, (SELECT DISTINCT crs FROM sc), LATERAL (SELECT
              ST_Transform(ST_Point(lon, lat), 'EPSG:4326', crs,
                           always_xy := true) AS p)) pt
      JOIN sc USING (crs)
      JOIN sq ON sq.scene = sc.scene AND abs(sq.x - px) <= 320
        AND abs(sq.y - py) <= 320
      GROUP BY ALL)
GROUP BY ALL;
CREATE OR REPLACE TEMP TABLE out AS
SELECT '{"type":"FeatureCollection","features":['
       || coalesce(string_agg(f, ',' ORDER BY f), '') || ']}' AS geojson
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
                flatten(list_transform(list_transform([[-10, -10],
                  [10, -10], [10, 10], [-10, 10]], lambda c: ll(q, c, crs)),
                  lambda g: [ST_X(g), ST_Y(g)])))))
              ORDER BY date) AS ds
            FROM (FROM hs QUALIFY row_number() OVER (PARTITION BY t, date
                                ORDER BY max_b12 DESC, scene) = 1)
            GROUP BY t) d ON d.t = st.s);
