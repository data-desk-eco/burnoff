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
CREATE MACRO clash(u, v) AS list_bool_or(list_transform(u, lambda a:
  list_bool_or(list_transform(v, lambda b: a.d = b.d
    AND (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 3000 ** 2))));

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
-- a request's hotspots as placed: the store's, of the current detector,
-- within 0.05° (more than any correction) of the box, and what it read (h)
CREATE MACRO s3at(h) AS TABLE
SELECT * REPLACE (s3lon(granule, track, lon, lat) AS lon,
                  s3lat(granule, track, lat) AS lat)
FROM (SELECT * EXCLUDE (v) FROM db.s3_hotspots WHERE v = getvariable('v')
        AND lat BETWEEN getvariable('s') - .05 AND getvariable('n') + .05
      UNION ALL BY NAME FROM query_table(h));
-- s3sites.sql's: two sites holding pebbles of one granule, two flares lit
-- at once
CREATE MACRO clash3(u, v) AS list_bool_or(list_transform(u, lambda a:
  list_contains(list_transform(v, lambda b: b.d), a.d)));

-- the gate (quack_authorization_function), on each query: a script of
-- bulk, index or export (q) after 'admin <key>' and a line, run as it is;
-- a public one only as `FROM hotspots(w, s, e, n[, 'a', 'b'])` or the same
-- of sites, run as args.sql, hotspots.sql, box.sql and geojson.sql or
-- sites.sql, over those, or of s3_hotspots or s3_sites, run as s3args.sql,
-- s3hotspots.sql, s3box.sql and s3geojson.sql or s3sites.sql; anything
-- else refused
CREATE TABLE cfg AS
SELECT getenv('KEY') AS k, getenv('V') AS v, getenv('V3') AS v3;
SELECT error('KEY unset or short') FROM cfg WHERE coalesce(len(k), 0) < 16;
CREATE TABLE api AS
SELECT f, string_agg(content, chr(10) ORDER BY o) AS body
FROM (SELECT parse_filename(filename, true) AS n, content
      FROM read_text('*.sql')),
     (VALUES ('hotspots', '', 'geojson'), ('sites', '', 'sites'),
             ('s3_hotspots', 's3', 'geojson'), ('s3_sites', 's3', 'sites'))
       a(f, p, l),
     LATERAL (SELECT list_position(list_transform(['args', 'hotspots',
       'box', l], lambda x: p || x), n) AS o)
WHERE o IS NOT NULL GROUP BY f;
CREATE MACRO call(q) AS regexp_extract(q,
  '^FROM (hotspots|sites|s3_hotspots|s3_sites)\(' ||
  '([-0-9.]+), ?([-0-9.]+), ?([-0-9.]+), ?([-0-9.]+)' ||
  '(?:, ?''([0-9-]{10}|\.\.)'', ?''([0-9-]{10}|\.\.)'')?\)$',
  ['f', 'w', 's', 'e', 'n', 'a', 'b']);
CREATE MACRO gate(sid, q) AS CASE
  WHEN starts_with(q, (SELECT 'admin ' || k || chr(10) FROM cfg))
    THEN q[(SELECT len(k) FROM cfg) + 8:]
  WHEN call(q).f <> '' THEN (SELECT printf('SET VARIABLE v = ''%s'';
SET VARIABLE w = %s; SET VARIABLE s = %s; SET VARIABLE e = %s;
SET VARIABLE n = %s; SET VARIABLE a = ''%s''; SET VARIABLE b = ''%s'';
', if(c.f[:2] = 's3', v3, v), c.w, c.s, c.e, c.n, c.a, c.b) || body
    FROM cfg, api, (SELECT call(q) AS c) WHERE api.f = c.f) END;
