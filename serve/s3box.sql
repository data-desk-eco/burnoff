-- s3hotspots.sql's box, for an answer: each granule's look at it by night
-- (its date, the local evening it falls in; the clear share of the box's
-- pixels; or its read's error), and its hotspots in the box, and those
-- within m of it, in tables looks and spots. a granule by day, or that did
-- not cover the box, is no look
CREATE OR REPLACE TEMP TABLE c3 AS
SELECT * FROM held UNION ALL BY NAME SELECT * FROM obs;
CREATE OR REPLACE TEMP TABLE looks AS
SELECT gr.granule, strptime(gr.t, '%Y%m%dT%H%M%S') AS datetime,
       s3night(gr.t, (getvariable('w') + getvariable('e')) / 2) AS date,
       e.error, any_value(c.sza) AS sza,
       sum(c.pixels * c.clear) / nullif(sum(c.pixels), 0) AS clear
FROM gr
LEFT JOIN c3 c USING (granule)
LEFT JOIN (SELECT granule, r.error AS error FROM rd
           WHERE r.error IS NOT NULL) e USING (granule)
WHERE gr.granule IN (SELECT granule FROM need)
GROUP BY ALL
HAVING e.error IS NOT NULL OR (any_value(c.sza) >= 90 AND sum(c.pixels) > 0);
-- m: how far past the box spots reach, in degrees of latitude (about
-- 1.1 km), so s3sites.sql sees every link to the box's sites
SET VARIABLE m = .01;
CREATE OR REPLACE TEMP TABLE spots AS
SELECT s.*, strptime(s.t, '%Y%m%dT%H%M%S') AS datetime,
       s3night(s.t, s.lon) AS date
FROM (SELECT DISTINCT * FROM s3at('det') SEMI JOIN c3 USING (granule, i, j)) s
WHERE near(lon, lat);
