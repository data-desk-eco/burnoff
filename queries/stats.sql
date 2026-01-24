-- Detection statistics
.mode box

SELECT '=== Summary ===' AS summary;
SELECT
    COUNT(*) AS locations,
    SUM(images) AS total_images,
    SUM(detection_count) AS total_detections,
    ROUND(AVG(occurrence_frequency), 1) || '%' AS avg_of,
    ROUND(MAX(max_b12), 4) AS max_b12
FROM detections
WHERE images > 0;

SELECT '=== By Persistence Level ===' AS breakdown;
SELECT
    persistence_level,
    COUNT(*) AS count,
    ROUND(AVG(occurrence_frequency), 1) || '%' AS avg_of
FROM detections
WHERE images >= 5
GROUP BY 1
ORDER BY MIN(occurrence_frequency) DESC;
