-- the service (deploy.sh), run in /opt/burnoff: one duckdb holding the
-- store (db, schema.sql), serving quack on localhost:9494 for caddy and q;
-- api.sql's gate runs each query
LOAD spatial; LOAD h3; LOAD quack;
LOAD './burnoff.duckdb_extension';
SET memory_limit = '4GB';
SET temp_directory = '/data/burnoff/tmp';
ATTACH '/data/burnoff/store.duckdb' AS db;
.read schema.sql
.read cells.sql
.read api.sql
SET quack_authorization_function = 'gate';
FROM quack_serve('quack:localhost:9494', token := 'burnoff');
