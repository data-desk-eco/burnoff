#!/usr/bin/env bash
# upload web/vnf.parquet to the central datadesk store at the stable key
# vnf/data.parquet (burnoff's prefix; layout: data-desk/DATASETS.md). creds:
# static env aws keys (ci) or the store helper (local, openstack ec2 creds via
# the 2fa openrc). bucket config is data-desk/store.sh publish — this only PUTs.
#
# usage: scripts/upload_vnf.sh [src.parquet] [key]
#        (default web/vnf.parquet → vnf/data.parquet; vnf-raw-upload ships
#        data/vnf_passes.parquet → vnf/passes/data.parquet)
set -euo pipefail

SRC=${1:-web/vnf.parquet}
KEY=${2:-vnf/data.parquet}
[ -f "$SRC" ] || { echo "missing $SRC — run 'make vnf' (or vnf-raw) first"; exit 1; }

store=${DATA_DESK:-$HOME/Tools/data-desk}/store.sh
if [ -f "$store" ]; then . "$store"; store_creds
else STORE_BUCKET=datadesk-archive; STORE_ENDPOINT=https://s3.WAW3-2.cloudferro.com; STORE_URL=$STORE_ENDPOINT/$STORE_BUCKET; fi

aws --endpoint-url "$STORE_ENDPOINT" s3 cp "$SRC" "s3://$STORE_BUCKET/$KEY" --no-progress
curl -sfo /dev/null "$STORE_URL/$KEY" -r 0-0 \
    && echo "published: $STORE_URL/$KEY" \
    || echo "WARN: uploaded but not public — run '~/Tools/data-desk/store.sh publish'"
