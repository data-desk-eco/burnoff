-- Initialize schema for flare detections

CREATE TABLE IF NOT EXISTS terminals (
    id INTEGER PRIMARY KEY,
    name VARCHAR NOT NULL,
    lat DOUBLE NOT NULL,
    lon DOUBLE NOT NULL,
    type VARCHAR
);

CREATE TABLE IF NOT EXISTS detections (
    id INTEGER,
    name VARCHAR,
    lat DOUBLE NOT NULL,
    lon DOUBLE NOT NULL,
    start_date DATE,
    end_date DATE,
    images INTEGER,
    detection_count INTEGER,
    occurrence_frequency DOUBLE,  -- DAFI v2: detection_count / images * 100
    persistence_level VARCHAR,    -- DAFI v2: high/mid-high/mid-low/low/intermittent
    max_b12 DOUBLE,
    PRIMARY KEY (lat, lon, start_date)
);

-- Individual detection events with COG references for on-demand imagery
-- Raw detections at actual max B12 pixel location - clustering done in export
CREATE TABLE IF NOT EXISTS detection_events (
    lat DOUBLE NOT NULL,          -- Terminal latitude
    lon DOUBLE NOT NULL,          -- Terminal longitude
    date DATE NOT NULL,
    max_b12 DOUBLE,
    avg_b12 DOUBLE,               -- Cluster average B12 (for peakedness)
    pixels INTEGER,
    -- Raw flare location (actual max B12 pixel)
    flare_lon DOUBLE,
    flare_lat DOUBLE,
    -- COG URLs for on-demand rendering
    cog_b11 VARCHAR,
    cog_b12 VARCHAR,
    cog_visual VARCHAR,
    -- Bounds in WGS84 (minx, miny, maxx, maxy)
    bounds_minx DOUBLE,
    bounds_miny DOUBLE,
    bounds_maxx DOUBLE,
    bounds_maxy DOUBLE,
    -- UTM bounds for windowed COG reads (native projection)
    utm_minx DOUBLE,
    utm_miny DOUBLE,
    utm_maxx DOUBLE,
    utm_maxy DOUBLE,
    epsg INTEGER,
    -- Primary key includes flare location since multiple flares can be detected per facility per date
    PRIMARY KEY (lat, lon, date, flare_lat, flare_lon)
);

-- Spatial extension for distance calculations
INSTALL spatial; LOAD spatial;

-- Detection footprint radius from pixel count (20m Sentinel-2 resolution)
CREATE OR REPLACE MACRO detection_radius_m(pixels) AS (
    sqrt(pixels / pi()) * 20
);

-- Merge threshold based on detection size
-- Small detections (< 10 pixels) have uncertain centroids that can drift
-- Large detections are spatially accurate, use tighter thresholds
-- Cap at 250m - co-occurrence penalty handles cases needing more
CREATE OR REPLACE MACRO merge_threshold_m(pixels_a, pixels_b) AS (
    CASE
        -- Small detections: scale with max radius (12x), capped at 250m
        WHEN GREATEST(pixels_a, pixels_b) < 10
        THEN GREATEST(100, LEAST(250, GREATEST(detection_radius_m(pixels_a), detection_radius_m(pixels_b)) * 12))
        -- Large detections: use sum of radii
        ELSE GREATEST(100, detection_radius_m(pixels_a) + detection_radius_m(pixels_b))
    END
);
