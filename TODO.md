# TODO

## Re-enable the nightly VNF backfill

`.github/workflows/vnf-backfill.yml` is wired but disabled (no `schedule:`). To turn
it back on:

1. Mint a CloudFerro EC2/S3 key pair (`openstack ec2 credentials create`) and add
   them as repo secrets `CLOUDFERRO_S3_KEY` / `CLOUDFERRO_S3_SECRET`.
2. Trigger the workflow manually (Actions → "VNF daily backfill" → Run) and confirm
   it's green — in particular that the duckdb CLI install, EOG creds via Secret
   Manager (`eog-env`), and the `make vnf-upload` step all work in CI.
3. Uncomment the `schedule:` cron in the workflow.
