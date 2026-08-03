# Burnoff

Client-side Sentinel-2 SWIR flare detection with P2P sync, plus a
VIIRS Nightfire (VNF) mode for browsing EOG's satellite flare catalog.

Zero npm dependencies. The only external libraries are MapLibre GL (map
rendering), geotiff.js (COG reads), DuckDB-Wasm with spatial support, and the
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
     Element84 STAC API          DuckDB-Wasm
     Sentinel-2 L2A COGs         VNF Parquet (CloudFerro archive)
     (B12, B11, B8A, SCL)
```

**S2 mode:** The default data source reads the Data Desk Sentinel-2 tables
straight from the CloudFerro public parquet archive. `data-desk/flares/data.parquet`
is **one object** — one row per cluster, with the site's quarterly history nested
in a `quarters` list — so `web/s2archive.js` reads it once through Cartograph's
DuckDB layer and serves every viewport from those rows (bbox + date-overlap
filter). There is no bucket listing and no MGRS partition: the archive partitions
only past 250 MB, and it partitions on `cell`, an H3 resolution-1 index a reader
calculates from a position rather than discovers by listing. The per-date series
left the cluster row with the old view — it lives in
`data-desk/detections/data.parquet` (`kind = 'flare'`, joined on `site_id`) and is
fetched per cluster when a card opens. `archiveFeature` maps a row straight to the
Feature shape `crossDateCluster` emits, so the avg-B12 slider gates client-side
but the server-side clustering is not re-run.

**Persistence history (resolved 2026-07-31).** For a period the cluster view
carried `persistence` NULL and `persistence_score` 0 for 9,595 of its 9,603
clusters, so `total_score` lost its `0.40·persistence_score` term while keeping
the glint penalty and the archive's mean score was −0.126. The cause was not a
deletion: 125 of the 126 detection tiles arrived in a single bulk parquet import
(2026-07-18) with no canonical records and **no cloud masks**, so the clear-sky
denominator was never computed for them rather than lost. Compounding it, the
detector ran `--source cdse-l1c` while its cloud mask reads SCL, which only L2A
carries — so flare runs wrote empty cloud records regardless.

Both are fixed: `s2e` v0.2.0 resolves SCL from the L2A twin of each acquisition
whatever `--source` asks for, and a full coverage scan (139,478 scenes, archived
at `ops/s2e-coverage/`) rebuilt the view on 2026-07-31 — all 9,603 clusters now
carry a measured persistence. Re-deriving it costs ~20 s via
`s2e cluster --coverage-scan <dir> --coverage-reuse`.

**That rebuild then deflated every persistence by roughly four (found and fixed
2026-07-31, view republished the same day).** The scan dir is windowless and
resumable: it holds every scene ever sampled, 2015→2026. The detections it is the
denominator for cover whatever window was actually run — 2025 for most tiles. The
aggregation read the whole dir, so this year's detections were divided by a
decade of clear looks. The Sabine Pass flare, lit on 54 of its 60 clear looks in
2025, published 18%. This is the VNF calendar bug in another guise, and the rule
is the one that repo settled on: **numerator and denominator over the same looks,
or the rate is not a rate.** s2e v0.2.2 counts a clear look only where the
detector ran, evidenced by a detection in that tile on that date, and publishes no
persistence at all below ten measured looks.

The republished view (s2e v0.2.2 on a fleet box, `s2e cluster --archive …
--coverage-scan cov --coverage-reuse --out s3://…/data-desk/flares`; the binary does
not build on macOS — gdal and candle both fail): Sabine Pass 54/60 = 90%, median
persistence 1.8% → 4.3%, median denominator 169 → 84 looks, clusters clearing the
UI's 25% default 314 → 1,178, mean `total_score` −0.126 → −0.097, and 68 of 9,603
rows now carry no persistence because fewer than ten looks were measured. Repeat
it in ~2 min from the scan tarball in `ops/s2e-coverage/`, which is why that
tarball is kept.

**The looks are published, so do not recompute them.** Every flares row carries
`quarters`, its own history on the first-day-of-quarter key, and the struct is
the same one both providers write: `quarter, days, observations, clear,
detections, detections_clear, rh_sum, rh_max`. **`clear` is the cloud-free look
count persistence divides by; `observations` is every look an instrument took.**
Reading `observations` where `clear` belongs compiles, runs, and silently changes
what persistence means — so both modes go through one reducer, `sumQuarters`
(clustering.js), and the only numerator that pairs with `clear` is
`detections_clear`. `archiveFeature` sums the quarters the picker is showing and
divides the detections in those quarters by exactly those looks: numerator and
denominator over the same looks, no browser-side estimate. Below ten looks in the
selection it publishes no rate at all, the floor s2e applies to the whole-window
count (`MIN_LOOKS`, clustering.js).

