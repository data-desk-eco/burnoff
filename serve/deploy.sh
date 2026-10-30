#!/bin/sh
# burnoff's service on the jump host, over the extension built there and one
# sqlite store, /data/burnoff/store.db (schema.sql): hotspots.cgi behind its
# caddy at https://dev.datadesk.eco/burnoff/hotspots (fcgiwrap, as eouser),
# index.sh daily, bulk.sh at nice 19 and export.sh hourly, into the
# archive's data-desk/burnoff/{observations,detections}
set -eu
cd "$(dirname "$0")/.."
H=${BURNOFF_HOST:-jump}
rsync -az --delete --relative Makefile src web/burnoff.c web/j2k.wgsl serve \
  "$H":burnoff/
ssh "$H" sh -s <<'S'
set -eu
O=/opt/burnoff DB=/data/burnoff/store.db
ARC=s3://data-desk-archive/data-desk/burnoff
make -s -C ~/burnoff GPU=0 ext/burnoff.duckdb_extension
sudo install -d -o eouser $O /data/burnoff
cp ~/burnoff/ext/burnoff.duckdb_extension ~/burnoff/serve/* $O/
# the detector's digest: what a cell is kept under (schema.sql's v)
V=$(sha1sum < $O/burnoff.duckdb_extension | cut -c1-12)
sqlite3 -cmd '.timeout 60000' $DB < $O/schema.sql >/dev/null
[ -s $O/seeds.txt ] || duckdb < $O/seeds.sql > $O/seeds.txt
# the archive's key, minted for the box and read by the export alone
install -d -m 700 ~/.config/burnoff
cd ~/data-desk && bash -c '. infra/env && . infra/archive.sh && archive_creds &&
  umask 077 && printf "CREATE SECRET archive (TYPE s3, KEY_ID \\047%s\\047, \
SECRET \\047%s\\047, ENDPOINT \\047s3.WAW3-2.cloudferro.com\\047, \
REGION \\047WAW3-2\\047, URL_STYLE \\047path\\047, \
SCOPE \\047s3://data-desk-archive\\047);\\n" \
  "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > ~/.config/burnoff/secret.sql'
cd
dpkg -s fcgiwrap >/dev/null 2>&1 || sudo apt-get install -y -qq fcgiwrap
sudo mkdir -p /etc/systemd/system/fcgiwrap.service.d
printf '[Service]\nUser=eouser\nGroup=eouser\nEnvironment=DB=%s V=%s\n' $DB $V |
  sudo tee /etc/systemd/system/fcgiwrap.service.d/burnoff.conf >/dev/null
# a unit as the box's own jobs are: a failure reported (data-desk-failed@),
# its log under its name (journalctl -t burnoff-<name>)
unit() {   # name, description, command, then [Service] and [Install] lines
  printf '[Unit]\nDescription=burnoff: %s\nAfter=network-online.target\n'"\
OnFailure=data-desk-failed@burnoff-$1.service\n[Service]\nUser=eouser\n\
SyslogIdentifier=burnoff-$1\nEnvironment=DB=$DB ARC=$ARC V=$V\n\
ExecStart=$O/%s\n%b\n" "$2" "$3" "$4" |
    sudo tee /etc/systemd/system/burnoff-$1.service >/dev/null
}
unit bulk "every cell of the archive's sites' tiles" bulk.sh \
  'Restart=always\nRestartSec=60\n[Install]\nWantedBy=multi-user.target'
unit index "eodata's products, by day" index.sh 'Type=oneshot'
unit export "the store into the archive" export.sh 'Type=oneshot'
for t in index:daily export:hourly; do
  printf '[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\n%s\n' \
    ${t#*:} WantedBy=timers.target |
    sudo tee /etc/systemd/system/burnoff-${t%:*}.timer >/dev/null
done
sudo tee /etc/caddy/routes/burnoff.caddy >/dev/null <<C
handle_path /burnoff* {
	reverse_proxy unix//run/fcgiwrap.socket {
		transport fastcgi {
			env SCRIPT_FILENAME $O/hotspots.cgi
			read_timeout 600s
		}
	}
}
C
sudo usermod -aG www-data caddy
sudo systemctl daemon-reload
sudo systemctl enable -q --now fcgiwrap.socket burnoff-bulk \
  burnoff-index.timer burnoff-export.timer
sudo systemctl restart fcgiwrap burnoff-bulk caddy
S
