-- a request's query string (q): bbox=w,s,e,n, at most a z12 view of a
-- 2560×1440 screen, and datetime=a/b (either end open, '..'), the last 90
-- days by default
SET VARIABLE q = url_decode(getvariable('q'));
SET VARIABLE bb = (SELECT list_transform(string_split(regexp_extract(
  getvariable('q'), '(^|&)bbox=([^&]*)', 2), ','),
  lambda v: TRY_CAST(v AS DOUBLE)));
SET VARIABLE dt = string_split(regexp_extract(getvariable('q'),
  '(^|&)datetime=([^&]*)', 2) || '/', '/');
SET VARIABLE ok = (SELECT CASE WHEN len(bb) = 4 AND list_count(bb) = 4
            AND bb[3] > bb[1]
            AND bb[4] > bb[2] AND bb[3] - bb[1] <= .44
            AND bb[4] - bb[2] <= .25 THEN 0
       ELSE error('bbox=w,s,e,n, at most 0.44 by 0.25 degrees') END
FROM (SELECT getvariable('bb') AS bb));
SET VARIABLE w = getvariable('bb')[1];
SET VARIABLE s = getvariable('bb')[2];
SET VARIABLE e = getvariable('bb')[3];
SET VARIABLE n = getvariable('bb')[4];
SET VARIABLE t0 = coalesce(TRY_CAST(nullif(getvariable('dt')[1], '..')
                                    AS DATE), current_date - 90);
SET VARIABLE t1 = coalesce(TRY_CAST(nullif(coalesce(nullif(
  getvariable('dt')[2], ''), getvariable('dt')[1]), '..') AS DATE),
  current_date);
SET VARIABLE whole = false;
