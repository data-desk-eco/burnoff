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
-- nodes: the pebbles' pixels in order (n), each with its pebbles (date,
-- x, y); links: two within 40 m, shortest first (r)
CREATE TEMP TABLE nd AS
SELECT row_number() OVER (ORDER BY p.z, p.x, p.y) AS n, p,
       list({d: date, x: c.x, y: c.y}) AS q
FROM pb GROUP BY p;
CREATE TEMP TABLE ln AS
SELECT row_number() OVER (ORDER BY l, a.n, b.n) AS r, a.n AS a, b.n AS b
FROM nd a JOIN nd b ON b.p.z = a.p.z AND b.n > a.n
  AND abs(b.p.x - a.p.x) <= 2 AND abs(b.p.y - a.p.y) <= 2,
LATERAL (SELECT (b.p.x - a.p.x) ** 2 + (b.p.y - a.p.y) ** 2 AS l)
WHERE l <= 4;
-- linked nodes' components (c, its least node), and each node's place in
-- its own (i), so each component links on its own, all at once
CREATE TEMP TABLE cn AS
WITH RECURSIVE w(n, c) USING KEY (n) AS (
  SELECT n, n FROM nd
  UNION ALL
  SELECT e.y, min(w.c) FROM w JOIN (SELECT a AS x, b AS y FROM ln
    UNION ALL SELECT b, a FROM ln) e ON e.x = w.n
  JOIN recurring.w o ON o.n = e.y WHERE w.c < o.c GROUP BY e.y)
SELECT n, c, row_number() OVER (PARTITION BY c ORDER BY n) AS i FROM w;
CREATE TEMP TABLE lc AS
SELECT x.c, row_number() OVER (PARTITION BY x.c ORDER BY r) AS r,
       x.i AS a, y.i AS b
FROM ln JOIN cn x ON x.n = ln.a JOIN cn y ON y.n = ln.b;
-- each node's site (g[i], its least node): a link joins two sites unless
-- they hold pebbles of one date over 30 m apart
CREATE MACRO grp(q, g, i) AS flatten(list_filter(q, lambda x, j: g[j] = i));
CREATE MACRO clash(u, v) AS list_bool_or(list_transform(u, lambda a:
  list_bool_or(list_transform(v, lambda b: a.d = b.d
    AND (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 3000 ** 2))));
CREATE TEMP TABLE gs AS
WITH RECURSIVE k(c, r, q, g) USING KEY (c) AS (
  SELECT c, 0, list(q ORDER BY i), range(1, count(*) + 1)
  FROM cn JOIN nd USING (n) GROUP BY c
  UNION ALL
  SELECT k.c, k.r + 1, k.q, if(i <> j AND NOT coalesce(clash(grp(k.q, k.g,
           i), grp(k.q, k.g, j)), false), list_transform(k.g, lambda x:
           if(x = j, i, x)), k.g)
  FROM k JOIN lc ON lc.c = k.c AND lc.r = k.r + 1,
  LATERAL (SELECT least(k.g[a], k.g[b]) AS i, greatest(k.g[a], k.g[b]) AS j))
SELECT x.n, y.n AS s FROM k JOIN cn x USING (c) JOIN cn y
  ON y.c = k.c AND y.i = k.g[x.i];
CREATE TEMP TABLE nds AS SELECT nd.p, gs.s FROM nd JOIN gs USING (n);
-- a site's place: its pebbles' mean, rounded to 40 m, in lon/lat
CREATE TEMP TABLE st AS
SELECT s, ST_X(q) AS lon, ST_Y(q) AS lat,
       'live:' || printf('%.5f', ST_Y(q)) || ',' || printf('%.5f', ST_X(q))
         AS id
FROM (SELECT s, ST_Transform(ST_Point(round(sum(c.x) / count(*) / 4000) * 40,
        round(sum(c.y) / count(*) / 4000) * 40), any_value(c.z), 'EPSG:4326',
        always_xy := true) AS q
      FROM pb JOIN nds USING (p) GROUP BY s)
WHERE ST_X(q) BETWEEN getvariable('w') AND getvariable('e')
  AND ST_Y(q) BETWEEN getvariable('s') AND getvariable('n');
CREATE TEMP TABLE hs AS
SELECT h.* EXCLUDE (p), nds.s AS t
FROM (SELECT *, pix(cm(lon, lat)) AS p FROM spots) h JOIN nds USING (p)
SEMI JOIN st ON st.s = nds.s;
-- every scene's squares, in its crs, and the one under each site (ties
-- to the least x, then y)
CREATE TEMP TABLE sq AS
SELECT scene, v.x, v.y, v.cloud
FROM (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j, cloud))
        AS v FROM held
      UNION ALL SELECT scene, unnest(q) FROM obs);
CREATE TEMP TABLE lk AS
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
                flatten(list_transform(list_transform([[-10, -10],
                  [10, -10], [10, 10], [-10, 10]], lambda c: ll(q, c, crs)),
                  lambda g: [ST_X(g), ST_Y(g)])))))
              ORDER BY date) AS ds
            FROM (FROM hs QUALIFY row_number() OVER (PARTITION BY t, date
                                ORDER BY max_b12 DESC, scene) = 1)
            GROUP BY t) d ON d.t = st.s);
