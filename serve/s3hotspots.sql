-- sentinel-3's hotspots by night over a lon/lat box (w, s, e, n) from t0 to
-- t1, from the store (schema.sql) where it holds the box's 0.1° cells for a
-- granule and off eodata's l1b where it does not, one s3_detect a granule
-- over the cells it lacks; what is read is split by cell and added in one
-- transaction. s3box.sql makes the answer's tables from these

-- the granules: cdse's catalogue searched for the box's 1° squares on the
-- days the store has not searched them, 30 days a search (a page holds
-- 1000, and a square at 70° sees ~15 granules a day); a day three days gone
-- is not searched again
CREATE OR REPLACE TEMP TABLE sqs AS
SELECT x, y, x || ',' || y AS sq
FROM range(floor(getvariable('w'))::INT, floor(getvariable('e'))::INT + 1)
       a(x),
     range(floor(getvariable('s'))::INT, floor(getvariable('n'))::INT + 1)
       b(y);
CREATE OR REPLACE TEMP TABLE srch AS
SELECT sq, x, y, min(d)::DATE AS a, max(d)::DATE AS b
FROM (SELECT * FROM sqs, generate_series(getvariable('t0')::TIMESTAMP,
        getvariable('t1')::TIMESTAMP, INTERVAL 1 DAY) g(d)
      ANTI JOIN db.s3_searched s ON s.sq = sqs.sq
        AND s.day = strftime(g.d, '%Y-%m-%d'))
GROUP BY sq, x, y, datediff('day', getvariable('t0'), d) // 30;
CREATE OR REPLACE TEMP TABLE found AS
SELECT f ->> '$.id' AS granule, (f ->> '$.id')[17:31] AS t,
       regexp_replace(f ->> '$.assets.S5_radiance_an.href',
                      '/S5_radiance_an.nc$', '') AS dir,
       (f -> '$.bbox' ->> 0)::DOUBLE AS w, (f -> '$.bbox' ->> 1)::DOUBLE AS s,
       (f -> '$.bbox' ->> 2)::DOUBLE AS e, (f -> '$.bbox' ->> 3)::DOUBLE AS n
FROM (SELECT unnest((j -> '$.features')::JSON[]) AS f
      FROM (SELECT s2_get('https://stac.dataspace.copernicus.eu/v1/search'
              || '?collections=sentinel-3-sl-1-rbt-ntc&limit=1000&bbox='
              || x || ',' || y || ',' || (x + 1) || ',' || (y + 1)
              || '&datetime=' || a || 'T00:00:00Z/' || b || 'T23:59:59Z'
              || '&fields=id,bbox,assets.S5_radiance_an.href')::JSON AS j
            FROM srch)
      WHERE if(list_contains(list_transform((j -> '$.links')::JSON[],
              lambda l: l ->> 'rel'), 'next'),
               error('a catalogue search came back full'), true));

-- the box's granules from t0 to t1: an orbit processed twice its newest
-- baseline's (2017's reprocessing cut new frames), a granule processed twice
-- its newest processing
CREATE OR REPLACE TEMP TABLE gr AS
SELECT * FROM (SELECT DISTINCT * FROM db.s3_granules
               UNION SELECT * FROM found)
WHERE t BETWEEN strftime(getvariable('t0'), '%Y%m%d')
            AND strftime(getvariable('t1'), '%Y%m%d') || 'Z'
  AND w <= getvariable('e') AND e >= getvariable('w')
  AND s <= getvariable('n') AND n >= getvariable('s')
QUALIFY granule[-3:] = max(granule[-3:]) OVER (PARTITION BY granule[1:3],
                                                granule[70:76])
    AND row_number() OVER (PARTITION BY granule[1:3], t
                           ORDER BY granule[49:63] DESC) = 1;

-- the cells asked for, a granule, and those the store holds
CREATE OR REPLACE TEMP TABLE need AS
SELECT granule, t, i, j FROM gr,
  range(floor(round(getvariable('w') * 10, 6))::INT,
        ceil(round(getvariable('e') * 10, 6))::INT) a(i),
  range(floor(round(getvariable('s') * 10, 6))::INT,
        ceil(round(getvariable('n') * 10, 6))::INT) b(j);
