#!/bin/sh
# burnoff's service on the jump host: one duckdb (server.sql, as eouser)
# over the extension built there and its store, /data/burnoff/store.duckdb
# (schema.sql), serving quack behind caddy at https://dev.datadesk.eco/quack;
# index.sh daily, export.sh hourly and bulk.sh by hand through it (q), into
# the archive's data-desk/burnoff/{observations,detections}. its units, its
# route and its keys are data-desk's (infra/systemd/burnoff*, infra/caddy):
# this builds and installs the program, writes the digests the units read
# (/opt/burnoff/env) and mints the gate's key once
set -eu
cd "$(dirname "$0")/.."
H=${BURNOFF_HOST:-jump}
rsync -az --delete --relative Makefile src serve "$H":burnoff/
ssh "$H" bash -s <<'S'
set -eu
O=/opt/burnoff D=/data/burnoff C=/etc/credstore.encrypted
dpkg -s zlib1g-dev >/dev/null 2>&1 || sudo apt-get install -y -qq zlib1g-dev
make -s -C ~/burnoff ext/burnoff.duckdb_extension
sudo install -d -o eouser $O $D $D/tmp
# duckdb 2.0, for quack, pinned here apart from the box's own
[ "$($O/duckdb --version 2>/dev/null | cut -d' ' -f1)" = v2.0.0 ] || {
  curl -sfL https://github.com/duckdb/duckdb/releases/download/v2.0.0/\
duckdb-cli-linux-amd64.tar.gz | tar xzO > /tmp/duckdb
  sudo install -m 755 /tmp/duckdb $O/duckdb; }
$O/duckdb -c "INSTALL spatial; INSTALL h3 FROM community; INSTALL quack;"
rm -f $O/hotspots.cgi $O/query
old=$(cat $O/*.sql $O/*.sh $O/q $O/*.duckdb_extension 2>/dev/null | sha1sum)
install -C -m 755 ~/burnoff/ext/burnoff.duckdb_extension ~/burnoff/serve/* $O/
# the detectors' digests, what a cell is kept under (schema.sql's v): s2's
# of its sources, s3's of its own, so a change to one keeps the other's
s=~/burnoff/src
printf 'V=%s\nV3=%s\n' \
  "$(cat $s/burnoff.h $s/burnoff.c $s/s2.c $s/j2k.c | sha1sum | cut -c1-12)" \
  "$(cat $s/burnoff.h $s/burnoff.c $s/s3.c | sha1sum | cut -c1-12)" > $O/env
# the gate's key (api.sql), for the box's own scripts alone: a credential
# the units import, minted once. the files the keys were kept in go
sudo sh -c "test -s $C/burnoff || echo KEY=\$(openssl rand -hex 16) |
  systemd-creds encrypt -q --with-key=host --name=burnoff - $C/burnoff"
rm -f $D/env ~/.config/burnoff/secret.sql
[ -s $O/seeds.txt ] || $O/duckdb < $O/seeds.sql > $O/seeds.txt
# the service restarts (and drops the requests in flight) only for a change
new=$(cat $O/*.sql $O/*.sh $O/q $O/*.duckdb_extension | sha1sum)
[ "$new" = "$old" ] || sudo systemctl restart burnoff-serve
S
