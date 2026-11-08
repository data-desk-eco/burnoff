-- the service (data-desk's burnoff.service), run in serve/ once `make
-- serve` has built ext/: one duckdb holding the store (db, schema.sql) in
-- $STATE_DIRECTORY, serving quack on localhost:9494 for caddy and q;
-- api.sql's gate runs each query
LOAD spatial; LOAD h3; LOAD quack;
LOAD '../ext/burnoff.duckdb_extension';
SET memory_limit = '4GB';
SET temp_directory = getenv('STATE_DIRECTORY') || '/tmp';
ATTACH getenv('STATE_DIRECTORY') || '/store.duckdb' AS db;
.read schema.sql
.read cells.sql
.read api.sql
SET quack_authorization_function = 'gate';
FROM quack_serve('quack:localhost:9494', token := 'burnoff');
