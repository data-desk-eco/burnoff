-- the service's macros, made once at its start (server.sql) for every
-- query's connection: hotspots.sql's and sites.sql's, and the gate

-- the sentinel-2 tile over lon/lat in its utm zone moved by dz: its 100 km
-- mgrs square, whose latitude band is the one its centre is in, its crs and
-- its north-west corner
CREATE MACRO s2_tile(lon, lat, dz) AS (
  SELECT {id: printf('%02d', z) || 'CDEFGHJKLMNPQRSTUVWX'[least(greatest(
            floor((ST_Y(ST_Transform(ST_Point(c * 1e5 + 5e4, r * 1e5 + 5e4),
            crs, 'EPSG:4326', always_xy := true)) + 80) / 8), 0), 19)::INT + 1]
          || 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(z - 1) % 3 * 8 + greatest(c, 1)]
          || 'ABCDEFGHJKLMNPQRSTUV'[(r + if(z % 2 = 1, 0, 5)) % 20 + 1],
          crs: crs, sx: c * 1e5, sy: (r + 1) * 1e5}
  FROM (SELECT *, floor(ST_X(p) / 1e5)::INT AS c,
               floor(ST_Y(p) / 1e5)::INT AS r
        FROM (SELECT *, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', crs,
                                     always_xy := true) AS p
              FROM (SELECT z, 'EPSG:' || (if(lat < 0, 32700, 32600) + z) AS crs
                    FROM (SELECT (floor((lon + 180) / 6)::INT + dz + 60)
                                 % 60 + 1 AS z)))));
