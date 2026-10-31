-- hotspots.sql's box, for an answer: each scene's look (the obscured share
-- of its squares in the box, -1 without one, or its read's error) and its
-- hotspots in the box, and those within m of it, in tables looks and spots
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
-- m: how far past the box spots reach, in degrees of latitude (about
-- 550 m), so sites.sql sees every link to the box's sites
SET VARIABLE m = .005;
-- (+v: sqlite seeks the scenes' keys, not every hotspot of v by lat)
SET VARIABLE sq = 'SELECT * FROM hotspots WHERE scene IN ('
  || coalesce((SELECT q(scene) FROM held), '''''') || ') AND +v = '''
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
WHERE s.lat BETWEEN getvariable('s') - getvariable('m')
  AND getvariable('n') + getvariable('m')
  AND s.lon BETWEEN getvariable('w') - getvariable('m') / cos(radians(s.lat))
  AND getvariable('e') + getvariable('m') / cos(radians(s.lat));
