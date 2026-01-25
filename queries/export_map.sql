-- Export flare locations as GeoJSON for PMTiles conversion
-- Performs spatial clustering on raw detections before export
--
-- Configuration (adjust these values to tune clustering):
--   CLUSTER_DISTANCE_M: Max distance (meters) to merge detections (default: 100)
--   MIN_DETECTIONS: Minimum detection dates for temporal persistence (default: 2)
--   MIN_MAX_B12: Minimum peak B12 for high confidence (default: 0.75)
--
-- Design principles:
--   - No false negatives: detect every flare, even small/intermittent ones
--   - No false clustering: keep distinct flares separate (100m prevents merging)
--   - Same-flare variance ~50-70m (20m pixels + 10m geolocation + viewing angle)

-- Haversine distance macro (returns meters)
CREATE OR REPLACE MACRO haversine_m(lon1, lat1, lon2, lat2) AS (
    6371000 * 2 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
    ))
);

-- Configuration
-- Reduced cluster_distance from 300m to 100m to prevent merging distinct flares
-- while still grouping same-flare detections across time
SET VARIABLE cluster_distance_m = 100;
SET VARIABLE min_detections = 2;  -- Lowered from 3 to catch intermittent flares
SET VARIABLE min_max_b12 = 0.75;

WITH
-- Step 1: Get all valid raw detections with facility info
raw_detections AS (
    SELECT
        d.id as facility_id,
        d.name,
        e.flare_lon,
        e.flare_lat,
        e.date,
        e.max_b12,
        e.pixels,
        e.cog_b12,
        e.epsg,
        e.utm_minx, e.utm_miny, e.utm_maxx, e.utm_maxy,
        -- Create unique detection ID for clustering
        row_number() OVER () as det_id
    FROM detections d
    JOIN detection_events e ON d.lat = e.lat AND d.lon = e.lon
    WHERE e.flare_lon IS NOT NULL AND e.flare_lat IS NOT NULL
),

-- Step 2: For each detection, find the minimum det_id within clustering distance
-- This assigns each point to the "leader" (lowest ID) of its cluster
-- Note: No transitive closure - each detection joins its direct leader only
-- This prevents "clustering creep" where distant flares get chained together
cluster_assignments AS (
    SELECT
        a.det_id,
        a.facility_id,
        a.name,
        a.flare_lon,
        a.flare_lat,
        a.date,
        a.max_b12,
        a.pixels,
        a.cog_b12,
        a.epsg,
        a.utm_minx, a.utm_miny, a.utm_maxx, a.utm_maxy,
        -- Find minimum det_id within distance (including self) - this IS the cluster_id
        (SELECT MIN(b.det_id)
         FROM raw_detections b
         WHERE b.facility_id = a.facility_id
           AND haversine_m(a.flare_lon, a.flare_lat, b.flare_lon, b.flare_lat) <= getvariable('cluster_distance_m')
        ) as cluster_id
    FROM raw_detections a
),

-- Step 3: Aggregate detections by cluster
clustered_flares AS (
    SELECT
        cluster_id,
        facility_id,
        name,
        -- Cluster centroid (average of all detection locations)
        AVG(flare_lon) as flare_lon,
        AVG(flare_lat) as flare_lat,
        MAX(max_b12) as max_b12,
        COUNT(DISTINCT date) as detection_count,
        json_group_array(
            json_object(
                'date', date,
                'max_b12', ROUND(max_b12, 4),
                'pixels', pixels,
                'cog_b12', cog_b12,
                'epsg', epsg,
                'utm_bounds', json_array(utm_minx, utm_miny, utm_maxx, utm_maxy),
                'raw_lon', flare_lon,
                'raw_lat', flare_lat
            )
        ) as detections
    FROM cluster_assignments
    GROUP BY cluster_id, facility_id, name
),

-- Step 4: Apply quality filters
filtered_flares AS (
    SELECT *
    FROM clustered_flares
    WHERE max_b12 >= getvariable('min_max_b12')
      AND detection_count >= getvariable('min_detections')
)

-- Output as GeoJSON FeatureCollection
SELECT json_object(
    'type', 'FeatureCollection',
    'features', COALESCE(json_group_array(
        json_object(
            'type', 'Feature',
            'geometry', json_object(
                'type', 'Point',
                'coordinates', json_array(flare_lon, flare_lat)
            ),
            'properties', json_object(
                'facility_id', facility_id,
                'name', name,
                'max_b12', ROUND(max_b12, 4),
                'detection_count', detection_count,
                'detections', json(detections)
            )
        )
    ), '[]')
)
FROM filtered_flares;
