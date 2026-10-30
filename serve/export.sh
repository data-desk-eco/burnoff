#!/bin/sh
# the store into the archive, hourly (export.sql), with the archive's key:
# the current detector's rows, once they pass its checks
d=$(dirname "$0")
{ echo ".output /dev/null"; cat ~/.config/burnoff/secret.sql
  echo "LOAD spatial; LOAD sqlite;"
  echo "ATTACH '$DB' AS db (TYPE sqlite, READ_ONLY);"
  echo "SET VARIABLE arc = '$ARC';"
  echo "SET VARIABLE v = '$V';"
  cat "$d/cells.sql" "$d/export.sql"; } | duckdb -bail
