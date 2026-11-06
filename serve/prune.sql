-- the gate's cache (schema.sql) pruned, hourly (export.sh): an answer once
-- a newer one of its key is kept, or a month on, and a touch a month on, as
-- no answer is older. a run again deletes nothing more
DELETE FROM db.answers a WHERE made < now() - INTERVAL 30 DAY
  OR made < (SELECT max(made) FROM db.answers b WHERE b.k = a.k);
DELETE FROM db.touched WHERE made < now() - INTERVAL 30 DAY;
