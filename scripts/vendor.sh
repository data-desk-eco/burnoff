#!/usr/bin/env bash
# Download vendored dependencies into web/vendor/.
# Run via: make vendor
set -euo pipefail

VENDOR="web/vendor"
rm -rf "$VENDOR"
mkdir -p "$VENDOR/duckdb" "$VENDOR/fonts"

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

# ── MapLibre GL 5.1.0 ──────────────────────────────────────────────
echo "maplibre-gl@5.1.0 ..."
curl -sLo "$VENDOR/maplibre-gl.js"  "https://unpkg.com/maplibre-gl@5.1.0/dist/maplibre-gl.js"
curl -sLo "$VENDOR/maplibre-gl.css" "https://unpkg.com/maplibre-gl@5.1.0/dist/maplibre-gl.css"

# ── geotiff.js 2.1.3 ───────────────────────────────────────────────
echo "geotiff@2.1.3 ..."
curl -sLo "$VENDOR/geotiff.js" "https://unpkg.com/geotiff@2.1.3/dist-browser/geotiff.js"

# ── DuckDB-WASM 1.29.0 ─────────────────────────────────────────────
# ESM modules (jsdelivr +esm bundles — single-file builds with cross-package
# imports like /npm/apache-arrow@17/+esm remapped via importmap in index.html)
echo "duckdb-wasm@1.29.0 ..."
JSDELIVR="https://cdn.jsdelivr.net/npm"
curl -sLo "$VENDOR/duckdb/duckdb-browser.mjs"  "$JSDELIVR/@duckdb/duckdb-wasm@1.29.0/+esm"
curl -sLo "$VENDOR/duckdb/apache-arrow.mjs"     "$JSDELIVR/apache-arrow@17.0.0/+esm"
curl -sLo "$VENDOR/duckdb/tslib.mjs"            "$JSDELIVR/tslib@2.6.3/+esm"
curl -sLo "$VENDOR/duckdb/flatbuffers.mjs"      "$JSDELIVR/flatbuffers@24.3.25/+esm"

# WASM binary + worker (EH bundle only — all browsers that run this app
# support WASM exception handling, so no need for the MVP fallback)
UNPKG="https://unpkg.com/@duckdb/duckdb-wasm@1.29.0/dist"
curl -sLo "$VENDOR/duckdb/duckdb-eh.wasm"              "$UNPKG/duckdb-eh.wasm"
curl -sLo "$VENDOR/duckdb/duckdb-browser-eh.worker.js" "$UNPKG/duckdb-browser-eh.worker.js"

# ── Inter font (latin subset from Google Fonts) ────────────────────
echo "inter font ..."
FONTS_CSS=$(curl -sH "User-Agent: $UA" \
  "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400..500;1,14..32,400..500&display=swap")

# Use python to reliably parse the CSS, extract latin @font-face blocks,
# download font files, and emit local CSS
python3 -c "
import re, urllib.request, sys

css = sys.stdin.read()
# Split into @font-face blocks with their subset comments
blocks = re.split(r'(?=/\*)', css)
local_css = ''
i = 0
for block in blocks:
    if not block.strip().startswith('/* latin */'):
        continue
    url = re.search(r'url\((https://[^)]+\.woff2)\)', block)
    if not url:
        continue
    fname = f'inter-latin-{i}.woff2'
    urllib.request.urlretrieve(url.group(1), f'$VENDOR/fonts/{fname}')
    local_block = block.replace(url.group(1), f'vendor/fonts/{fname}')
    local_css += local_block + '\n'
    i += 1

with open('$VENDOR/fonts/inter.css', 'w') as f:
    f.write(local_css)
print(f'  {i} latin font files')
" <<< "$FONTS_CSS"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "Vendored to $VENDOR/:"
du -sh "$VENDOR/maplibre-gl.js" "$VENDOR/maplibre-gl.css" "$VENDOR/geotiff.js"
du -sh "$VENDOR/duckdb/"*
du -sh "$VENDOR/fonts/"*
echo ""
echo "Total: $(du -sh "$VENDOR" | cut -f1)"
