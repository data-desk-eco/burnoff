#!/usr/bin/env bash
# upload web/vnf.parquet to the shared s2-flares cloudferro archive at the stable
# key vnf/data.parquet. handles the whole cloudferro dance: source openstack auth,
# mint ec2 (s3) credentials if absent, then write via duckdb's httpfs COPY — the
# same path box.sh uses for detections/ and clusters/, so it's known-good against
# the radosgw endpoint (the aws cli is finicky there).
#
# usage: scripts/upload_vnf.sh [path/to.parquet]   (default web/vnf.parquet)
set -euo pipefail

REGION=WAW3-2
BUCKET=s2-flares-archive
KEY=vnf/data.parquet
SRC=${1:-web/vnf.parquet}
OPENRC=${OPENRC:-$HOME/Tools/s2-flares/cloud/s2-flares-openrc-2fa.sh}

[ -f "$SRC" ] || { echo "missing $SRC — run 'make vnf' first"; exit 1; }

# 1. openstack auth (skip if already authenticated this shell). the vendored openrc
# is written for a lax shell — it references unset OS_* vars and has its own returns —
# so source it with -eu off and restore IFS after (it leaves IFS=$'\n'), like box.sh.
if ! openstack token issue >/dev/null 2>&1; then
    [ -f "$OPENRC" ] || { echo "no openstack auth and no openrc at $OPENRC (set OPENRC=...)"; exit 1; }
    set +eu
    # shellcheck disable=SC1090
    source "$OPENRC"
    set -eu
    unset IFS
fi

# 2. ec2 (s3) credentials — reuse if present, else create (mirrors box.sh s3creds)
CRED=$(openstack ec2 credentials list -f value -c Access -c Secret 2>/dev/null | head -1 || true)
if [ -z "$CRED" ] || [ "$CRED" = "null null" ]; then
    openstack ec2 credentials create >/dev/null
    CRED=$(openstack ec2 credentials list -f value -c Access -c Secret | head -1)
fi
AK=$(echo "$CRED" | awk '{print $1}')
SK=$(echo "$CRED" | awk '{print $2}')
[ -n "$AK" ] && [ -n "$SK" ] || { echo "could not obtain ec2 credentials"; exit 1; }

# 3. upload via duckdb httpfs COPY (proven against this bucket in box.sh)
echo "uploading $SRC -> s3://$BUCKET/$KEY"
duckdb -c "
INSTALL httpfs; LOAD httpfs;
SET s3_endpoint='s3.$REGION.cloudferro.com';
SET s3_region='$REGION';
SET s3_url_style='path';
SET s3_use_ssl=true;
SET s3_access_key_id='$AK';
SET s3_secret_access_key='$SK';
COPY (SELECT * FROM read_parquet('$SRC')) TO 's3://$BUCKET/$KEY' (FORMAT parquet);
"
echo "done: https://s3.$REGION.cloudferro.com/$BUCKET/$KEY"
echo "(if vnf/ isn't public yet, add s2-flares-archive/vnf/* to the bucket policy — see step 2)"
