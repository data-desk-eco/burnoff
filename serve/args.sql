-- a request's box (w, s, e, n, from api.sql's gate), at most a z12 view of
-- a 2560×1440 screen; its window, t0 to t1, is the gate's
-- (a script answers with its first select's rows: a check is a variable)
SET VARIABLE ok = CASE WHEN getvariable('e') > getvariable('w')
  AND getvariable('n') > getvariable('s')
  AND getvariable('e') - getvariable('w') <= .44
  AND getvariable('n') - getvariable('s') <= .25 THEN 0
  ELSE error('bbox w, s, e, n, at most 0.44 by 0.25 degrees') END;
SET VARIABLE whole = false;
