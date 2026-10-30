#!/bin/sh
# GET hotspots?bbox=w,s,e,n[&datetime=a/b]: geojson of the bbox's hotspots
# and each scene's look (args.sql, query)
d=$(dirname "$0")
q=$(printf %s "$QUERY_STRING" | tr -cd 'A-Za-z0-9.,/=&%_-')
o=$({ echo "SET VARIABLE q = '$q';"; cat "$d/args.sql"; } | "$d/query" 1) &&
  printf 'Content-Type: application/geo+json\r\n' ||
  printf 'Status: 400\r\nContent-Type: text/plain\r\n'
printf 'Access-Control-Allow-Origin: *\r\n\r\n%s\n' "$o"
