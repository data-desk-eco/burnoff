#!/usr/bin/env bash
# vendor dependencies into web/vendor: everything cartograph needs (maplibre,
# DuckDB, Inter, the Data Desk design system, and Cartograph). GeoTIFF + the
# s2e wasm core live in web/s2/ (the methodology core), not here.
set -euo pipefail

CARTOGRAPH="${CARTOGRAPH:-$HOME/Tools/cartograph}"
bash "$CARTOGRAPH/scripts/vendor.sh" web/vendor

# s2e wasm core → web/s2/wasm (built by `make wasm` in the s2e repo)
S2E="${S2E:-$HOME/Tools/s2e}"
cp "$S2E"/wasm/pkg/s2e_wasm.js "$S2E"/wasm/pkg/s2e_wasm_bg.wasm web/s2/wasm/
