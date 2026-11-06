#!/bin/sh
# load.sh URI N [VIEWS]: N visitors at once over a quack service (as
# quack:localhost:9495), each asking what aerial asks of each view of VIEWS
# (a file, lon lat a line; by default five flaring areas), its views in its
# own order: s2_sites of the 0.1° blocks of a z12 view and s3_sites of the
# 0.5° blocks of a z9 view, on a 1440 × 900 screen, over aerial's windows
# (web/flaring/live.js: the 10-day periods ending in the last 30 days, then
# months back 180), newest first, four at a time; a visitor every GAP
# seconds (0, all at once). then the answers, whole or error, and their
# seconds
set -eu
uri=${1:?usage: load.sh URI N [VIEWS]} n=${2:?N}
t=$(mktemp -d)
trap "${KEEP:+:} rm -rf $t" EXIT
if [ -n "${3:-}" ]; then cp "$3" "$t/views"; else cat > "$t/views" <<V
51.55 25.9
-103.55 31.95
6.95 4.75
48.15 30.05
55.05 25.35
V
fi
duckdb -noheader -list -c "
CREATE MACRO dk(d) AS {
  a: make_date(year(d), month(d), 1 + 10 * least((day(d) - 1) // 10, 2)),
  b: if(day(d) > 20, last_day(d),
        make_date(year(d), month(d), if(day(d) > 10, 20, 10)))};
CREATE TABLE w AS
SELECT a, if(r, any_value(dk(d).b), max(d)) AS b,
       row_number() OVER (ORDER BY a DESC) AS k
FROM (SELECT d, dk(d).b > current_date - 30 AS r,
             if(r, dk(d).a, date_trunc('month', d)::DATE) AS a
      FROM (SELECT current_date - x::INT AS d FROM range(181) t(x)))
GROUP BY a, r;
CREATE TABLE q AS
SELECT i, k, f, x, y, format('FROM {}({}, {}, {}, {}, ''''{}'''', ''''{}'''')',
  f, round(x * z, 4), round(y * z, 4), round((x + 1) * z, 4),
  round((y + 1) * z, 4), a, b) AS q
FROM (SELECT row_number() OVER () AS i, * FROM read_csv('$t/views',
        delim = ' ', columns = {'lon': 'DOUBLE', 'lat': 'DOUBLE'})),
     (VALUES ('s2_sites', .1, .25, .155), ('s3_sites', .5, 2, 1.24))
       s(f, z, dx, dy),
     LATERAL range(floor((lon - dx / 2) / z)::INT,
                   floor((lon + dx / 2) / z)::INT + 1) a(x),
     LATERAL range(floor((lat - dy / 2) / z)::INT,
                   floor((lat + dy / 2) / z)::INT + 1) b(y), w;
SELECT p || ' ' || (row_number() OVER (PARTITION BY p ORDER BY o, k, f, x, y)
  % 4) || ' SELECT left(geojson, 1) FROM quack_query(''$uri'', '''
  || q || ''', token := ''burnoff'');'
FROM q, range($n) v(p),
     LATERAL (SELECT hash(p, i) AS o)" |
  awk -v t="$t" '{ f = t "/q" $1 "." $2; $1 = $2 = ""
                   if (!(f in o)) { o[f]; print "LOAD quack;\n.timer on" > f }
                   print substr($0, 3) > f }'
s=$(date +%s)
for i in $(seq 0 $((n - 1))); do
  for f in "$t/q$i".?; do duckdb -noheader -list < "$f" > "$f.out" 2>&1 & done
  sleep "${GAP:-0}"
done
wait
echo "$n visitors, $(cat "$t"/q*.out | grep -c '^Run Time') requests in" \
  "$(($(date +%s) - s)) s"
cat "$t"/q*.out | awk '
  /^Run Time/ { for (j = 1; j < NF; j++) if ($j == "real") x = $(j + 1)
                print (g == "{" ? "whole" : "error"), x; g = ""; next }
  g == "" { g = $0 }' | sort -k1,1 -k2,2n | awk '
  { n[$1]++; v[$1, n[$1]] = $2 }
  END { for (k in n) printf "%-6s %6d  p50 %6.2f s  p90 %6.2f s  " \
          "max %6.2f s\n", k, n[k], v[k, int(n[k] * .5) + 1],
          v[k, int(n[k] * .9) + 1], v[k, n[k]] }'
