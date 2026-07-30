# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync, plus a
VIIRS Nightfire (VNF) mode for browsing EOG's satellite flare catalog.

Zero npm dependencies. The only external libraries are MapLibre GL (map
rendering), geotiff.js (COG reads), hyparquet (parquet reads, pure js), and the
s2e rust core compiled to wasm (the flare detector) — all vendored under
`web/vendor/` and `web/s2/`. Everything else — CRDT, WebRTC mesh, sync protocol,
IndexedDB persistence, UTM projection math, and the signal server's WebSocket
framing — is hand-rolled using web standards.

## Architecture

```
  Browser (config.js)                         Browser (peer)
 ┌──────────────────────┐                 ┌──────────────────────┐
 │  MapLibre GL         │                 │  MapLibre GL         │
 │  ┌────────────────┐  │   WebRTC /      │  ┌────────────────┐  │
 │  │ LWW-Map CRDT   │◄─┼── WebSocket ──►─┼─►│ LWW-Map CRDT   │  │
 │  │  detections Map │  │   (DataChannel) │  │  detections Map │  │
 │  │  processed  Map │  │                 │  │  processed  Map │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 │          │           │                 │          │           │
 │  IndexedDB           │                 │  IndexedDB           │
 │          │           │                 │          │           │
 │  ┌───────▼────────┐  │                 │  ┌───────▼────────┐  │
 │  │ detect         │  │                 │  │ detect         │  │
 │  │  (Web Worker)  │  │                 │  │  (Web Worker)  │  │
 │  └───────┬────────┘  │                 │  └───────┬────────┘  │
 └──────────┼───────────┘                 └──────────┼───────────┘
            │ HTTP range requests                    │
            ▼                                        ▼
     Element84 STAC API          hyparquet
     Sentinel-2 L2A COGs         VNF Parquet (CloudFerro archive)
     (B12, B11, B8A, SCL)
```

**S2 mode:** The default data source reads the precomputed *cluster view*
straight from the CloudFerro public parquet archive (`data-desk/infra/archive.sh publish`).
The archive co-produces a derived cluster view partitioned by MGRS tile,
`views/clusters/mgrs=<tile>/data.parquet` — one row per cluster (scalar score columns +
a nested `detections` list). `web/s2archive.js` enumerates those per-tile objects
from the bucket listing, then range-reads with hyparquet **only the tiles the
viewport overlaps** — each tile's parquet is loaded once, lazily, and cached;
viewports are served from those cached tiles (bbox + date-overlap filter), so a
far-out or uncovered viewport fetches nothing. `archiveFeature` maps a row straight
to the Feature shape `crossDateCluster` emits, so the avg-B12 slider gates
client-side but the server-side clustering is not re-run. The in-browser COG detection worker (`detect-worker.js`, the "Detect"
button) is the fallback for areas not yet archived: it runs the s2e rust core
compiled to wasm (`web/s2/wasm/`), the SAME binary methodology as the server-side
archive — there is no JS detector port (it drifted from the core and was removed).
Peers share a single CRDT document, idle peers read
the job from awareness state, partition blocks by hash, and process their share,
merging results via LWW-Map CRDT. The CRDT/mesh stack is **loaded lazily**
(`ensureDetect()` dynamically imports crdt/sync/rtc/store) only when the viewport
sits outside the archive's coverage — a pure-archive session never fetches it. The
archive base is set via `<meta name="s2-archive">` in index.html.

**VNF mode:** hyparquet reads a pre-built Parquet file containing per-flare
daily observations from EOG profile CSVs. In production it lives in the shared
datadesk CloudFerro archive at `views/vnf/data.parquet` (`<meta name="vnf-url">`); dev
falls back to a local `web/vnf.parquet`. Each row has `clear`/`detected` booleans
for real cloud-free persistence metrics.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make test         # Run determinism + P2P retry tests
make vnf          # Build VNF parquet from EOG profile CSVs
make vnf-upload   # Upload VNF parquet to the datadesk archive (vnf/data.parquet)
make deploy       # Deploy signaling worker to Cloudflare
git push          # Deploy static site via GitHub Pages (auto on push to main)
```

No `npm install` required. Dev server uses `python3 -m http.server`.
Local signaling uses `node:http` and `node:crypto` (Node.js builtins).
Production signaling is a Cloudflare Worker + Durable Object (`npx wrangler deploy`).
Tests use `node:test` and `node:assert`.

## Key Files

```
Burnoff is a cartograph consumer (~/Tools/cartograph): config.js is the
declarative map config passed to mount(); the shell, key, quarter picker,
sliders, detail panel and permalinks are all cartograph's (vendored in
web/vendor/cartograph/). Everything burnoff-specific lives in the hook
modules config.js wires in.

