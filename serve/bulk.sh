#!/bin/sh
# every cell of each scene of the tiles about the archive's sites (seeds,
# a point a degree square, the most sites first) into the store, a seed at
# a time through the service (q): 30 days at a time back to 2022, the
# newest 30 again before each, for what has landed since; run by hand
d=$(dirname "$0")
for m in $(seq 1 60); do
  for k in 0 "$m"; do
    t0=$(date -d "-$((30 * k + 29)) days" +%F)
    t1=$(date -d "-$((30 * k)) days" +%F)
    [ "$t1" \> 2022-01-25 ] || exit 0
    while read -r lon lat; do
      { printf 'SET VARIABLE %s;\n' "v = '$V'" "whole = true" "w = $lon" \
          "e = $lon" "s = $lat" "n = $lat" "t0 = DATE '$t0'" \
          "t1 = DATE '$t1'"
        cat "$d/hotspots.sql"; echo "SELECT 1;"; } |
        "$d/q" >/dev/null || echo "bulk: $lon $lat $t0 failed"
    done < "$d/seeds.txt"
  done
done
