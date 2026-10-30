#!/bin/sh
# the store merged into the archive, hourly (export.sql), with the archive's
# key: the current detector's rows, once they pass its checks; an empty store
# seeded from it
d=$(dirname "$0")
{ echo ".output /dev/null"; cat ~/.config/burnoff/secret.sql
  echo "LOAD spatial; LOAD sqlite; SET memory_limit = '2GB';"
  echo "SET temp_directory = '${DB%/*}/tmp';"
  echo "ATTACH '$DB' AS db (TYPE sqlite);"
  echo "SET VARIABLE arc = '$ARC';"
  echo "SET VARIABLE v = '$V';"
  cat "$d/cells.sql" "$d/export.sql"; } | duckdb -bail
