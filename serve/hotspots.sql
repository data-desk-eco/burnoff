-- the hotspots of each scene over a lon/lat box (w, s, e, n) from t0 to t1,
-- from the store (db, schema.sql) where it holds the scene's cells and off
-- eodata's jp2s where it does not, the cells read added to the store in
-- one transaction. a cell is one of a tile's
-- 6.4 km background cells, counted from its 100 km square's north-west
-- corner (sx, sy), 16 a side; a hotspot is what a read of the whole tile
-- finds wherever a read's edges fall, so a cell's are the same whichever
-- read made them, with a cell's margin read around it; v, the detector's
-- digest, keys what it made. whole asks for
-- every cell of each scene's square, not only the box's. box.sql makes the
-- answer's tables from these

-- the tiles under the box's points, and their scenes from t0 to t1, one a
-- sensing time, the newest processing; u, the box in the tile's metres
-- (the envelope of its points, as the browser's fit() takes it). a point's
-- tile is its own zone's where eodata lists it, else a neighbouring
-- zone's: sentinel-2 has none of some, as 43WCV, at yamal lng
CREATE OR REPLACE TEMP TABLE cand AS
SELECT k, dz, s2_tile(ST_X(pt(k)), ST_Y(pt(k)), dz) AS t
FROM range(81) r(k), range(-1, 2) d(dz);
CREATE OR REPLACE TEMP TABLE tiles AS
SELECT DISTINCT t.id, t.crs, t.sx, t.sy
FROM (SELECT arg_min(t, abs(dz)) AS t FROM cand
      WHERE t.id IN (SELECT tile FROM db.scenes WHERE tile IN (SELECT t.id
                                                         FROM cand))
      GROUP BY k);
CREATE OR REPLACE TEMP TABLE sc AS
SELECT s.scene, g.granule, strptime(s.t, '%Y%m%dT%H%M%S') AS datetime,
       'Sentinel-2/MSI/L1C/' || s.t[1:4] || '/' || s.t[5:6] || '/'
         || s.t[7:8] || '/' || s.scene || '.SAFE/GRANULE/' AS dir,
       'T' || s.tile || '_' || s.t || '_B12.jp2' AS f, t.crs, t.sx, t.sy,
       ST_Envelope(ST_Collect(list_transform(range(81), lambda k:
         ST_Transform(pt(k), 'EPSG:4326', t.crs, always_xy := true)))) AS u
FROM db.scenes s JOIN tiles t ON t.id = s.tile
LEFT JOIN (SELECT DISTINCT scene, granule FROM db.granules) g USING (scene)
WHERE s.t BETWEEN strftime(getvariable('t0'), '%Y%m%d')
              AND strftime(getvariable('t1'), '%Y%m%d') || 'Z'
QUALIFY row_number() OVER (PARTITION BY s.tile, s.t ORDER BY s.scene DESC) = 1;

-- the cells asked for, their centres and their H3 cell (the archive's
-- partition), and those the store holds
CREATE OR REPLACE TEMP TABLE need AS
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
-- (a cell read by two requests at once is kept twice: distinct)
CREATE OR REPLACE TEMP TABLE held AS
SELECT DISTINCT * EXCLUDE (tile, t, v)
FROM db.cells SEMI JOIN need USING (scene, i, j)
WHERE tile IN (SELECT id FROM tiles) AND v = getvariable('v')
  AND t BETWEEN strftime(getvariable('t0'), '%Y%m%d')
            AND strftime(getvariable('t1'), '%Y%m%d') || 'Z';

-- one read a scene: the box of its cells lacking and a cell around it, its
-- granule found where the store lacks it
CREATE OR REPLACE TEMP TABLE miss AS
SELECT * FROM need ANTI JOIN held USING (scene, i, j);
CREATE OR REPLACE TEMP TABLE gr AS
SELECT scene, coalesce(granule, regexp_extract(s2_get('s3://eodata/?list-type'
         || '=2&delimiter=/&prefix=' || dir), '/GRANULE/(L1C_[^/<]+)/', 1))
         AS granule
FROM sc WHERE scene IN (SELECT scene FROM miss);
CREATE OR REPLACE TEMP TABLE rd AS
SELECT *, s2_detect('s3://eodata/' || dir || granule || '/IMG_DATA/' || f,
                    sx + 6400 * (i0 - 1), sy - 6400 * (j1 + 2),
                    sx + 6400 * (i1 + 2), sy - 6400 * (j0 - 1)) AS r
FROM (SELECT scene, any_value(dir) AS dir, any_value(f) AS f, sx, sy,
             min(i) AS i0, max(i) AS i1, min(j) AS j0, max(j) AS j1
      FROM miss JOIN sc USING (scene) GROUP BY scene, sx, sy)
JOIN gr USING (scene) WHERE granule <> '';

-- the cells read: their squares (cells.sql) and their hotspots, each in
-- its own 100 km square, as s2_hotspots keeps them. a read's squares are
-- split by cell in one pass, in its order, and its origin taken once
CREATE OR REPLACE TEMP TABLE rq AS
SELECT scene, floor((z.x - sx) / 6400) AS i, ceil((sy - z.y) / 6400) - 1 AS j,
       list(z ORDER BY k) AS q
FROM (SELECT scene, sx, sy, unnest(r.cells) AS z,
             generate_subscripts(r.cells, 1) AS k FROM rd WHERE r.error IS NULL)
GROUP BY ALL;
CREATE OR REPLACE TEMP TABLE ro AS
SELECT scene, origin(r.cells[1].x, sx) AS ox, -origin(-r.cells[1].y, -sy) AS oy,
       r.clear AS clear FROM rd WHERE r.error IS NULL;
CREATE OR REPLACE TEMP TABLE obs AS
SELECT *, coalesce(list_avg(list_transform(q, lambda z: z.cloud)), -1)
            AS cloud
FROM (SELECT m.scene, m.i, m.j, s.sx, s.sy, r.ox, r.oy, s.crs, r.clear,
             coalesce(q.q, []) AS q, m.cell, m.lon, m.lat
      FROM miss m JOIN ro r USING (scene) JOIN sc s USING (scene)
      LEFT JOIN rq q ON q.scene = m.scene AND q.i = m.i AND q.j = m.j);
CREATE OR REPLACE TEMP TABLE det AS
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

-- what the store lacks of them, the cells with their hotspots, at once
BEGIN;
INSERT INTO db.cells BY NAME
SELECT split_part(scene, '_', 6)[2:] AS tile, split_part(scene, '_', 3) AS t,
       scene, i, j, getvariable('v') AS v, sx, sy, ox, oy, crs, clear, cloud,
       packed(q, ox, oy, sx, sy, i, j) AS squares, cell, lon, lat
FROM obs ANTI JOIN (FROM db.cells WHERE v = getvariable('v'))
  USING (scene, i, j);
INSERT INTO db.hotspots BY NAME
SELECT * EXCLUDE (px, saturated), saturated::INT AS saturated,
       to_json(px)::VARCHAR AS px, getvariable('v') AS v
FROM det ANTI JOIN (FROM db.hotspots WHERE v = getvariable('v'))
  USING (scene, x, y);
INSERT INTO db.granules
SELECT scene, granule FROM gr WHERE granule <> ''
  AND scene NOT IN (SELECT scene FROM db.granules);
COMMIT;
