.PHONY: serve signal test deploy terminals vendor help

terminals: web/terminals.geojson

# gem's prelude flng row (T100000130339) is ~165 km sse of the vessel's true mooring
# despite claiming "exact" accuracy; override with the vnf-derived flare position
web/terminals.geojson: data/GEM-GGIT-LNG-Teminals-2025-09.xlsx
	@duckdb -c "\
	COPY ( \
	  SELECT json_object( \
	    'type', 'FeatureCollection', \
	    'features', json_group_array(json_object( \
	      'type', 'Feature', \
	      'geometry', json_object( \
	        'type', 'Point', \
	        'coordinates', CASE ProjectID WHEN 'T100000130339' THEN json_array(123.3158, -13.7847) \
	          ELSE json_array(CAST(Longitude AS DOUBLE), CAST(Latitude AS DOUBLE)) END \
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

# vnf etl (rollup, backfill, raw passes, uploads) lives in ~/Tools/etl now

vendor: web/vendor/.ok

web/vendor/.ok:
	@bash scripts/vendor.sh
	@touch web/vendor/.ok

serve: vendor signal
	@echo "http://localhost:8000  (signaling on :4444)"
	@python3 scripts/serve.py 8000 web

signal:
	@node signal/server.js &

deploy:
	npx wrangler deploy

test:
	@node --test test/determinism.test.mjs test/retry-peers.test.mjs

help:
	@echo "make serve      - Dev server on :8000 + signaling on :4444"
	@echo "make signal     - Signaling server only"
	@echo "make vendor     - Vendor dependencies via cartograph + the s2e wasm core"
	@echo "make test       - Run determinism tests"
	@echo "make deploy     - Deploy signaling worker to Cloudflare"