-- a point of the box, k of 9 × 9
CREATE MACRO pt(k) AS ST_Point(
  getvariable('w') + (getvariable('e') - getvariable('w')) * (k % 9) / 8,
  getvariable('s') + (getvariable('n') - getvariable('s')) * (k // 9) / 8);
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
CREATE MACRO grp(q, g, i) AS flatten(list_filter(q, lambda x, j: g[j] = i));
CREATE MACRO clash(u, v, same_granule) AS
  list_bool_or(list_transform(u, lambda a:
  list_bool_or(list_transform(v, lambda b: a.d = b.d AND (same_granule
    OR (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 3000 ** 2)))));

-- Constrained single linkage over ordered nodes and links. S2 rejects
-- same-date pairs over 30 m apart; S3 rejects every same-granule pair.
CREATE MACRO linked(nodes, links, same_granule) AS TABLE
WITH RECURSIVE
nd AS (FROM query_table(nodes)), ln AS (FROM query_table(links)),
w(n, c) USING KEY (n) AS (
  SELECT n, n FROM nd
  UNION ALL
  SELECT e.y, min(w.c) FROM w JOIN (SELECT a AS x, b AS y FROM ln
    UNION ALL SELECT b, a FROM ln) e ON e.x = w.n
  JOIN recurring.w o ON o.n = e.y WHERE w.c < o.c GROUP BY e.y),
cn AS (
  SELECT n, c, row_number() OVER (PARTITION BY c ORDER BY n) AS i FROM w),
lc AS (
  SELECT x.c, row_number() OVER (PARTITION BY x.c ORDER BY r) AS r,
         x.i AS a, y.i AS b
  FROM ln JOIN cn x ON x.n = ln.a JOIN cn y ON y.n = ln.b),
k(c, r, q, g) USING KEY (c) AS (
  SELECT c, 0, list(q ORDER BY i), range(1, count(*) + 1)
  FROM cn JOIN nd USING (n) GROUP BY c
  UNION ALL
  SELECT k.c, k.r + 1, k.q, if(i <> j AND NOT coalesce(clash(grp(k.q, k.g,
           i), grp(k.q, k.g, j), same_granule), false),
           list_transform(k.g, lambda x: if(x = j, i, x)), k.g)
  FROM k JOIN lc ON lc.c = k.c AND lc.r = k.r + 1,
  LATERAL (SELECT least(k.g[a], k.g[b]) AS i, greatest(k.g[a], k.g[b]) AS j))
SELECT x.n, y.n AS s FROM k JOIN cn x USING (c) JOIN cn y
  ON y.c = k.c AND y.i = k.g[x.i];

-- sentinel-3's: the local evening a granule's look falls in, at lon (its
-- local solar time less 12 h: slstr passes at about 22:00), from its
-- sensing time t (yyyymmddThhmmss); and a granule's directory as read (a
-- test may read another mirror)
CREATE MACRO s3night(t, lon) AS (strptime(t, '%Y%m%dT%H%M%S')
  + to_microseconds((lon / 15 * 3600e6)::BIGINT) - INTERVAL 12 HOUR)::DATE;
CREATE MACRO s3url(dir) AS dir;
-- a hotspot's place, corrected: the l1b puts a flare off by its platform
-- and its column from the sub-satellite track (s3_detect's track, 500 m
-- pixels), east and north by a + b t + c t² m, t = track / 1000, as fitted
-- to 60 isolated, persistent s2 flares over 2023-2026 (AGENTS.md); in t
-- s3a turns ~0.14° (1.9 km north at one edge to 0.45 km south at the other)
CREATE MACRO s3c(g) AS CASE g[1:3]
  WHEN 'S3A' THEN [[153.7, 377.3, 573.6], [271.4, -1276.1, 17.9]]
  WHEN 'S3B' THEN [[-298.2, 6.8, -231.9], [309.3, 226.6, 71.0]]
  ELSE [[0, 0, 0], [0, 0, 0]] END;
CREATE MACRO s3m(c, t) AS c[1] + c[2] * t + c[3] * t * t;
CREATE MACRO s3lon(g, tr, lon, lat) AS lon - s3m(s3c(g)[1], tr / 1000)
  / (111320 * cos(radians(lat)));
CREATE MACRO s3lat(g, tr, lat) AS lat - s3m(s3c(g)[2], tr / 1000) / 110540;
-- and drawn as one pixel, [[rh, lon, lat × 4 corners]]: a flare is tens of
-- metres, so a cluster is one fire spread by the optics, and the corrected
-- place a better guess at it than any pixel's own. its brightest pixel
-- (s3_detect's px, the first if none has heat), moved to centre on it
CREATE MACRO s3pk(ps) AS ps[list_position(list_transform(ps, lambda q:
  coalesce(q[1], 0)), list_max(list_transform(ps, lambda q:
  coalesce(q[1], 0))))];
CREATE MACRO s3sq(p, rh, lon, lat) AS [[rh] || list_transform(p[2:],
  lambda v, k: round(v + if(k % 2 = 1, lon - (p[2] + p[4] + p[6] + p[8]) / 4,
                            lat - (p[3] + p[5] + p[7] + p[9]) / 4), 6))];
-- a request's hotspots as placed: the store's within 0.05° (more than any
-- correction) of the box, and what it read (h)
CREATE MACRO s3at(h) AS TABLE
SELECT * REPLACE (s3lon(granule, track, lon, lat) AS lon,
                  s3lat(granule, track, lat) AS lat,
                  s3sq(s3pk(from_json(px, '[["DOUBLE"]]')), rh,
                       s3lon(granule, track, lon, lat),
                       s3lat(granule, track, lat)) AS px)
FROM (SELECT * EXCLUDE (v) FROM db.s3_hotspots
      WHERE lat BETWEEN getvariable('s') - .05 AND getvariable('n') + .05
        AND lon BETWEEN getvariable('w') - .05 / cos(radians(lat))
                    AND getvariable('e') + .05 / cos(radians(lat))
      UNION ALL BY NAME FROM query_table(h));
-- the gate (quack_authorization_function), on each query: a script of
-- bulk, index or export (q) after 'admin <key>' and a line, run as it is;
-- a public one only as `FROM s2_hotspots(w, s, e, n[, 'a', 'b'])` or the
-- same of s2_sites, run as args.sql, hotspots.sql, box.sql and geojson.sql or
-- sites.sql, over those, or of s3_hotspots or s3_sites, run as s3args.sql,
-- s3hotspots.sql, s3box.sql and s3geojson.sql or s3sites.sql, then
-- answer.sql; or, where the store keeps its answer fresh, that answer
-- alone; anything else refused. days: how long a window's end goes on
-- gaining products (index.sh lists a week again, s3hotspots.sql searches 3
-- days again)
CREATE TABLE cfg AS
SELECT getenv('KEY') AS k, getenv('V') AS v, getenv('V3') AS v3;
SELECT error('KEY unset or short') FROM cfg WHERE coalesce(len(k), 0) < 16;
CREATE TABLE api AS
SELECT f, any_value(days) AS days, string_agg(content, chr(10) ORDER BY o)
         AS body
FROM (SELECT parse_filename(filename, true) AS n, content
      FROM read_text('*.sql')),
     (VALUES ('s2_hotspots', '', 'geojson', 8), ('s2_sites', '', 'sites', 8),
             ('s3_hotspots', 's3', 'geojson', 3),
             ('s3_sites', 's3', 'sites', 3)) a(f, p, l, days),
     LATERAL (SELECT list_position(list_transform(['args', 'hotspots',
       'box', l], lambda x: p || x) || ['answer'], n) AS o)
WHERE o IS NOT NULL GROUP BY f;
CREATE MACRO call(q) AS regexp_extract(q,
  '^FROM (s[23]_hotspots|s[23]_sites)\(' ||
  '([-0-9.]+), ?([-0-9.]+), ?([-0-9.]+), ?([-0-9.]+)' ||
  '(?:, ?''([0-9-]{10}|\.\.)'', ?''([0-9-]{10}|\.\.)'')?\)$',
  ['f', 'w', 's', 'e', 'n', 'a', 'b']);
-- a window's end x, or d where it is open ('..') or left out: the window
-- is the last 90 days by default
CREATE MACRO day(x, d) AS coalesce(TRY_CAST(nullif(x, '..') AS DATE), d);
-- an answer kept (answer.sql) is given while fresh: no other request's
-- read has touched within 0.1° of its box (past any
-- cell or link that reaches it) since it began, and, for a window ending
-- within days of today or where a read failed, for an hour. or while
-- another request makes it again (a row with no geojson yet, under 2
-- minutes old), so a crowd waits on one
CREATE MACRO fresh(key, w, s, e, n, t1, days) AS coalesce((
  SELECT ka > coalesce((SELECT max(t.made)
    FROM db.touched t WHERE t.k IS DISTINCT FROM key
      AND t.y0 <= n + .1 AND t.y1 >= s - .1
      AND t.x0 <= e + .1 / cos(radians(least(greatest(abs(s), abs(n)), 85)))
      AND t.x1 >= w - .1 / cos(radians(least(greatest(abs(s), abs(n)), 85)))),
    '-infinity'::TIMESTAMPTZ)
    AND (t1 < current_date - days AND NOT kr OR ka > now() - INTERVAL 1 HOUR)
    OR km > ka AND km > now() - INTERVAL 2 MINUTE
  FROM (SELECT max(made) FILTER (geojson IS NOT NULL) AS ka,
               arg_max(retry, made) FILTER (geojson IS NOT NULL) AS kr,
               max(made) FILTER (geojson IS NULL) AS km
        FROM db.answers WHERE k = key)), false);
CREATE MACRO gate(sid, q) AS CASE
  WHEN starts_with(q, (SELECT 'admin ' || k || chr(10) FROM cfg))
    THEN q[(SELECT len(k) FROM cfg) + 8:]
  WHEN call(q).f <> '' THEN (SELECT if(fresh(r.k, c.w::DOUBLE,
      c.s::DOUBLE, c.e::DOUBLE, c.n::DOUBLE, r.t1, days),
    printf('SELECT geojson FROM db.answers
WHERE k = ''%s'' AND geojson IS NOT NULL ORDER BY made DESC LIMIT 1;', r.k),
    printf('SET VARIABLE began = now(); SET VARIABLE k = ''%s'';
INSERT INTO db.answers SELECT getvariable(''k''), getvariable(''began''),
  NULL, NULL;
SET VARIABLE v = ''%s''; SET VARIABLE w = %s; SET VARIABLE s = %s;
SET VARIABLE e = %s; SET VARIABLE n = %s;
SET VARIABLE t0 = DATE ''%s''; SET VARIABLE t1 = DATE ''%s'';
', r.k, r.v, c.w, c.s, c.e, c.n, r.t0, r.t1) || body)
    FROM api, (SELECT call(q) AS c),
    LATERAL (SELECT *, concat_ws(' ', c.f, c.w, c.s, c.e, c.n, t0, t1, v) AS k
      FROM (SELECT day(c.a, current_date - 90) AS t0,
                   day(c.b, current_date) AS t1,
                   if(c.f[:2] = 's3', v3, v) AS v FROM cfg)) r
    WHERE api.f = c.f) END;
