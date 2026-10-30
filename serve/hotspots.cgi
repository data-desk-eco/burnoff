#!/bin/sh
# GET hotspots?bbox=w,s,e,n[&datetime=a/b][&f=sites]: geojson of the bbox's
# hotspots and each scene's look, or with f=sites its sites (sites.sql)
d=$(dirname "$0")
q=$(printf %s "$QUERY_STRING" | tr -cd 'A-Za-z0-9.,/=&%_-')
case "&$q&" in *'&f=sites&'*) f=sites ;; *) f=geojson ;; esac
o=$({ echo "SET VARIABLE q = '$q';"; cat "$d/args.sql"; } | "$d/query" $f) &&
  printf 'Content-Type: application/geo+json\r\n' ||
  printf 'Status: 400\r\nContent-Type: text/plain\r\n'
printf 'Access-Control-Allow-Origin: *\r\n\r\n%s\n' "$o"
