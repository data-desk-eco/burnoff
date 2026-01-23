-- Top flaring locations
.mode box

SELECT
    COALESCE(name, lat || ', ' || lon) AS location,
    detection_count AS detections,
    images,
    ROUND(detection_rate * 100, 1) || '%' AS rate,
    ROUND(max_b12, 4) AS max_swir
FROM detections
WHERE images >= 10
ORDER BY detection_rate DESC, max_b12 DESC
LIMIT 20;
