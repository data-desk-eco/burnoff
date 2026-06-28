.PHONY: serve signal test deploy terminals vnf vnf-upload vnf-deploy vnf-backfill profiles vendor help

terminals: web/terminals.geojson

web/terminals.geojson: data/GEM-GGIT-LNG-Teminals-2025-09.xlsx
	@duckdb -c "\
	COPY ( \
	  SELECT json_object( \
	    'type', 'FeatureCollection', \
	    'features', json_group_array(json_object( \
	      'type', 'Feature', \
	      'geometry', json_object( \
	        'type', 'Point', \
	        'coordinates', json_array(CAST(Longitude AS DOUBLE), CAST(Latitude AS DOUBLE)) \
	      ), \
	      'properties', json_object( \
	        'name', TerminalName, \
	        'country', \"Country/Area\", \
	        'type', FacilityType, \
	        'status', Status, \
	        'capacity_mtpa', CAST(CapacityinMtpa AS DOUBLE), \
	        'owner', Owner \
	      ) \
	    )) \
	  ) \
	  FROM read_xlsx('data/GEM-GGIT-LNG-Teminals-2025-09.xlsx', sheet='LNG Terminals', header=true, all_varchar=true) \
	  WHERE Status IN ('operating', 'construction', 'idled', 'mothballed') \
	    AND Latitude IS NOT NULL AND Longitude IS NOT NULL \
	    AND CAST(Latitude AS DOUBLE) BETWEEN -90 AND 90 \
	    AND CAST(Longitude AS DOUBLE) BETWEEN -180 AND 180 \
	) TO 'web/terminals.geojson' (FORMAT CSV, HEADER false, QUOTE '', DELIMITER '');"
	@echo "web/terminals.geojson: $$(python3 -c "import json; print(len(json.load(open('web/terminals.geojson'))['features']))" 2>/dev/null) features"

profiles:
	uv run --with requests,beautifulsoup4,duckdb,lxml scripts/fetch_vnf_profiles.py

vnf: web/vnf.parquet

web/vnf.parquet: scripts/build_vnf.py
	uv run --with duckdb scripts/build_vnf.py

# VNF parquet ships to the shared s2-flares CloudFerro archive at the stable key
# vnf/data.parquet (mirrors detections/ and clusters/). Needs S3 credentials for the
# bucket — e.g. `export $(openstack ec2 credentials list -f value -c Access -c Secret
# | awk '{print "AWS_ACCESS_KEY_ID="$1; print "AWS_SECRET_ACCESS_KEY="$2}')`.
ARCHIVE_ENDPOINT := https://s3.WAW3-2.cloudferro.com
ARCHIVE_BUCKET   := s2-flares-archive

vnf-upload: web/vnf.parquet
	aws --endpoint-url $(ARCHIVE_ENDPOINT) s3 cp web/vnf.parquet s3://$(ARCHIVE_BUCKET)/vnf/data.parquet
	@echo "Uploaded to s3://$(ARCHIVE_BUCKET)/vnf/data.parquet"

vnf-deploy: vnf vnf-upload

vnf-backfill:
	uv run --with requests,beautifulsoup4,lxml,duckdb scripts/backfill_vnf.py

data/gem-extraction-tracker.xlsx:
	curl -L -o $@ "https://globalenergymonitor.org/wp-content/uploads/2025/02/Global-Oil-and-Gas-Extraction-Tracker-Feb-2025.xlsx"

vendor: web/vendor/.ok

web/vendor/.ok:
	@bash scripts/vendor.sh
	@touch web/vendor/.ok

serve: vendor signal
	@echo "http://localhost:8000  (signaling on :4444)"
	@python3 -m http.server 8000 -d web

signal:
	@node signal/server.js &

deploy:
	npx wrangler deploy

test:
	@node --test test/determinism.test.mjs test/retry-peers.test.mjs

help:
	@echo "make serve      - Dev server on :8000 + signaling on :4444"
	@echo "make signal     - Signaling server only"
	@echo "make vendor     - Download vendored dependencies (MapLibre, geotiff, DuckDB, Inter)"
	@echo "make test       - Run determinism tests"
	@echo "make vnf        - Build VNF parquet from EOG profile CSVs"
	@echo "make vnf-upload - Upload VNF parquet to the s2-flares archive (vnf/data.parquet)"
	@echo "make vnf-deploy - Build + upload VNF parquet (one step)"
	@echo "make vnf-backfill - Backfill recent nightly VNF data into parquet"
	@echo "make profiles    - Download VNF profiles for facility-adjacent flares"
	@echo "make deploy     - Deploy signaling worker to Cloudflare"
