-- an s3 request's box (w, s, e, n, from api.sql's gate), at most 1° a side:
-- a granule is read once for all the box's cells, so a big box costs
-- little more than a small one; its window a/b as args.sql's, the last 90
-- days by default
SET VARIABLE ok = CASE WHEN getvariable('e') > getvariable('w')
  AND getvariable('n') > getvariable('s')
  AND getvariable('e') - getvariable('w') <= 1
  AND getvariable('n') - getvariable('s') <= 1 THEN 0
  ELSE error('bbox w, s, e, n, at most 1 by 1 degrees') END;
SET VARIABLE t0 = coalesce(TRY_CAST(nullif(getvariable('a'), '..') AS DATE),
                           current_date - 90);
SET VARIABLE t1 = coalesce(TRY_CAST(nullif(getvariable('b'), '..') AS DATE),
                           current_date);
