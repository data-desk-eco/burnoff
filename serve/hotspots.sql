-- the hotspots of each scene over a lon/lat box (w, s, e, n) from t0 to t1,
-- from the store (db, schema.sql) where it holds the scene's cells and off
-- eodata's jp2s where it does not, the cells read written to n, a new
-- sqlite file that query merges into the store. a cell is one of a tile's
-- 6.4 km background cells, counted from its 100 km square's north-west
-- corner (sx, sy), 16 a side; a hotspot is what a read of the whole tile
-- finds wherever a read's edges fall, so a cell's are the same whichever
-- read made them, with a cell's margin read around it; v, the detector's
-- digest, keys what it made. whole asks for
-- every cell of each scene's square, not only the box's. leaves the box's
-- looks and hotspots in tables looks and spots (geojson.sql)

-- the sentinel-2 tile over lon/lat: its 100 km mgrs square, whose latitude
-- band is the one its centre is in, its crs and its north-west corner
CREATE MACRO s2_tile(lon, lat) AS (
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
                    FROM (SELECT floor((lon + 180) / 6)::INT % 60 + 1 AS z)))));
-- a point of the box, k of 9 × 9
CREATE MACRO pt(k) AS ST_Point(
  getvariable('w') + (getvariable('e') - getvariable('w')) * (k % 9) / 8,
  getvariable('s') + (getvariable('n') - getvariable('s')) * (k // 9) / 8);
-- the store's rows for a query, through sqlite's own indexes
CREATE MACRO q(s) AS '''' || string_agg(DISTINCT s, ''',''') || '''';

-- the tiles under the box's points, and their scenes from t0 to t1, one a
-- sensing time, the newest processing; u, the box in the tile's metres
-- (the envelope of its points, as the browser's fit() takes it)
CREATE TEMP TABLE tiles AS
SELECT t.id, t.crs, t.sx, t.sy
FROM (SELECT DISTINCT s2_tile(ST_X(pt(k)), ST_Y(pt(k))) AS t
      FROM range(81) r(k));
SET VARIABLE sq = 'SELECT scene, tile, t, granule FROM scenes WHERE tile IN ('
  || (SELECT q(id) FROM tiles) || ') AND t BETWEEN '''
  || strftime(getvariable('t0'), '%Y%m%d') || ''' AND '''
  || strftime(getvariable('t1'), '%Y%m%d') || 'Z''';
CREATE TEMP TABLE sc AS
SELECT s.scene, s.granule, strptime(s.t, '%Y%m%dT%H%M%S') AS datetime,
       'Sentinel-2/MSI/L1C/' || s.t[1:4] || '/' || s.t[5:6] || '/'
         || s.t[7:8] || '/' || s.scene || '.SAFE/GRANULE/' AS dir,
       'T' || s.tile || '_' || s.t || '_B12.jp2' AS f, t.crs, t.sx, t.sy,
       ST_Envelope(ST_Collect(list_transform(range(81), lambda k:
         ST_Transform(pt(k), 'EPSG:4326', t.crs, always_xy := true)))) AS u
FROM sqlite_query('db', getvariable('sq')) s JOIN tiles t ON t.id = s.tile
QUALIFY row_number() OVER (PARTITION BY s.tile, s.t ORDER BY s.scene DESC) = 1;

-- the cells asked for, their centres and their H3 cell (the archive's
-- partition), and those the store holds
CREATE TEMP TABLE need AS
SELECT scene, i, j, ST_X(p) AS lon, ST_Y(p) AS lat,
       h3_latlng_to_cell_string(ST_Y(p), ST_X(p), 1) AS cell
FROM (SELECT *, ST_Transform(ST_Point(sx + 6400 * i + 3200,
                                      sy - 6400 * j - 3200), crs,
                             'EPSG:4326', always_xy := true) AS p
      FROM (SELECT *, if(getvariable('whole'), 0, greatest(0, floor(
                     (ST_XMin(u) - sx) / 6400)))::INT AS i0,
                   if(getvariable('whole'), 15, least(15, ceil(
                     (ST_XMax(u) - sx) / 6400) - 1))::INT AS i1,
                   if(getvariable('whole'), 0, greatest(0, floor(
                     (sy - ST_YMax(u)) / 6400)))::INT AS j0,
                   if(getvariable('whole'), 15, least(15, ceil(
                     (sy - ST_YMin(u)) / 6400) - 1))::INT AS j1
            FROM sc),
           LATERAL range(i0, i1 + 1) a(i), LATERAL range(j0, j1 + 1) b(j));
SET VARIABLE sq = 'SELECT * FROM cells WHERE scene IN ('
  || coalesce((SELECT q(scene) FROM need), '''''') || ') AND v = '''
  || getvariable('v') || '''';
-- (sqlite_query types an empty answer's columns as text: cast)
CREATE TEMP TABLE held AS
SELECT * FROM (SELECT scene, i::INT AS i, j::INT AS j, sx::DOUBLE AS sx,
                      sy::DOUBLE AS sy, ox::DOUBLE AS ox, oy::DOUBLE AS oy,
                      crs, clear::DOUBLE AS clear,
                      cloud::DOUBLE AS cloud, squares, cell, lon::DOUBLE AS lon,
                      lat::DOUBLE AS lat
               FROM sqlite_query('db', getvariable('sq')))
SEMI JOIN need USING (scene, i, j);

-- one read a scene: the box of its cells lacking and a cell around it, its
-- granule found where the store lacks it
CREATE TEMP TABLE miss AS SELECT * FROM need ANTI JOIN held USING (scene, i, j);
CREATE TEMP TABLE gr AS
SELECT scene, coalesce(granule, regexp_extract(s2_get('s3://eodata/?list-type'
         || '=2&delimiter=/&prefix=' || dir), '/GRANULE/(L1C_[^/<]+)/', 1))
         AS granule
FROM sc WHERE scene IN (SELECT scene FROM miss);
CREATE TEMP TABLE rd AS
SELECT *, s2_detect('s3://eodata/' || dir || granule || '/IMG_DATA/' || f,
                    sx + 6400 * (i0 - 1), sy - 6400 * (j1 + 2),
                    sx + 6400 * (i1 + 2), sy - 6400 * (j0 - 1)) AS r
FROM (SELECT scene, any_value(dir) AS dir, any_value(f) AS f, sx, sy,
             min(i) AS i0, max(i) AS i1, min(j) AS j0, max(j) AS j1
      FROM miss JOIN sc USING (scene) GROUP BY scene, sx, sy)
JOIN gr USING (scene) WHERE granule <> '';

-- the cells read: their squares (cells.sql) and their hotspots, each in
-- its own 100 km square, as s2_hotspots keeps them
CREATE TEMP TABLE obs AS
SELECT *, coalesce(list_avg(list_transform(q, lambda z: z.cloud)), -1)
            AS cloud
FROM (SELECT m.scene, m.i, m.j, s.sx, s.sy,
             origin(r.r.cells[1].x, s.sx) AS ox,
             -origin(-r.r.cells[1].y, -s.sy) AS oy, s.crs, r.r.clear AS clear,
             list_filter(r.r.cells, lambda z: floor((z.x - s.sx) / 6400) = m.i
               AND ceil((s.sy - z.y) / 6400) - 1 = m.j) AS q, m.cell, m.lon,
             m.lat
      FROM miss m JOIN rd r USING (scene) JOIN sc s USING (scene)
      WHERE r.r.error IS NULL);
CREATE TEMP TABLE det AS
SELECT x.scene, o.i, o.j, h.x, h.y, ST_X(p) AS lon, ST_Y(p) AS lat,
       h.max_b12, h.avg_b12, h.peak_b11, h.ratio, h.peakedness, h.pixels,
       h.radiance, h.saturated, h.px, o.cell
FROM (SELECT scene, sx, sy, unnest(r.hotspots) AS h FROM rd
      WHERE r.error IS NULL) x
JOIN obs o ON o.scene = x.scene AND o.i = floor((h.x - x.sx) / 6400)
          AND o.j = ceil((x.sy - h.y) / 6400) - 1,
LATERAL (SELECT ST_Transform(ST_Point(h.x, h.y), o.crs, 'EPSG:4326',
                             always_xy := true) AS p)
WHERE h.x >= x.sx AND h.x < x.sx + 1e5 AND h.y > x.sy - 1e5 AND h.y <= x.sy;

CREATE TABLE n.cells AS
SELECT scene, i, j, getvariable('v') AS v, sx, sy, ox, oy, crs, clear, cloud,
       packed(q, ox, oy, sx, sy, i, j) AS squares,
       cell, lon, lat FROM obs;
CREATE TABLE n.hotspots AS
SELECT * EXCLUDE (px, saturated), saturated::INT AS saturated,
       to_json(px)::VARCHAR AS px, getvariable('v') AS v FROM det;
CREATE TABLE n.granules AS
SELECT split_part(scene, '_', 6)[2:] AS tile, split_part(scene, '_', 3) AS t,
       scene, granule FROM gr WHERE granule <> '';

-- the box's: each scene's look (the obscured share of its squares in the
-- box, -1 without one, or its read's error) and its hotspots in the box
CREATE TEMP TABLE looks AS
SELECT sc.scene, sc.datetime, sc.f[2:6] AS tile, e.error,
       coalesce(avg(v.cloud) FILTER (ST_Intersects(sc.u,
         ST_Point(v.x, v.y))), -1) AS cloud
FROM sc
LEFT JOIN (SELECT scene, unnest(unpacked(squares, ox, oy, sx, sy, i, j,
                                          cloud)) AS v FROM held
           UNION ALL SELECT scene, unnest(q) FROM obs) USING (scene)
LEFT JOIN (SELECT scene, coalesce(r.error, 'no granule') AS error FROM rd
           WHERE r.error IS NOT NULL
           UNION ALL SELECT scene, 'no granule' FROM gr WHERE granule = '') e
  USING (scene)
WHERE sc.scene IN (SELECT scene FROM need)
GROUP BY ALL;
SET VARIABLE sq = 'SELECT * FROM hotspots WHERE scene IN ('
  || coalesce((SELECT q(scene) FROM held), '''''') || ') AND v = '''
  || getvariable('v') || '''';
CREATE TEMP TABLE spots AS
SELECT s.*, sc.datetime, sc.datetime::DATE AS date, sc.crs
FROM (SELECT scene, i::INT AS i, j::INT AS j, x::DOUBLE AS x, y::DOUBLE AS y,
             lon::DOUBLE AS lon, lat::DOUBLE AS lat, max_b12::DOUBLE AS max_b12,
             avg_b12::DOUBLE AS avg_b12, peak_b11::DOUBLE AS peak_b11,
             ratio::DOUBLE AS ratio, peakedness::DOUBLE AS peakedness,
             pixels::INT AS pixels, radiance::DOUBLE AS radiance,
             saturated::INT::BOOLEAN AS saturated, from_json(px, '[{"x":
               "DOUBLE", "y": "DOUBLE", "b12": "DOUBLE"}]') AS px, cell
      FROM sqlite_query('db', getvariable('sq')) SEMI JOIN held
        USING (scene, i, j)
      UNION ALL BY NAME FROM det) s JOIN sc USING (scene)
WHERE s.lon BETWEEN getvariable('w') AND getvariable('e')
  AND s.lat BETWEEN getvariable('s') AND getvariable('n');
