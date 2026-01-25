-- Burnoff detection cache schema for Cloudflare D1
-- Stores client-submitted detections with consensus tracking

-- Scanned tiles: tracks which tile+date combinations have been processed
CREATE TABLE IF NOT EXISTS scanned_tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id TEXT NOT NULL,           -- S2 MGRS tile ID (e.g., "30UXA")
    date TEXT NOT NULL,              -- ISO date (e.g., "2024-01-15")
    image_hash TEXT NOT NULL,        -- SHA-256 of B12 raster window (proof of fetch)
    scanned_at TEXT DEFAULT (datetime('now')),
    client_ip TEXT,
    UNIQUE(tile_id, date, image_hash)
);

-- Detections: individual flare detections with consensus
CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id TEXT NOT NULL,
    date TEXT NOT NULL,
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    max_b12 REAL NOT NULL,
    pixels INTEGER NOT NULL,
    image_hash TEXT NOT NULL,        -- Links to scanned_tiles
    consensus INTEGER DEFAULT 1,     -- Incremented when another client confirms
    first_seen TEXT DEFAULT (datetime('now')),
    last_confirmed TEXT DEFAULT (datetime('now')),
    cog_url TEXT,                    -- B12 COG URL for rendering
    epsg INTEGER,                    -- UTM zone for coordinate transforms
    UNIQUE(tile_id, date, lon, lat)  -- One detection per location per date
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_detections_tile_date ON detections(tile_id, date);
CREATE INDEX IF NOT EXISTS idx_detections_coords ON detections(lon, lat);
CREATE INDEX IF NOT EXISTS idx_detections_consensus ON detections(consensus);
CREATE INDEX IF NOT EXISTS idx_scanned_tiles_lookup ON scanned_tiles(tile_id, date);

-- Rate limiting: track submissions per IP
CREATE TABLE IF NOT EXISTS rate_limits (
    client_ip TEXT PRIMARY KEY,
    window_start TEXT DEFAULT (datetime('now')),
    count INTEGER DEFAULT 1
);
