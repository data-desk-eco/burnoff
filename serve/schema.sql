-- the service's store, one sqlite file ($DB), in wal mode so a read never
-- waits on a write. scenes: every l1c product eodata lists, from its day's
-- directory (index.sh), and its granule once a read has needed it. cells:
-- each 6.4 km cell of a scene read (i, j from the 100 km square's north-west
-- corner sx, sy), its obscured share and its 640 m squares (cells.sql,
-- on the tile's origin ox, oy). hotspots: those of each cell, pixels
-- (px) as json. v is the digest of the extension that read a cell: a cell
-- is held for the detector that made it alone, so a new one reads anew
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS scenes (tile TEXT, t TEXT, scene TEXT,
  granule TEXT, PRIMARY KEY (tile, t, scene)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, n INTEGER);
CREATE TABLE IF NOT EXISTS cells (
  scene TEXT, i INTEGER, j INTEGER, v TEXT, sx REAL, sy REAL, ox REAL,
  oy REAL, crs TEXT, clear REAL, cloud REAL, squares TEXT, cell TEXT,
  lon REAL, lat REAL,
  PRIMARY KEY (scene, i, j, v)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hotspots (
  scene TEXT, i INTEGER, j INTEGER, x REAL, y REAL, lon REAL, lat REAL,
  max_b12 REAL, avg_b12 REAL, peak_b11 REAL, ratio REAL, peakedness REAL,
  pixels INTEGER, radiance REAL, saturated INTEGER, px TEXT, cell TEXT,
  v TEXT, PRIMARY KEY (scene, x, y, v)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS hotspots_cell ON hotspots (scene, i, j, v);