CREATE OR REPLACE TEMP TABLE held AS
SELECT DISTINCT * EXCLUDE (v) FROM db.s3_cells SEMI JOIN need
  USING (granule, i, j)
WHERE v = getvariable('v')
  AND t BETWEEN strftime(getvariable('t0'), '%Y%m%d')
            AND strftime(getvariable('t1'), '%Y%m%d') || 'Z';

-- one read a granule, over the box of the cells it lacks
CREATE OR REPLACE TEMP TABLE miss AS
SELECT * FROM need ANTI JOIN held USING (granule, i, j);
CREATE OR REPLACE TEMP TABLE rd AS
SELECT granule, t, s3_detect(s3url(dir), i0 / 10, j0 / 10, (i1 + 1) / 10,
                             (j1 + 1) / 10) AS r
FROM (SELECT granule, t, min(i) AS i0, max(i) AS i1, min(j) AS j0,
             max(j) AS j1
      FROM miss GROUP BY ALL) JOIN gr USING (granule, t);

-- what was read, by cell: its squares (each in its cell's 5 × 5, row by row
-- from the south-west) and its hotspots, the lacking cells alone
CREATE OR REPLACE TEMP TABLE sqr AS
SELECT granule, i, j, (round(q.lat * 50)::INT - j * 5) * 5
         + round(q.lon * 50)::INT - i * 5 AS k, q.pixels, q.clear
FROM (SELECT granule, unnest(r.squares) AS q FROM rd WHERE r.error IS NULL),
LATERAL (SELECT floor(round(q.lon * 10, 6))::INT AS i,
                floor(round(q.lat * 10, 6))::INT AS j);
CREATE OR REPLACE TEMP TABLE obs AS
SELECT m.granule, m.t, m.i, m.j, d.r.sza AS sza,
       coalesce(sum(q.pixels), 0)::INT AS pixels,
       sum(q.pixels * q.clear) / sum(q.pixels) AS clear,
       CASE WHEN count(q.k) > 0 THEN to_json(list_transform(range(25),
         lambda k: list_filter(list(CASE WHEN q.k IS NOT NULL
           THEN {k: q.k, v: [q.pixels, round(q.clear, 3)]} END),
           lambda z: z.k = k)[1].v))::VARCHAR END AS squares
FROM miss m JOIN rd d USING (granule, t)
LEFT JOIN sqr q USING (granule, i, j)
WHERE d.r.error IS NULL GROUP BY ALL;
CREATE OR REPLACE TEMP TABLE det AS
SELECT x.granule, x.t, floor(round(h.lon * 10, 6))::INT AS i,
       floor(round(h.lat * 10, 6))::INT AS j, h.lon, h.lat, h.pixels, h.s5,
       h.s6, h.temperature, h.rh, h.confirmed, h.saturated,
       h.track, h.px
FROM (SELECT granule, t, unnest(r.hotspots) AS h FROM rd
      WHERE r.error IS NULL) x
SEMI JOIN miss ON miss.granule = x.granule
  AND miss.i = floor(round(h.lon * 10, 6)) AND miss.j = floor(round(h.lat
    * 10, 6));

-- what the store lacks of them, at once
BEGIN;
INSERT INTO db.s3_granules BY NAME
SELECT DISTINCT * FROM found ANTI JOIN db.s3_granules USING (granule);
INSERT INTO db.s3_searched
SELECT DISTINCT sq, day
FROM (SELECT sq, strftime(d, '%Y-%m-%d') AS day FROM srch,
        generate_series(a::TIMESTAMP, b::TIMESTAMP, INTERVAL 1 DAY) g(d)
      WHERE d < current_date - 3)
ANTI JOIN db.s3_searched USING (sq, day);
INSERT INTO db.s3_cells BY NAME
SELECT *, getvariable('v') AS v FROM obs
ANTI JOIN (FROM db.s3_cells WHERE v = getvariable('v'))
  USING (granule, i, j);
INSERT INTO db.s3_hotspots BY NAME
SELECT *, getvariable('v') AS v FROM det
ANTI JOIN (FROM db.s3_hotspots WHERE v = getvariable('v'))
  USING (granule, lon, lat);
COMMIT;
