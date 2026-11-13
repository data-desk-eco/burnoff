#!/bin/sh
# the store merged into the archive, hourly (export.sql), through the
# service (q) with the archive's key, which the unit hands this as AWS_*
# and printf, a builtin, hands q on stdin, dropped after: the store's
# rows, once they pass its checks; an empty store seeded from
# it. and the gate's tables pruned (prune.sql)
d=$(dirname "$0")
{ cat "$d/prune.sql"
  printf "CREATE OR REPLACE SECRET archive (TYPE s3, KEY_ID '%s', \
SECRET '%s', ENDPOINT 's3.WAW3-2.cloudferro.com', REGION 'WAW3-2', \
URL_STYLE 'path', SCOPE 's3://data-desk-archive');\n" \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
  echo "SET VARIABLE arc = '$ARC';"
  cat "$d/export.sql"; echo "DROP SECRET archive; SELECT 1;"
} | "$d/q" >/dev/null
