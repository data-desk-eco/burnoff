-- the store's cells and hotspots into the archive (arc), one file a
-- partition, each its rows in order: observations, a scene's cell with its
-- 640 m squares, and detections, a hotspot with its pixels as a
-- multipolygon (geometry)
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
COPY (SELECT scene, sensed(scene) AS datetime, sensed(scene)::DATE AS date,
             split_part(scene, '_', 6)[2:] AS tile, i, j, sx, sy, ox, oy, crs,
             clear,
             cloud, unpacked(squares, ox, oy, sx, sy, i, j, cloud) AS squares,
             lon, lat, cell
      FROM c ORDER BY cell, scene, i, j)
TO (getvariable('arc') || '/observations') (FORMAT parquet,
  COMPRESSION zstd, PARTITION_BY (cell), WRITE_PARTITION_COLUMNS true,
  FILENAME_PATTERN 'data', OVERWRITE_OR_IGNORE);
COPY (SELECT h.scene, sensed(h.scene) AS datetime,
             sensed(h.scene)::DATE AS date,
             split_part(h.scene, '_', 6)[2:] AS tile, h.* EXCLUDE (scene, px,
               saturated, cell, v), h.saturated::BOOLEAN AS saturated, p.px,
             ST_Transform(ST_Collect(list_transform(p.px, lambda q:
               ST_MakeEnvelope(q.x - 10, q.y - 10, q.x + 10, q.y + 10))),
               c.crs, 'EPSG:4326', always_xy := true) AS geometry, h.cell
      FROM h JOIN c USING (scene, i, j),
           LATERAL (SELECT from_json(h.px, '[{"x": "DOUBLE", "y": "DOUBLE",
             "b12": "DOUBLE"}]') AS px) p
      ORDER BY h.cell, h.scene, h.x, h.y)
TO (getvariable('arc') || '/detections') (FORMAT parquet, COMPRESSION zstd,
  PARTITION_BY (cell), WRITE_PARTITION_COLUMNS true,
  FILENAME_PATTERN 'data', OVERWRITE_OR_IGNORE);
