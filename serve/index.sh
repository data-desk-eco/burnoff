#!/bin/sh
# index.sh: every l1c product of each day eodata lists (n0400 on) into
# $DB's scenes, newest day first back to 2022-01-25, the detector's first
# baseline: a day once it lists products, and the last week again, as
# products land late
. /etc/profile.d/eodata.sh
d=$(date +%F) w=$(date -d '-7 days' +%F)
while [ "$d" \> 2022-01-24 ]; do
  if [ "$d" \> "$w" ] ||
     [ -z "$(sqlite3 "$DB" "SELECT 1 FROM days WHERE day = '$d'")" ]; then
    aws s3 ls "s3://eodata/Sentinel-2/MSI/L1C/$(echo "$d" | tr - /)/" \
        --endpoint-url "https://$AWS_S3_ENDPOINT" > /tmp/index.$$ &&
    grep -oE 'S2[A-D]_MSIL1C_[0-9T]+_N0[4-9][^/]*' /tmp/index.$$ |
      sed 's/\.SAFE$//' | awk -F_ -v q="'" -v d="$d" '
        BEGIN { print ".timeout 60000"; print "BEGIN;" }
        { print "INSERT OR IGNORE INTO scenes (scene, tile, t) VALUES (" q $0 \
                q ", " q substr($6, 2) q ", " q $3 q ");" }
        END { if (NR) print "INSERT OR REPLACE INTO days VALUES (" q d q \
                ", " NR ");"; print "COMMIT;" }' | sqlite3 "$DB" ||
      echo "index: $d failed" >&2
  fi
  d=$(date -d "$d -1 day" +%F)
done
rm -f /tmp/index.$$
