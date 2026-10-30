#!/bin/sh
# GET hotspots?bbox=w,s,e,n[&datetime=a/b][&f=sites]: geojson of the bbox's
# hotspots and each scene's look, or with f=sites its sites (sites.sql).
# bulk's duckdb is stopped while any request runs (each holds L shared),
# and the last out continues it on exit, even if killed; bulk's sqlite3
# merges run on, so a stopped bulk never holds the store's lock
d=$(dirname "$0") L=/data/burnoff/requests.lock
q=$(printf %s "$QUERY_STRING" | tr -cd 'A-Za-z0-9.,/=&%_-')
case "&$q&" in *'&f=sites&'*) f=sites ;; *) f=geojson ;; esac
bulk() {
  for p in $(cat /sys/fs/cgroup/system.slice/burnoff-bulk.service/cgroup.procs)
  do [ "$(cat /proc/"$p"/comm)" = duckdb ] && kill -"$1" "$p"; done 2>/dev/null
}
trap 'exec 9>&-; flock -n "$L" true && bulk CONT' EXIT
# at most a request a core at once; the rest wait for a slot (L.<i>)
n=$(nproc) i=0
until exec 8>>"$L.$i" && flock -n 8; do
  i=$(((i + 1) % n)); [ $i -gt 0 ] || sleep .2
done
exec 9>>"$L"; flock -s 9; bulk STOP
o=$({ echo "SET VARIABLE q = '$q';"; cat "$d/args.sql"; } | "$d/query" $f) &&
  printf 'Content-Type: application/geo+json\r\n' ||
  printf 'Status: 400\r\nContent-Type: text/plain\r\n'
printf 'Access-Control-Allow-Origin: *\r\n\r\n%s\n' "$o"