```
web/
  config.js           The cartograph config + burnoff orchestration: mode
                      switching (S2/VNF), viewport-driven queries, quarter
                      availability, detect controls, deep-link resolve
  render.js           Mode config + marking/ramp builders (data desk design)
  card.js             Detection card as cartograph detail hooks: metrics,
                      intensity chart, event rows, COG/heat-footprint overlays,
                      CSV export, keyboard nav
  detect.js           Local detect + P2P subsystem: lazy CRDT wiring
                      (ensureDetect), detect workers + distributed help,
                      cross-date clusterer over the CRDT maps
  vendor/cartograph/  Vendored cartograph core (mount, dd shell, key, quarters,
                      sliders, detail, permalinks) from ~/Tools/cartograph
  vendor/dd/          Vendored data desk design system dist (map.css, style.dark.json,
                      markings, palette, worldmap) from ~/Tools/design
  clustering.js       Terminal grid + archive/VNF feature builders
  vnf.js              VNF data module: hyparquet reads + per-flare aggregation
  s2archive.js        S2 archive reader: hyparquet over the cluster parquet
  detect-worker.js    Module Web Worker: wasm block detector + COG I/O
  s2/                 The s2e methodology core, adopted in-tree (no submodule):
                      stac/cog/geo I/O + cluster/score JS + the rust core compiled to
                      wasm in s2/wasm/. detect-worker runs the wasm — the same binary
                      methodology as the archive; cog.js holds the block tiling glue.
  crdt.js             LWW-Map CRDT with binary codec   (lazy: loaded outside coverage)
  sync.js             Sync protocol, awareness, validation              (lazy)
  rtc.js              WebRTC DataChannel mesh (raw RTCPeerConnection)   (lazy)
  store.js            IndexedDB persistence with batched flushes        (lazy)
  terminals.geojson   LNG terminal locations (Global Energy Monitor)
  index.html          Entry point (~30 lines: meta config + vendor includes)
  style.css           Burnoff-specific UI on top of cartograph's shell.css
scripts/
  vendor.sh           Thin wrapper over ~/Tools/cartograph/scripts/vendor.sh + s2e wasm
signal/
  server.js           WebSocket signaling relay for local dev (RFC 6455 over node:http)
  worker.js           Cloudflare Worker + Durable Object signaling relay (production)
wrangler.toml         Cloudflare Worker config (Durable Object binding + migration)
test/
  determinism.test.mjs       Detection + clustering determinism tests (node:test)
  signaling-node.test.mjs    Signaling relay tests (node, requires ws package)
  signaling.test.html        Signaling relay tests (browser)
  p2p-test.html              CRDT codec + sync integration tests (browser)
```

## External Dependencies

| Library | Purpose | Loaded from |
|---------|---------|-------------|
| MapLibre GL 5.1 | WebGL map rendering | Vendored (`web/vendor/`) |
| geotiff.js 2.1 | Cloud Optimized GeoTIFF reads | Vendored in `web/s2/vendor/` (ESM, one copy) |
| s2e wasm 2.0 | Block flare detector (rust core) | Vendored in `web/s2/wasm/` |
| hyparquet 1.26 | VNF + S2-archive Parquet reads | Vendored (`web/vendor/hyparquet/`) |

Everything else uses browser/Node.js builtins:
WebRTC, IndexedDB, Web Workers, Fetch, Canvas, WebSocket,
TextEncoder/Decoder, Blob, crypto (Node), http (Node).

## S2 Detection Algorithm

Sentinel-2 L2A at 20m resolution via Element84 STAC COGs.
Runs entirely client-side in a Web Worker with windowed reads (geotiff.js).

Processing uses fixed 256x256 pixel blocks within each tile.
Each block is identified by `{mgrs}_{row}_{col}` and cached by `block_id:date`.

