-- an s3 request's box (w, s, e, n, from api.sql's gate), at most 1° a side:
-- a granule is read once for all the box's cells, so a big box costs
-- little more than a small one; its window, t0 to t1, is the gate's
SET VARIABLE ok = CASE WHEN getvariable('e') > getvariable('w')
  AND getvariable('n') > getvariable('s')
  AND getvariable('e') - getvariable('w') <= 1
  AND getvariable('n') - getvariable('s') <= 1 THEN 0
  ELSE error('bbox w, s, e, n, at most 1 by 1 degrees') END;
