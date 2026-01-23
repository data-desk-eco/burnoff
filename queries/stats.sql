-- Detection statistics
.mode box

SELECT '=== Summary ===' AS "";
SELECT
    COUNT(*) AS locations,
    SUM(images) AS total_images,
    SUM(detection_count) AS total_detections,
    ROUND(AVG(detection_rate) * 100, 1) || '%' AS avg_rate,
    ROUND(MAX(max_b12), 4) AS max_b12
FROM detections
WHERE images > 0;

SELECT '' AS "";
SELECT '=== By Detection Rate ===' AS "";
SELECT
    CASE
        WHEN detection_rate >= 0.8 THEN 'High (≥80%)'
        WHEN detection_rate >= 0.5 THEN 'Medium (50-79%)'
        WHEN detection_rate >= 0.2 THEN 'Low (20-49%)'
        WHEN detection_rate > 0 THEN 'Minimal (1-19%)'
        ELSE 'None (0%)'
    END AS category,
    COUNT(*) AS count,
    ROUND(AVG(detection_rate) * 100, 1) || '%' AS avg_rate
FROM detections
WHERE images >= 5
GROUP BY 1
ORDER BY MIN(detection_rate) DESC;
