#!/usr/bin/env bash
# vendor dependencies into web/vendor: everything cartograph needs (maplibre,
# hyparquet, inter, dd design system, cartograph itself). geotiff + the
# s2-flares wasm core live in web/s2/ (the methodology core), not here.
set -euo pipefail

CARTOGRAPH="${CARTOGRAPH:-$HOME/Tools/cartograph}"
bash "$CARTOGRAPH/scripts/vendor.sh" web/vendor