```
Per-block pipeline (fused into minimal passes):

  1. STAC search for L2A images in viewport (no scene-level cloud filter)
  2. Read SCL band first for cloud check
  3. Cloud check via SCL: skip blocks >75% cloud; mark blocks >30% as not cloud-free
     (for persistence metric — blocks between 30-75% are still processed)
  4. Read B12, B11, B8A bands (windowed, 10px overlap)
  5. Pre-pass: B12 DN -> reflectance, collect background for median
  6. Fused pass: B11/B8A DN -> reflectance + brightness + contrast + thermal -> mask
     - Brightness:  B12 > 0.3 AND B11 > 0.2
     - Contrast:    B12 > median(background) * 3.0, floor 0.15
     - Thermal:     NHISWNIR = (B11 - B8A) / (B11 + B8A) > 0 OR saturation
  7. Connected components (BFS, 4-connectivity)
  8. Cluster filters: size, peak, peakedness, single-pixel, warm-region halo
  9. Overlap dedup: canonical block via floor(pixel / 256)

Each detection also carries glint/spectral annotations (s2e core; the
glint geometry helpers are re-exported from `web/s2/score.js`):
  - sun_elevation/sun_azimuth (STAC view extension, via stac.js)
  - glint_angle = 90 - sun_elevation; glint_score (1.0 ≤25°, →0 at 65°)
  - peak_b11, b12_b11_ratio (flames are hot, ratio >~1.3; glint is flat ~1.0)

Cross-date clustering (main thread, grid-indexed):
  - Anchor-based merge, configurable radius (0-200m, default 135m)
  - Minimum 4 distinct dates per cluster
  - Minimum average B12 per cluster: 0.85 (adjustable via UI slider) — the
    active quality gate
  - Glint false-positive flag: clusters whose minimum per-look glint_score is
    high (high-sun geometry across every look, no flame spectral evidence) are
    warned. Derived from sun_elevation, so it works on synced detections too.
    Replaces the old Apr–Aug seasonal heuristic.
  - Persistence metric: detections / observations per cluster
  - Cloud-free %: fraction of observations with ≤30% cloud (data quality indicator)

Cluster quality score (vision-validated methodology, web/s2/score.js) — computed
and shown in the detail card, NOT yet a gate. The formula was tuned in
~/Research/permian-flaring against an unbiased 2,826-site aerial study (sql/30):
  - total_score = 0.50·ratio_score
                + 0.40·persistence_score·(0.1 + 0.9·ratio_score)
                − 0.40·min_glint_score        (range −0.40 … +0.90)
  - ratio_score (0–1): smooth ramp on the B12/B11 ratio over 1.1→1.7 — the
    strongest precision signal. Peak-B12 brightness is FLAT as a ranking term and
    is dropped from the score (it is the recall floor, i.e. the avg-B12 gate).
  - persistence_score (0–1): the clear-sky share lit, n_dates / cloud-free obs.
    Its weight ramps with the ratio (the 0.1 floor keeps dim-but-real pads
    ordered); a flat additive persistence rewarded static reflectors.
  - glint_penalty (−0.40–0): linear in the cluster's MINIMUM per-look glint_score
    — a real flare fires across many sun geometries so its min drops low;
    geometric glint stays high. (permian's three hard gates — far-from-facility,
    on-building, on-road — need ground layers unavailable client-side, so they do
    not port; and the retired openflaring score's S3 corroboration term is not
    carried — no Sentinel-3 client-side.)
  - ratio_score needs B12/B11, which the binary sync codec does NOT carry. So
    synced/legacy detections have a null ratio and score on persistence·0.1 −
    glint alone. Until the ratio is added to the codec (a format change), the
    score is display-only and the avg-B12 slider stays the gate.
    `clusterDetections` accepts an optional `scoreThreshold` (default 0/off).
```

## VNF Data Pipeline

The pipeline lives in the sibling etl repo (`~/Tools/etl`, see `vnf/REBUILD.md`).
It generates the calendar itself — every flare, every night from 2012-03-01 to
wherever the cloud series ends, about five days back — and lets EOG supply
detections only, so a night with no detection is a row saying "nothing seen",
not an absence. Whether we could have seen anything
is our own call: ERA5 total cloud cover sampled at each site's real VIIRS
overpass hours, clear at `tcc < 0.6`.

```
flare × night calendar → EOG profile CSVs   → detections (Planck fits)
                       → ERA5 tcc at overpass hours → clear / unobserved
                       → terminals.geojson (6 km) → flare index (type, category, country)
```

Daily parquet (`views/vnf/data.parquet`): `flare_id, lat, lon, date, clear,
detected, tcc, rh_mw, temp_k, flow_mcm, looks, profiled`. `clear` is BOOLEAN and
NULL means unobserved — never conflate it with cloudy. `profiled` survives from
the old build and still gates the same way, but it now says a satellite flew and
we read the sky rather than that EOG chose to write a row; 98.8% of flare-nights
across the archive are observed. `type, category, country` moved out to
`views/vnf/flares.parquet` and `n_passes` is gone. Coordinates are stable
per-flare averages (from profile passes), not per-pass positions. `flow_mcm` carries
EOG's own per-pass `Flow_Rate` (daily-averaged like `rh_mw`; 0 on
nightly-backfilled rows — the ez CSVs have no flow) but is NOT displayed:
the UI's MCM/d column is `rh_mw × 0.0315`, the JZ-RH VNF v3 calibration
(Zhizhin et al. 2025, Energies 18:4765 — BCM/yr = 0.0115×RH, metered-flare
validated). EOG's `Flow_Rate` implements the legacy Cedigaz power law, which
that paper shows overestimates dim flares and underestimates bright ones.

