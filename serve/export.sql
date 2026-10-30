-- the store's cells and hotspots merged into the archive (arc), one file a
-- partition, each its rows in order: observations, a scene's cell with its
-- 640 m squares, and detections, a hotspot with its pixels as a
-- multipolygon (geometry). the archive is the record: a partition is
-- rewritten as its rows with the store's in place of the archive's for each
-- scene's cell the store holds, so a run again changes nothing and a store
-- lost and begun again takes nothing away. an empty store is seeded from it
SET VARIABLE seed = (SELECT count(scene) = 0 FROM db.cells);
-- the current detector's (v) alone, of each tile and sensing time its
-- newest processing (a reprocessing read after the first is kept, as a
-- request reads the newest), and nothing written unless every hotspot has
-- its cell and every cell is one of its square's 16 × 16
CREATE TEMP TABLE c AS
SELECT * FROM db.cells WHERE v = getvariable('v')
QUALIFY scene = max(scene) OVER (PARTITION BY split_part(scene, '_', 6),
                                              split_part(scene, '_', 3));
CREATE TEMP TABLE h AS
SELECT * FROM db.hotspots WHERE v = getvariable('v')
  AND scene IN (SELECT scene FROM c);
SELECT error('export: ' || count(*) || ' hotspots without their cell')
FROM (FROM h ANTI JOIN c USING (scene, i, j)) HAVING count(*) > 0;
SELECT error('export: ' || count(*) || ' cells off their square')
FROM c WHERE i NOT BETWEEN 0 AND 15 OR j NOT BETWEEN 0 AND 15
HAVING count(*) > 0;
SELECT error('export: ' || count(*) || ' hotspots off their cell')
FROM h JOIN c USING (scene, i, j)
WHERE floor((h.x - c.sx) / 6400) <> i OR ceil((c.sy - h.y) / 6400) - 1 <> j
   OR h.x < c.sx OR h.x >= c.sx + 1e5 OR h.y <= c.sy - 1e5 OR h.y > c.sy
HAVING count(*) > 0;

CREATE MACRO sensed(scene) AS strptime(split_part(scene, '_', 3),
                                     '%Y%m%dT%H%M%S');
CREATE MACRO arc(t) AS TABLE FROM read_parquet(getvariable('arc') || '/' || t
  || '/*/*.parquet', union_by_name := true, hive_partitioning := false);
-- the archive's rows of the store's partitions, bar the scenes' cells it
-- holds afresh
CREATE MACRO kept(t) AS TABLE FROM arc(t) ANTI JOIN c USING (scene, i, j)
  WHERE cell IN (SELECT cell FROM c);
CREATE TEMP TABLE o AS
FROM (SELECT scene, sensed(scene) AS datetime, sensed(scene)::DATE AS date,
             split_part(scene, '_', 6)[2:] AS tile, i, j, sx, sy, ox, oy, crs,
             clear, cloud,
             unpacked(squares, ox, oy, sx, sy, i, j, cloud) AS squares,
             lon, lat, cell, v
      FROM c
      UNION ALL BY NAME FROM kept('observations'))
QUALIFY scene = max(scene) OVER (PARTITION BY split_part(scene, '_', 6),
                                              split_part(scene, '_', 3));
COPY (FROM o ORDER BY cell, scene, i, j)
TO (getvariable('arc') || '/observations') (FORMAT parquet,
  COMPRESSION zstd, PARTITION_BY (cell), WRITE_PARTITION_COLUMNS true,
  FILENAME_PATTERN 'data', OVERWRITE_OR_IGNORE);
COPY (FROM (SELECT h.scene, sensed(h.scene) AS datetime,
                   sensed(h.scene)::DATE AS date,
                   split_part(h.scene, '_', 6)[2:] AS tile, h.* EXCLUDE (scene,
                     px, saturated), h.saturated::BOOLEAN AS saturated, p.px,
                   ST_Transform(ST_Collect(list_transform(p.px, lambda q:
                     ST_MakeEnvelope(q.x - 10, q.y - 10, q.x + 10, q.y + 10))),
                     c.crs, 'EPSG:4326', always_xy := true) AS geometry
            FROM h JOIN c USING (scene, i, j),
                 LATERAL (SELECT from_json(h.px, '[{"x": "DOUBLE",
                   "y": "DOUBLE", "b12": "DOUBLE"}]') AS px) p
            UNION ALL BY NAME FROM kept('detections'))
      WHERE scene IN (SELECT scene FROM o) ORDER BY cell, scene, x, y)
TO (getvariable('arc') || '/detections') (FORMAT parquet, COMPRESSION zstd,
  PARTITION_BY (cell), WRITE_PARTITION_COLUMNS true,
  FILENAME_PATTERN 'data', OVERWRITE_OR_IGNORE);

-- the seed: the current detector's rows (v) as the store keeps them
BEGIN;
INSERT INTO db.cells BY NAME
SELECT scene, i, j, v, sx, sy, ox, oy, crs, clear, cloud, cell, lon, lat,
       packed(squares, ox, oy, sx, sy, i, j) AS squares
FROM arc('observations') WHERE getvariable('seed') AND v = getvariable('v');
INSERT INTO db.hotspots BY NAME
SELECT * EXCLUDE (datetime, date, tile, px, saturated, geometry),
       saturated::INTEGER AS saturated, to_json(px)::VARCHAR AS px
FROM arc('detections') WHERE getvariable('seed') AND v = getvariable('v');
COMMIT;
