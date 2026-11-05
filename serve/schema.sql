-- the service's store (db). scenes: every l1c product eodata lists, from
-- its day's directory (index.sh), and granules, each one's once a read has
-- needed it. cells: each 6.4 km cell of a scene read (i, j from the 100 km
-- square's north-west corner sx, sy), its obscured share and its 640 m
-- squares (cells.sql, on the tile's origin ox, oy). hotspots: those of
-- each cell, pixels (px) as json. v is the digest of the extension that
-- read a cell: a cell is held for the detector that made it alone, so a new
-- one reads anew. a cell's tile and sensing time (t) lead, for a read to
-- skip by them (scenes' names share their first bytes). no keys: requests
-- add rows at once, so a row two read together is kept twice, and readers
-- take distinct rows
CREATE TABLE IF NOT EXISTS db.scenes (tile VARCHAR, t VARCHAR, scene VARCHAR);
CREATE TABLE IF NOT EXISTS db.granules (scene VARCHAR, granule VARCHAR);
CREATE TABLE IF NOT EXISTS db.days (day VARCHAR, n INTEGER);
CREATE TABLE IF NOT EXISTS db.cells (
  tile VARCHAR, t VARCHAR, scene VARCHAR, i INTEGER, j INTEGER, v VARCHAR,
  sx DOUBLE, sy DOUBLE, ox DOUBLE, oy DOUBLE, crs VARCHAR, clear DOUBLE,
  cloud DOUBLE,
  squares VARCHAR, cell VARCHAR, lon DOUBLE, lat DOUBLE);
CREATE TABLE IF NOT EXISTS db.hotspots (
  scene VARCHAR, i INTEGER, j INTEGER, x DOUBLE, y DOUBLE, lon DOUBLE,
  lat DOUBLE, max_b12 DOUBLE, avg_b12 DOUBLE, peak_b11 DOUBLE, ratio DOUBLE,
  peakedness DOUBLE, pixels INTEGER, radiance DOUBLE, saturated INTEGER,
  px VARCHAR, cell VARCHAR, v VARCHAR);

-- sentinel-3 (s3*.sql). s3_granules: the slstr l1b granules cdse's catalogue
-- lists, with its bbox of each, searched a 1° square and a day at a time
-- (s3_searched: a day's search is kept once the day is three days gone).
-- s3_cells: each 0.1° cell (i, j: floor of lon and lat × 10) a granule's
-- read covered, by night or not: the sun's zenith, the clear share of its
-- pixels, and squares, its 5 × 5 squares of 0.02° from the south-west, row
-- by row, each [pixels, clear] or null where no pixel fell, as json.
-- s3_hotspots: those of each cell, px its pixels as s3_detect gives them.
-- both kept under v, as s2's are
CREATE TABLE IF NOT EXISTS db.s3_granules (
  granule VARCHAR, t VARCHAR, dir VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE,
  n DOUBLE);
CREATE TABLE IF NOT EXISTS db.s3_searched (sq VARCHAR, day VARCHAR);
CREATE TABLE IF NOT EXISTS db.s3_cells (
  t VARCHAR, granule VARCHAR, i INTEGER, j INTEGER, v VARCHAR, sza DOUBLE,
  pixels INTEGER, clear DOUBLE, squares VARCHAR);
CREATE TABLE IF NOT EXISTS db.s3_hotspots (
  t VARCHAR, granule VARCHAR, i INTEGER, j INTEGER, lon DOUBLE, lat DOUBLE,
  pixels INTEGER, s5 DOUBLE, s6 DOUBLE, temperature DOUBLE, rh DOUBLE,
  confirmed BOOLEAN, saturated BOOLEAN, v VARCHAR);
ALTER TABLE db.s3_hotspots ADD COLUMN IF NOT EXISTS track DOUBLE;
ALTER TABLE db.s3_hotspots ADD COLUMN IF NOT EXISTS px VARCHAR;
-- 2026-11-05: the browser and gpu paths left the extension, every s2 and s3
-- answer the same, field for field: cells and hotspots kept under the old
-- digests (deploy.sh's V, V3) are the new ones'. a no-op once run
UPDATE db.cells SET v = 'ae8bdad0ae4e' WHERE v = '115a56d3fb7a';
UPDATE db.hotspots SET v = 'ae8bdad0ae4e' WHERE v = '115a56d3fb7a';
UPDATE db.s3_cells SET v = 'bd6320798d35' WHERE v = 'cc7c2f6a4d53';
UPDATE db.s3_hotspots SET v = 'bd6320798d35' WHERE v = 'cc7c2f6a4d53';
-- 2026-11-05: s2.c and s3.c split from burnoff.c, each digest of its own
-- detector's sources; every s2 and s3 answer the same, field for field
UPDATE db.cells SET v = '8e97e7784731' WHERE v = 'ae8bdad0ae4e';
UPDATE db.hotspots SET v = '8e97e7784731' WHERE v = 'ae8bdad0ae4e';
UPDATE db.s3_cells SET v = '306ab14bb183' WHERE v = 'bd6320798d35';
UPDATE db.s3_hotspots SET v = '306ab14bb183' WHERE v = 'bd6320798d35';
