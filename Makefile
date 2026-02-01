CLOUD_RUN_SERVICE := burnoff-signaling
CLOUD_RUN_REGION  := europe-west2

.PHONY: serve signal test deploy terminals help

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
	  WHERE Status IN ('operating', 'construction') \
	    AND Latitude IS NOT NULL AND Longitude IS NOT NULL \
	    AND CAST(Latitude AS DOUBLE) BETWEEN -90 AND 90 \
	    AND CAST(Longitude AS DOUBLE) BETWEEN -180 AND 180 \
	) TO 'web/terminals.geojson' (FORMAT CSV, HEADER false, QUOTE '', DELIMITER '');"
	@echo "web/terminals.geojson: $$(python3 -c "import json; print(len(json.load(open('web/terminals.geojson'))['features']))" 2>/dev/null) features"

serve: signal terminals
	@echo "http://localhost:8000  (signaling on :4444)"
	@python3 -m http.server 8000 -d web

signal:
	@node signal/server.js &

deploy:
	gcloud run deploy $(CLOUD_RUN_SERVICE) \
		--source signal/ \
		--region $(CLOUD_RUN_REGION) \
		--allow-unauthenticated \
		--session-affinity \
		--min-instances 0 \
		--max-instances 1
	@echo ""
	@echo "Add this to web/index.html <head>:"
	@echo '  <meta name="signaling-url" content="wss://$(CLOUD_RUN_SERVICE)-HASH.$(CLOUD_RUN_REGION).run.app">'
	@echo ""
	@echo "Get the exact URL with: gcloud run services describe $(CLOUD_RUN_SERVICE) --region $(CLOUD_RUN_REGION) --format 'value(status.url)'"

test:
	@node --test test/determinism.test.mjs

help:
	@echo "make serve    - Dev server on :8000 + signaling on :4444"
	@echo "make signal   - Signaling server only"
	@echo "make test     - Run determinism tests"
	@echo "make deploy   - Deploy signaling server to Cloud Run"