The tables also publish a whole-history `persistence` column. **Do not wire it
through.** The app deliberately recomputes the rate over exactly the ticked
quarters; using the published one would compile, look right, and make the quarter
picker stop affecting the number.

`card.js` therefore computes no rate at all: it reports what the feature carries.
What it replaced was `detections / persistence` to recover the denominator, then
prorating that denominator by the share of quarters selected and re-dividing — a
guess wearing a measurement's clothes.

**Which means the card can go stale, and `refreshS2Archive` has to un-stale it.**
Each map dot now carries the numbers for the ticked quarters alone, rather than
the numbers for all time. Opening a card copies that dot's numbers; it does not
hold a live reference. So when the quarter picker changes, `refreshS2Archive`
rebuilds every dot with new numbers and the open card is left showing the copy it
took under the old selection — Q4 alone, still reading 90% over 60 looks. The last
line of that function calls `reselectCurrentFeature()`, which finds the dot at the
same coordinates and re-opens the card from it. VNF has always needed this;
before the features were quarter-scoped, S2 did not.

The `--clouds` fold-in path never had this bug: those masks are written during
detection, so they only ever cover scenes the detector actually read. It is the
default for a reason; the coverage scan is the fallback for the tiles whose
canonical records (and cloud masks) the bulk import lost.

A row that lacks a persistence — the 68 thin-look sites, and any tile a future
scan has not reached — carries no observation count either, so the card reads '—'
for both rather than passing off `date_count` as the nights we could have seen, and
the Minimum-persistence gate treats it as *unrated* (it passes) in S2 mode. VNF
keeps the opposite branch: there a null is a finding (no clear night in the
window) and the flare is dropped rather than ranked. Do not "simplify" the two
branches back into one — coalescing to 0 in S2 mode is what sank the whole
archive below the slider's 25% default. The in-browser COG detection worker (`detect-worker.js`, the "Detect"
button) is the fallback for areas not yet archived: it runs the s2e rust core
compiled to wasm (`web/s2/wasm/`), the SAME binary methodology as the server-side
archive — there is no JS detector port (it drifted from the core and was removed).
Peers share a single CRDT document, idle peers read
the job from awareness state, partition blocks by hash, and process their share,
merging results via LWW-Map CRDT. The CRDT/mesh stack is **loaded lazily**
(`ensureDetect()` dynamically imports crdt/sync/rtc/store) only when the viewport
sits outside the archive's coverage — a pure-archive session never fetches it. The
archive base is set via `<meta name="data-bucket">` in index.html.

**VNF mode:** Cartograph's DuckDB layer reads the EOG tables in the shared Data
Desk CloudFerro archive under the `eog/` provider prefix. Neither this module nor
index.html names an object: `<meta name="data-bucket">` gives the bucket, and the
archive index says which object each table is. The viewport reads
`eog/flares/data.parquet`: one row per site, 20,227 of them, each carrying its
own quarterly history in a `quarters` list, so a bbox predicate and a JS window
over that list are the whole viewport query.

The daily series is `eog/detections/cell=<h3>/data.parquet`, sorted by `site_id`
inside a cell, read only on card open. **Every row there is a positive
detection** — there is no `detected` column, because the looks that found nothing
are rows in `eog/observations` instead. `cell` is an H3 resolution-1 index of the
site's position, and the flares row carries it, so a card resolves to exactly one
object with no bucket listing and **no H3 library in the browser**: nothing in
burnoff ever calculates a cell, it only ever passes one on. Plumb `cell` through
any new feature builder for the same reason.

Burnoff does not read `eog/observations` at all. The quarters list already
carries the looks a rate divides by, windowed the same way the numerator is;
fetching the daily denominator as well would be a second, larger read of a number
the app already has, and two places to get the pairing wrong. See
`~/Tools/etl/sql/tables/` for the table definitions and their checks.

## Commands

