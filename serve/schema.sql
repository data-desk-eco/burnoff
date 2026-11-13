-- the service's store (db). scenes: every l1c product eodata lists, from
-- its day's directory (index.sh), and granules, each one's once a read has
-- needed it. cells: each 6.4 km cell of a scene read (i, j from the 100 km
-- square's north-west corner sx, sy), its obscured share and its 640 m
-- squares (cells.sql, on the tile's origin ox, oy). hotspots: those of
-- each cell, pixels (px) as json. v is the digest of the detector that
-- read a cell, a record alone: a cell held is not read again, whatever the
-- detector; to read cells again, delete them by v here. a cell's tile and sensing time (t) lead, for a read to
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

-- the gate's cache (api.sql). answers: each public request's answer
-- (answer.sql) by its key k, made when the request began (a row with no
-- geojson while it is made), and whether a read failed in it, to be made
-- again (retry). touched: the lon/lat box of what each read added (k, its
-- request's, null for q's; v, its detector's), once committed: an answer
-- is given again only while nothing has touched near its box since it
-- began. both appended, the newest answer of a key the one read, and
-- pruned hourly (prune.sql); emptied, every answer is made again the same
CREATE TABLE IF NOT EXISTS db.answers (
  k VARCHAR, made TIMESTAMPTZ, retry BOOLEAN, geojson VARCHAR);
CREATE TABLE IF NOT EXISTS db.touched (
  k VARCHAR, v VARCHAR, made TIMESTAMPTZ, x0 DOUBLE, y0 DOUBLE, x1 DOUBLE,
  y1 DOUBLE);
-- 2026-11-13: a cell is read once, whatever the detector (v); s3 cells
-- read again under 306ab14bb183 drop what 508cbc28edc4 made of them. a
-- no-op once run
DELETE FROM db.s3_hotspots h USING (SELECT DISTINCT granule, i, j
  FROM db.s3_cells WHERE v = '306ab14bb183') c
WHERE h.v = '508cbc28edc4' AND h.granule = c.granule AND h.i = c.i
  AND h.j = c.j;
DELETE FROM db.s3_cells h USING (SELECT DISTINCT granule, i, j
  FROM db.s3_cells WHERE v = '306ab14bb183') c
WHERE h.v = '508cbc28edc4' AND h.granule = c.granule AND h.i = c.i
  AND h.j = c.j;
