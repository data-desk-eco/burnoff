#!/bin/sh
# the store merged into the archive, hourly (export.sql), through the
# service (q) with the archive's key, dropped after: the current detector's
# rows, once they pass its checks; an empty store seeded from it
d=$(dirname "$0")
{ cat ~/.config/burnoff/secret.sql
  echo "SET VARIABLE arc = '$ARC'; SET VARIABLE v = '$V';"
  cat "$d/export.sql"; echo "DROP SECRET archive; SELECT 1;"
} | "$d/q" >/dev/null
