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

# obtain S3 credentials (AK/SK). if they're already in the env (e.g. CI with
# static keys) use them and skip the interactive openstack/2fa path entirely.
if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    AK=$AWS_ACCESS_KEY_ID
    SK=$AWS_SECRET_ACCESS_KEY
else
    # 1. openstack auth (skip if already authenticated this shell). the vendored openrc
    # is written for a lax shell — unset OS_* refs, its own returns — so source it with
    # -eu off and restore IFS after (it leaves IFS=$'\n'), like box.sh.
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
fi
[ -n "$AK" ] && [ -n "$SK" ] || { echo "could not obtain S3 credentials"; exit 1; }

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
echo "uploaded: https://s3.$REGION.cloudferro.com/$BUCKET/$KEY"

# 4. ensure anonymous public-read covers vnf/ — applies the SAME policy box.sh's
# publish() sets (detections/* + clusters/* + vnf/*), so there's no drift if either
# is re-run. idempotent. s3api works against radosgw when region+endpoint are set.
if command -v aws >/dev/null; then
    env AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_DEFAULT_REGION="$REGION" \
      aws --endpoint-url "https://s3.$REGION.cloudferro.com" --no-cli-pager s3api put-bucket-policy \
      --bucket "$BUCKET" --policy '{"Version":"2012-10-17","Statement":[{"Sid":"PublicReadArchive","Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::'"$BUCKET"'/detections/*","arn:aws:s3:::'"$BUCKET"'/clusters/*","arn:aws:s3:::'"$BUCKET"'/vnf/*"]},{"Sid":"PublicListArchive","Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::'"$BUCKET"'"]}]}' \
      && echo "public-read policy ensured (detections/* clusters/* vnf/*)" \
      || echo "WARN: couldn't set bucket policy — run '(cd ~/Tools/s2-flares && ./cloud/box.sh publish)' to make vnf/ public"
else
    echo "(aws cli not found — run '(cd ~/Tools/s2-flares && ./cloud/box.sh publish)' once to make vnf/ public)"
fi
