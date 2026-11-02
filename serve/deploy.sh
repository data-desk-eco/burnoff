#!/bin/sh
# burnoff's service on the jump host: one duckdb (server.sql, as eouser)
# over the extension built there and its store, /data/burnoff/store.duckdb
# (schema.sql), serving quack behind caddy at https://dev.datadesk.eco/quack;
# index.sh daily, export.sh hourly and bulk.sh by hand through it (q), into
# the archive's data-desk/burnoff/{observations,detections}
set -eu
cd "$(dirname "$0")/.."
H=${BURNOFF_HOST:-jump}
rsync -az --delete --relative Makefile src web/burnoff.c web/j2k.wgsl serve \
  "$H":burnoff/
ssh "$H" bash -s <<'S'
set -eu
O=/opt/burnoff D=/data/burnoff
ARC=s3://data-desk-archive/data-desk/burnoff
dpkg -s zlib1g-dev >/dev/null 2>&1 || sudo apt-get install -y -qq zlib1g-dev
make -s -C ~/burnoff GPU=0 ext/burnoff.duckdb_extension
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
V=$(cat $s/burnoff.c $s/j2k.c | sha1sum | cut -c1-12)
V3=$(cat $s/burnoff.c $s/slstr.c | sha1sum | cut -c1-12)
# the gate's key (api.sql), for the box's own scripts alone
[ -s $D/env ] || (umask 077; echo "KEY=$(openssl rand -hex 16)" > $D/env)
[ -s $O/seeds.txt ] || $O/duckdb < $O/seeds.sql > $O/seeds.txt
# the archive's key, minted for the box and read by the export alone
install -d -m 700 ~/.config/burnoff
cd ~/data-desk && bash -c '. infra/env && . infra/archive.sh && archive_creds &&
  umask 077 && printf "CREATE OR REPLACE SECRET archive (TYPE s3, \
KEY_ID \\047%s\\047, SECRET \\047%s\\047, \
ENDPOINT \\047s3.WAW3-2.cloudferro.com\\047, REGION \\047WAW3-2\\047, \
URL_STYLE \\047path\\047, SCOPE \\047s3://data-desk-archive\\047);\\n" \
  "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > ~/.config/burnoff/secret.sql'
cd
# a unit as the box's own jobs are: a failure reported (data-desk-failed@),
# its log under its name (journalctl -t burnoff-<name>)
unit() {   # name, description, command, then [Unit], [Service], [Install]
  printf '[Unit]\nDescription=burnoff: %s\nAfter=network-online.target\n'"\
OnFailure=data-desk-failed@burnoff-$1.service\n%b\n[Service]\nUser=eouser\n\
WorkingDirectory=$O\nSyslogIdentifier=burnoff-$1\nEnvironmentFile=$D/env\n\
Environment=ARC=$ARC V=$V V3=$V3\nExecStart=%s\n%b\n" "$2" "$4" "$3" "$5" |
    sudo tee /etc/systemd/system/burnoff-$1.service >/dev/null
}
unit serve "the store, served over quack" "/bin/bash -c '. \
/etc/profile.d/eodata.sh; exec ./duckdb -unsigned -bail < <(cat server.sql; \
exec sleep infinity)'" '' \
  'Restart=always\nRestartSec=5\n[Install]\nWantedBy=multi-user.target'
w='After=burnoff-serve.service\nRequires=burnoff-serve.service'
# bulk by hand: systemctl start burnoff-bulk
unit bulk "every cell of the archive's sites' tiles" $O/bulk.sh "$w" \
  'Type=oneshot'
unit index "eodata's products, by day" $O/index.sh "$w" 'Type=oneshot'
unit export "the store into the archive" $O/export.sh "$w" 'Type=oneshot'
for t in index:daily export:hourly; do
  printf '[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\n%s\n' \
    ${t#*:} WantedBy=timers.target |
    sudo tee /etc/systemd/system/burnoff-${t%:*}.timer >/dev/null
done
# quack is a post to /quack, cors for the browser's quack client
sudo tee /etc/caddy/routes/burnoff.caddy >/dev/null <<C
handle /quack {
	header >Access-Control-Allow-Origin *
	header >Access-Control-Allow-Headers *
	header >Access-Control-Allow-Methods "POST, OPTIONS"
	@pre method OPTIONS
	respond @pre 204
	reverse_proxy localhost:9494 {
		header_up Host localhost:9494
		transport http {
			response_header_timeout 600s
		}
	}
}
C
sudo systemctl daemon-reload
# the sqlite store, while it was one, into duckdb's, once
if [ -s $D/store.db ] && [ ! -s $D/store.duckdb ]; then
  sudo systemctl stop burnoff-bulk fcgiwrap.socket fcgiwrap 2>/dev/null || :
  sudo rm -f /etc/systemd/system/fcgiwrap.service.d/burnoff.conf
  rm -f $D/new.duckdb*
  $O/duckdb <<Q
LOAD sqlite;
ATTACH '$D/new.duckdb' AS db;
.read $O/schema.sql
ATTACH '$D/store.db' AS s (TYPE sqlite, READ_ONLY);
INSERT INTO db.scenes BY NAME SELECT tile, t, scene FROM s.scenes
ORDER BY tile, t;
INSERT INTO db.granules SELECT scene, granule FROM s.scenes
WHERE granule IS NOT NULL;
INSERT INTO db.days BY NAME FROM s.days;
INSERT INTO db.cells BY NAME
SELECT split_part(scene, '_', 6)[2:] AS tile, split_part(scene, '_', 3) AS t, *
FROM s.cells ORDER BY tile, t, scene, i, j;
INSERT INTO db.hotspots BY NAME FROM s.hotspots ORDER BY v, lat;
Q
  mv $D/new.duckdb $D/store.duckdb
fi
sudo systemctl disable -q --now burnoff-bulk 2>/dev/null || :
sudo systemctl enable -q --now burnoff-serve \
  burnoff-index.timer burnoff-export.timer
sudo systemctl reload caddy
# the service restarts (and drops the requests in flight) only for a change
new=$(cat $O/*.sql $O/*.sh $O/q $O/*.duckdb_extension | sha1sum)
[ "$new" = "$old" ] || sudo systemctl restart burnoff-serve
S
