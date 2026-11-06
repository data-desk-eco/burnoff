-- the answer (out: geojson.sql's, sites.sql's or their s3 forms'), kept
-- for the gate (api.sql's fresh), and given
INSERT INTO db.answers
SELECT getvariable('k'), getvariable('began'), getvariable('failed'), geojson
FROM out;
FROM out;
