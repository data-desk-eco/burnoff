.PHONY: all detect db map serve clean refresh deploy help

# Sentinel-2 Flare Detection Pipeline

DATA_DIR := data
QUERIES_DIR := queries
DB := $(DATA_DIR)/flares.duckdb
GEOJSON := $(DATA_DIR)/detections.geojson
GEOJSON_LIGHT := $(DATA_DIR)/detections_light.geojson
PMTILES := $(DATA_DIR)/detections.pmtiles

# Default: build PMTiles
all: $(PMTILES)

# Create PMTiles: light tiles (z0-9) + full tiles (z10-14), then merge
$(PMTILES): $(GEOJSON) $(GEOJSON_LIGHT)
	tippecanoe -o $(DATA_DIR)/low.pmtiles --force --layer=detections \
		-Z0 -z9 -r1 -pk -pf $(GEOJSON_LIGHT)
	tippecanoe -o $(DATA_DIR)/high.pmtiles --force --layer=detections \
		-Z10 -z14 -r1 -pk -pf $(GEOJSON)
	tile-join -o $@ --force $(DATA_DIR)/low.pmtiles $(DATA_DIR)/high.pmtiles
	rm -f $(DATA_DIR)/low.pmtiles $(DATA_DIR)/high.pmtiles
	@echo "Created: $@ ($$(du -h $@ | cut -f1))"

# Export full GeoJSON (with detection details)
$(GEOJSON): $(DB)
	duckdb -noheader -list $(DB) < $(QUERIES_DIR)/export_map.sql > $@

# Export light GeoJSON (no detection details, smaller)
$(GEOJSON_LIGHT): $(DB)
	duckdb -noheader -list $(DB) < $(QUERIES_DIR)/export_map_light.sql > $@

# Build database from detections
$(DB): $(DATA_DIR)/detections.json $(DATA_DIR)/terminals.json | $(DATA_DIR)
	rm -f $@
	duckdb $@ < $(QUERIES_DIR)/init.sql
	duckdb $@ < $(QUERIES_DIR)/load.sql

# Run detection on all terminals
$(DATA_DIR)/detections.json: $(DATA_DIR)/terminals.json
	uv run burnoff bulk $< -o $@ --year 2025

# Single location detection (interactive)
detect:
	@test -n "$(LAT)" -a -n "$(LON)" || { echo "Usage: make detect LAT=-12.51 LON=130.92 [YEAR=2025]"; exit 1; }
	uv run burnoff detect --lat $(LAT) --lon $(LON) --year $(or $(YEAR),2025)

# Interactive DuckDB shell
db: $(DB)
	duckdb $(DB)

# Query shortcuts
stats: $(DB)
	duckdb $(DB) < $(QUERIES_DIR)/stats.sql

top: $(DB)
	duckdb $(DB) < $(QUERIES_DIR)/top_flares.sql

# Serve web map (npx serve supports range requests for PMTiles)
serve: $(PMTILES)
	@echo "Serving at http://localhost:8000"
	npx serve -l 8000

# Rebuild geodata from current detections.json (skips detection)
refresh:
	rm -f $(DB)
	duckdb $(DB) < $(QUERIES_DIR)/init.sql
	duckdb $(DB) < $(QUERIES_DIR)/load.sql
	duckdb -noheader -list $(DB) < $(QUERIES_DIR)/export_map.sql > $(GEOJSON)
	duckdb -noheader -list $(DB) < $(QUERIES_DIR)/export_map_light.sql > $(GEOJSON_LIGHT)
	tippecanoe -o $(DATA_DIR)/low.pmtiles --force --layer=detections \
		-Z0 -z9 -r1 -pk -pf $(GEOJSON_LIGHT)
	tippecanoe -o $(DATA_DIR)/high.pmtiles --force --layer=detections \
		-Z10 -z14 -r1 -pk -pf $(GEOJSON)
	tile-join -o $(PMTILES) --force $(DATA_DIR)/low.pmtiles $(DATA_DIR)/high.pmtiles
	rm -f $(DATA_DIR)/low.pmtiles $(DATA_DIR)/high.pmtiles
	@echo "Refreshed: $$(duckdb -noheader -list $(DB) 'SELECT COUNT(*) FROM detections') detections"

# Sync terminals from research repo
$(DATA_DIR)/terminals.json: | $(DATA_DIR)
	@if [ -f ~/Research/lng-flaring/data/kpler_terminals.json ]; then \
		jq '[.[] | select(.position != null and (.type == "Export" or .type == "Import")) | {id, name: (.fullname // .name), lat: .position.latitude, lon: .position.longitude, type}]' \
			~/Research/lng-flaring/data/kpler_terminals.json > $@; \
		echo "Synced $$(jq length $@) terminals"; \
	else \
		echo '[{"id":3586,"name":"Ichthys LNG","lat":-12.514821,"lon":130.918253,"type":"Export"}]' > $@; \
		echo "Created sample terminals.json"; \
	fi

$(DATA_DIR):
	mkdir -p $@

clean:
	rm -rf $(DATA_DIR)

# Deploy PMTiles to GCS
GCS_BUCKET := gs://burnoff-data
deploy: $(PMTILES)
	gcloud storage cp $(PMTILES) $(GCS_BUCKET)/
	@echo "Deployed to: https://storage.googleapis.com/burnoff-data/detections.pmtiles"

help:
	@echo "Sentinel-2 Flare Detection"
	@echo ""
	@echo "  make all       Build map.geojson from detection results"
	@echo "  make detect    Single location (LAT=x LON=y YEAR=n)"
	@echo "  make refresh   Rebuild geodata from current detections.json"
	@echo "  make db        Open DuckDB shell"
	@echo "  make stats     Show detection statistics"
	@echo "  make top       Show top flaring facilities"
	@echo "  make serve     Start web server on :8000"
	@echo "  make clean     Remove generated files"