```bash
make serve        # Dev server on :8000 + signaling on :4444
make signal       # Signaling server only
make test         # Run determinism + P2P retry tests
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
  clustering.js       Terminal grid, the shared quarters reducer (sumQuarters)
                      + archive/VNF feature builders
  vnf.js              VNF data module: DuckDB over eog/flares + eog/detections
  s2archive.js        S2 archive reader: DuckDB over data-desk/flares +
                      data-desk/detections, plus the coverage geojson
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
| DuckDB-Wasm lite | VNF and S2 archive Parquet reads | Vendored by Cartograph (`web/vendor/duckdb/`) |

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

The pipeline lives in the sibling etl repo (`~/Tools/etl`, provider `eog/`).
It generates the calendar itself — every flare, every night from 2012-03-01 to
wherever the cloud series ends, about five days back — and lets EOG supply
detections only, so a night with no detection is a row saying "nothing seen",
not an absence. Whether we could have seen anything
is our own call: ERA5 total cloud cover sampled at each site's real VIIRS
overpass hours, clear below 0.6.

```
flare × night calendar → EOG profile CSVs   → eog/detections  (12.3M rows)
                       → ERA5 cloud at overpass hours → eog/observations (106.3M)
                       → terminals.geojson (6 km) → eog/flares (20,227 sites)
```

The split is the point. `eog/detections/cell=<h3>/data.parquet` holds **only**
the nights a site was seen lit: `site_id, date, lat, lon, cell, rh_mw, temp_k,
rate_kg_h, satellite, scene, sector` plus the EOG extension `flow_mcm`. There is
no `detected` column, because a look that found nothing is a row in
`eog/observations` and nowhere else — `provider, kind, site_id, date, lat, lon,
cell, observed, clear, cloud, looks, scene, source, final`. `observed` already
applies the platform-outage test, `cloud` is a fraction 0..1, and `clear` is the
one threshold (`cloud < 0.6`) so the word means the same thing whichever
instrument looked. `flow_mcm` carries EOG's own `Flow_Rate` but is NOT displayed:
the UI's MCM/d column is `rh_mw × 0.0315`, the JZ-RH VNF v3 calibration
(Zhizhin et al. 2025, Energies 18:4765 — BCM/yr = 0.0115×RH, metered-flare
validated). EOG's `Flow_Rate` implements the legacy Cedigaz power law, which
that paper shows overestimates dim flares and underestimates bright ones.

The viewport tier is `eog/flares/data.parquet` — one row per site, `id, provider,
kind, lat, lon, cell, country, detail, first_seen, last_seen, detections,
active_days, observations, persistence, score, flags, quarters` — where
`quarters` is the site's own history rolled up over the last four calendar years,
a `STRUCT[]` of `quarter, days, observations, clear, detections,
detections_clear, rh_sum, rh_max`. `days` is the exact night count in the
quarter, `detections_clear` counts detections on nights we could see, and
`detections` counts every detection including cloudy ones. **Never divide
`detections` by `clear`** — that pairing is what broke `lng-flaring`.

`type` and `category` are gone: they are joined into one `detail` string, which
is what the map falls back to for a name when no terminal is within 7.5 km. Ids
are VARCHAR now (`flares.id`, and `detections.site_id`/`observations.site_id`
join to it), so do not coerce them with `Number()` — EOG's happen to look
numeric, and another provider's will not.

`siteFeatures` (vnf.js) windows `quarters` to the ticked span and sums it through
`sumQuarters`, giving `passes` (Σ observations), `observations` (Σ clear),
`detection_dates` (Σ detections_clear), `detection_any` (Σ detections), `rh_sum`
and `max_rh`. Two ratios come out of it:

- `persistence` = `detection_dates / observations` — numerator and denominator on
  the same nights, so it is a rate. Null, not 0, where the clear count is 0 (a
  window holding no clear night measures nothing) or where `coverage` falls
  below `COVERAGE_MIN`. The card shows '—' and the layer filter drops the flare
  rather than ranking it.
- `avg_rh` = `rh_sum / detection_any` — `rh_sum` spans every detection, so its
  mean divides by every detection.

`coverage` is `Σ observations / Σ days`: the share of the selected window's
nights we read the sky for, over the exact night count rather than a 91-night
approximation. The calendar ends where the cloud series ends, so it no longer
counts nights ERA5 has not reached; what is left to catch is platform outages,
and those are per-site — one platform grounded still leaves the other flying,
and a single platform does not reach every site every night. `COVERAGE_MIN`
(0.8) is therefore a per-site gate rather than a per-quarter one: whole quarters
average 0.86–1.00 read, and the flares falling below the threshold are the ones
an outage covered — 708 and 644 of ~11,800 mapped flares in the two 2024 outage
quarters, 289 of 6,982 in the quarter in progress. See
`~/Tools/etl/sql/tables/` — `flares.sql`, `detections.sql`, `observations.sql`
and their `*.checks.sql`, which state exactly what a reader may rely on.

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
