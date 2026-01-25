.PHONY: all detect db serve clean refresh deploy help deps

DATA_DIR := data
QUERIES_DIR := queries
DB := $(DATA_DIR)/flares.duckdb
GEOJSON := $(DATA_DIR)/detections.geojson
PMTILES := $(DATA_DIR)/detections.pmtiles

all: $(PMTILES)

$(PMTILES): $(GEOJSON)
	tippecanoe -o $@ --force --layer=detections -Z0 -z14 -r1 -pk -pf $<

$(GEOJSON): $(DB)
	duckdb -noheader -list $< < $(QUERIES_DIR)/export_map.sql > $@

$(DB): $(DATA_DIR)/detections.json $(DATA_DIR)/terminals.json
	rm -f $@
	duckdb $@ < $(QUERIES_DIR)/init.sql
	duckdb $@ < $(QUERIES_DIR)/load.sql

$(DATA_DIR)/detections.json: $(DATA_DIR)/terminals.json
	uv run burnoff bulk $< -o $@ --year 2025

detect:
	@test -n "$(LAT)" -a -n "$(LON)" || { echo "Usage: make detect LAT=... LON=... [YEAR=2025]"; exit 1; }
	uv run burnoff detect --lat $(LAT) --lon $(LON) --year $(or $(YEAR),2025)

db: $(DB)
	duckdb $(DB)

refresh:
	rm -f $(DB)
	duckdb $(DB) < $(QUERIES_DIR)/init.sql
	duckdb $(DB) < $(QUERIES_DIR)/load.sql
	duckdb -noheader -list $(DB) < $(QUERIES_DIR)/export_map.sql > $(GEOJSON)
	tippecanoe -o $(PMTILES) --force --layer=detections -Z0 -z14 -r1 -pk -pf $(GEOJSON)

serve: $(PMTILES)
	@ln -sf ../$(DATA_DIR) web/data 2>/dev/null || true
	@echo "http://localhost:8000"
	@npx serve web -l 8000

GCS_BUCKET := gs://burnoff-data

deploy: $(PMTILES)
	gcloud storage cp $(PMTILES) $(DATA_DIR)/terminals.json $(GCS_BUCKET)/
	@echo "Deployed to https://storage.googleapis.com/burnoff-data/"

deps:
	@which duckdb >/dev/null || (echo "Installing DuckDB..." && curl -fsSL https://install.duckdb.org | sh)
	@which tippecanoe >/dev/null || (echo "Installing tippecanoe..." && apt-get update && apt-get install -y tippecanoe)

clean:
	rm -rf $(DATA_DIR)/*.duckdb $(DATA_DIR)/*.geojson $(DATA_DIR)/*.pmtiles

help:
	@echo "make all      - Build PMTiles from detections"
	@echo "make detect   - Single location (LAT=x LON=y)"
	@echo "make refresh  - Rebuild from current detections.json"
	@echo "make serve    - Start dev server on :8000"
	@echo "make deploy   - Upload to GCS"
	@echo "make clean    - Remove generated files"