The archive also carries the RAW per-pass form at `views/vnf/passes/data.parquet`
(`make -C ../etl vnf-raw`): the EOG profile CSVs concatenated verbatim —
EOG's own columns (`Date_Mscan, Temp_BB, RH, RHI, Flow_Rate, Cloud_Mask,
QF_Detect, …`), 999999 sentinels kept, row groups clustered by `flare_id` —
so queries can go straight to EOG's numbers without trusting the aggregation.
Rebuild + re-upload after `make -C ../etl vnf-profiles` refreshes the CSVs. (The nightly backfill appends to the AGGREGATE only; the raw parquet is
profiles-only and regenerates from the CSV corpus.)

The viewport tier is `views/vnf/quarters.parquet` (flare × quarter, last four
calendar years): `days, profiled_days, clear_days, detected_days,
detected_any_days, rh_sum, rh_max`. `days` is the exact night count in the
quarter, `detected_days` counts detections on nights we could see, and
`detected_any_days` counts every detection including cloudy ones. **Never divide
`detected_any_days` by `clear_days`** — that pairing is what broke `lng-flaring`.

The web query sums those to `total_dates`, `profiled_dates`, `clear_dates`,
`detection_dates`, `detection_any` per flare, and returns a detection list with
`date, rh_mw`. Two ratios come out of it:

- `persistence` = `detection_dates / clear_dates` — numerator and denominator on
  the same nights, so it is a rate. Null, not 0, where `clear_dates` is 0 (a
  window holding no clear night measures nothing) or where `coverage` falls
  below `COVERAGE_MIN`. The card shows '—' and the layer filter drops the flare
  rather than ranking it.
- `avg_rh` = `rh_sum / detection_any` — `rh_sum` spans every detection, so its
  mean divides by every detection.

`coverage` is `profiled_dates / total_dates`: the share of the selected window's
nights we read the sky for, over the exact night count rather than a 91-night
approximation. The calendar ends where the cloud series ends, so it no longer
counts nights ERA5 has not reached; what is left to catch is platform outages,
and those are per-site — one platform grounded still leaves the other flying,
and a single platform does not reach every site every night. `COVERAGE_MIN`
(0.8) is therefore a per-site gate rather than a per-quarter one: whole quarters
average 0.86–1.00 read, and the flares falling below the threshold are the ones
an outage covered — 708 and 644 of ~11,800 mapped flares in the two 2024 outage
quarters, 289 of 6,982 in the quarter in progress. See
`data-desk/docs/archive/vnf.md`.

## P2P Sync

Two LWW-Maps in a shared CRDT document:
- `detections`: `block_id:date` -> detection array
- `processed`: `block_id:date` -> `[lat, lng]` (cloud-free) or `null` (cloudy)
  Binary codec: 4 bytes (2x i16), cloudy sentinel `i16(32767), i16(0)`

Persisted locally via IndexedDB, synced via WebRTC DataChannels +
custom binary sync protocol (state vectors, diffs, live updates).

Distributed detection: blocks are partitioned across peers by hashing
the cache key. Partition updates are sent to workers live (no restart).

## Signaling

WebSocket pub/sub relay for WebRTC signaling. Clients send JSON messages:
`subscribe`, `unsubscribe`, `publish`, `ping`/`pong`.

**Local dev:** `signal/server.js` — stateless relay implementing RFC 6455
framing over `node:http` + `node:crypto`. Zero npm dependencies.
Runs on `ws://localhost:4444` via `make signal`.

**Production:** `signal/worker.js` — Cloudflare Worker with a Durable Object
using the WebSocket Hibernation API. Subscriptions are stored via
`serializeAttachment`/`deserializeAttachment` so they survive hibernation.
All connections route to a single global Durable Object (`idFromName('global')`).
Deploy with `npx wrangler deploy` (config in `wrangler.toml`).
URL: `wss://burnoff-signaling.louis-6bf.workers.dev`.

The signaling URL is set via `<meta name="signaling-url">` in `index.html`.
