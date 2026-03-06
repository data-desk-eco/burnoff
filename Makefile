.PHONY: serve signal test deploy terminals vnf vnf-upload vnf-deploy vnf-backfill accumulations profiles vendor help

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

vnf-upload: web/vnf.parquet
	@test -f .env || { echo "Missing .env with VNF_PASSWORD"; exit 1; }
	$(eval VNF_HASH := $(shell python3 -c "import hashlib; f=open('.env'); pw=[l.split('=',1)[1].strip() for l in f if l.startswith('VNF_PASSWORD=')][0]; print(hashlib.sha256(pw.encode()).hexdigest()[:16])"))
	gcloud storage cp web/vnf.parquet gs://burnoff-data/vnf-$(VNF_HASH).parquet
	@echo "Uploaded as vnf-$(VNF_HASH).parquet"

vnf-deploy: vnf vnf-upload

vnf-backfill:
	uv run --with requests,beautifulsoup4,lxml,duckdb scripts/backfill_vnf.py

accumulations: web/accumulations.geojson

web/accumulations.geojson: scripts/fetch_accumulations.py
	uv run scripts/fetch_accumulations.py

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
	@echo "make vnf-upload - Upload VNF parquet to GCS"
	@echo "make vnf-deploy - Build + upload VNF parquet (one step)"
	@echo "make vnf-backfill - Backfill recent nightly VNF data into parquet"
	@echo "make profiles    - Download VNF profiles for facility-adjacent flares"
	@echo "make accumulations - Fetch oil/gas field polygons from MapStand"
	@echo "make deploy     - Deploy signaling worker to Cloudflare"
