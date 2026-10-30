-- bulk.sh's seeds: a point a degree square holding archive sites (s2
-- clusters and viirs flares), the most sites first
COPY (SELECT round(avg(lon), 3), round(avg(lat), 3)
      FROM (SELECT lon, lat FROM read_parquet('https://s3.WAW3-2.cloudferro.com/data-desk-archive/data-desk/flares/data.parquet')
            UNION ALL
            SELECT lon, lat FROM read_parquet('https://s3.WAW3-2.cloudferro.com/data-desk-archive/eog/flares/data.parquet'))
      WHERE lat BETWEEN -84 AND 84
      GROUP BY floor(lon), floor(lat) ORDER BY count(*) DESC)
TO '/dev/stdout' (FORMAT csv, HEADER false, DELIMITER ' ');
