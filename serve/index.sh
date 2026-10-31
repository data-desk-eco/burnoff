#!/bin/sh
# index.sh: every l1c product of each day eodata lists (n0400 on) into the
# store's scenes (q), newest day first back to 2022-01-25, the detector's
# first baseline: a day once it lists products, and the last week again, as
# products land late
. /etc/profile.d/eodata.sh
q=$(dirname "$0")/q t=/tmp/index.$$
echo "SELECT day FROM db.days;" | "$q" > "$t.days" || exit 1
d=$(date +%F) w=$(date -d '-7 days' +%F)
while [ "$d" \> 2022-01-24 ]; do
  if [ "$d" \> "$w" ] || ! grep -qx "$d" "$t.days"; then
    aws s3 ls "s3://eodata/Sentinel-2/MSI/L1C/$(echo "$d" | tr - /)/" \
        --endpoint-url "https://$AWS_S3_ENDPOINT" > "$t" &&
    grep -oE 'S2[A-D]_MSIL1C_[0-9T]+_N0[4-9][^/]*' "$t" |
      sed 's/\.SAFE$//' | awk -F_ -v q="'" -v d="$d" '
        { r = r (NR > 1 ? "," : "") "(" q $0 q "," q substr($6, 2) q "," \
            q $3 q ")" }
        END { if (NR) print "INSERT INTO db.scenes BY NAME FROM (VALUES " r \
                ") x(scene, tile, t) ANTI JOIN db.scenes USING (scene);" \
                "DELETE FROM db.days WHERE day = " q d q ";" \
                "INSERT INTO db.days VALUES (" q d q ", " NR ");"
              print "SELECT 1;" }' | "$q" >/dev/null ||
      echo "index: $d failed" >&2
  fi
  d=$(date -d "$d -1 day" +%F)
done
rm -f "$t" "$t.days"
