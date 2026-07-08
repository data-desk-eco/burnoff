// main-thread orchestrator: mode switching (S2 archive / local detect / VNF),
// map layers, legend and control wiring. the generic map shell lives in map.js,
// the quarter picker in quarters.js, the info card in card.js and the local
// detect + P2P subsystem in detect.js.

import { initVNF, resetVNF, queryVNF, queryVNFFlare, availableQuartersVNF, isReady as vnfReady } from './vnf.js';
import { initS2Archive, queryS2Archive, availableQuartersS2, isReady as s2ArchiveReady, isCovered, coverageTiles, whenCovered } from './s2archive.js';
import { MODE, RAMP, markIconExpr, ICON_SIZE, buildKeyHTML, loadMarks } from './render.js';
import { createMap, ensureMark, addSatellite, viewportBbox, padBbox, featureBbox, wireWorldmap, boxesWorldmap, hoverPopup, wireCollapse } from './map.js';
import { initQuarterPicker, getSelectedDateRange, setQuarterHint, quarterButtons, quarterKey } from './quarters.js';
import { initDetect, ensureDetect, isDetecting, updateDetectionSource, getDetectedQuarters, updateDetectButton, MIN_DETECT_ZOOM } from './detect.js';
import { initCard, showInfo, closeInfo, refreshCard, reselectCurrentFeature, setHashSuppressed } from './card.js';
import { setTerminals, archiveFeature, enrichVNFFeatures } from './clustering.js';

// ---------------------------------------------------------------------------
// Build config (index.html meta tags) + mode state ('s2' or 'vnf')
// ---------------------------------------------------------------------------

maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

const OGIM_BUCKET = document.querySelector('meta[name="ogim-bucket"]')?.content;
const OGIM_URL = OGIM_BUCKET ? `${OGIM_BUCKET}/ogim.pmtiles` : 'data/ogim.pmtiles';

// VNF parquet lives in the shared s2-flares CloudFerro archive at a stable key
// (vnf/data.parquet) — public-read, DuckDB range-reads it remotely. Set via
// <meta name="vnf-url">; localhost (or an unset url) falls back to a local build.
const VNF_URL = document.querySelector('meta[name="vnf-url"]')?.content || '';
const vnfUrl = () => (location.hostname === 'localhost' || !VNF_URL) ? 'vnf.parquet' : VNF_URL;

// S2 mode reads the precomputed cluster view straight from the CloudFerro parquet
// archive (s2-flares `box.sh publish`); the in-browser COG worker ("Detect")
// stays as the fallback for areas not yet archived. Warm DuckDB + the archive
// cache at page parse, overlapping maplibre init, so points are ready the moment
// s2 mode becomes active (incl. back from vnf).
const S2_ARCHIVE = document.querySelector('meta[name="s2-archive"]')?.content || '';
if (S2_ARCHIVE) initS2Archive(S2_ARCHIVE);

const MIN_ARCHIVE_ZOOM = 4;   // displaying precomputed archive clusters (cheap, in-memory)
const MIN_VNF_ZOOM = 6;

let currentMode = null;
const modeConf = () => MODE[currentMode] || MODE.s2;

// Slider state. The avg-B12 / avg-RH intensity gate is the active quality gate;
// the persistence gate is display-only (a layer filter, no re-cluster).
let CLUSTER_AVG_B12_MIN = MODE.s2.filter.default;
let VNF_AVG_RH_MIN = MODE.vnf.filter.default;
let CLUSTER_PERSISTENCE_MIN = 0.25;

// ---------------------------------------------------------------------------
// Map + panels
// ---------------------------------------------------------------------------

const map = createMap({ center: [51.52, 25.92], zoom: 12, minZoom: 1.5, maxZoom: 18 });

// Mollweide world maps: viewport box in the main panel (pdf:83), archive
// coverage boxes in the intro panel (pdf:86).
wireWorldmap(map, document.getElementById('world-map'));
boxesWorldmap(document.getElementById('modal-worldmap'), async () => {
    if (!S2_ARCHIVE) return null;
    await whenCovered();
    return coverageTiles()?.features.map(featureBbox);
}, 0.06);

wireCollapse([[['collapse-toggle', 'collapse-title'], 'title-panel'], [['info-collapse', 'info-name'], 'info']]);

// Intro panel: Enter (or the overlay) dismisses; the ⓘ button reopens (pdf:82).
document.getElementById('about-modal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.add('hidden');
});
document.getElementById('enter-btn').addEventListener('click', () =>
    document.getElementById('about-modal').classList.add('hidden'));
document.getElementById('info-btn').addEventListener('click', () =>
    document.getElementById('about-modal').classList.remove('hidden'));
document.getElementById('methods-toggle').addEventListener('click', function() {
    this.querySelector('.dd-chevron').classList.toggle('dd-chevron-down');
    document.getElementById('methods-list').classList.toggle('hidden');
});

// ---------------------------------------------------------------------------
// Detection layer (shared by all modes) + subsystem wiring
// ---------------------------------------------------------------------------

function ensureDetectionLayer() {
    if (!map.isStyleLoaded()) {
        map.once('styledata', renderDetections);
        return;
    }
    if (!map.getSource('client-detections')) {
        map.addSource('client-detections', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('client-detection-circles')) {
        // flare markings stepped through the intensity ramp (missing images
        // resolve via the styleimagemissing handler)
        map.addLayer({
            id: 'client-detection-circles',
            type: 'symbol',
            source: 'client-detections',
            layout: {
                'icon-image': markIconExpr(modeConf()),
                'icon-size': ICON_SIZE,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            }
        });
        applyPersistenceFilter();
    }
}

// Display-only persistence gate: hide clusters below the slider threshold without
// re-clustering. Every feature builder (archive/cluster/VNF) sets `persistence`.
function applyPersistenceFilter() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setFilter('client-detection-circles',
        ['>=', ['coalesce', ['get', 'persistence'], 0], CLUSTER_PERSISTENCE_MIN]);
}

// detect.js render callback: re-draw the s2 view after CRDT/worker updates
function renderDetections() {
    if (currentMode !== 's2') return;
    ensureDetectionLayer();
    refreshS2View();
}

initDetect({
    map,
    render: renderDetections,
    updateQuarters: () => updateQuarterIndicators(),
    minAvgB12: () => CLUSTER_AVG_B12_MIN,
});
initCard({
    map,
    modeConf,
    isVnf: () => currentMode === 'vnf',
    hasArchive: !!S2_ARCHIVE,
});

// ---------------------------------------------------------------------------
// Quarter picker + availability indicators
// ---------------------------------------------------------------------------

// Date span the quarter grid covers (last 4 calendar years) — bounds the VNF
// availability query so it stays cheap.
const GRID_START = `${new Date().getFullYear() - 3}-01-01`;
const GRID_END = `${new Date().getFullYear()}-12-31`;

initQuarterPicker(() => {
    if (currentMode === 'vnf') {
        scheduleVNFRefresh();
    } else {
        updateDetectButton();
        scheduleS2Refresh();
    }
    // Re-filter the open card to the new window (the async re-query reconciles the map).
    refreshCard();
});
updateQuarterIndicators();

// Mark each quarter button: 'detected' (local-worker S2, already processed) or
// 'unavailable' (archive/VNF, no data in this viewport). A null `avail` means the
// data source isn't ready / zoomed-out — leave everything enabled. Uncovered S2
// viewports fall through to the detect branch (same coverage test that reveals the
// Detect button) so quarters stay selectable for the local-worker fallback.
async function updateQuarterIndicators() {
    const btns = quarterButtons();

    if (currentMode === 'vnf' || (S2_ARCHIVE && isCovered(viewportBbox(map)))) {
        btns.forEach(b => b.classList.remove('detected'));
        const isVnf = currentMode === 'vnf';
        const ready = isVnf ? vnfReady() : s2ArchiveReady();
        const zoomOk = map.getZoom() >= (isVnf ? MIN_VNF_ZOOM : MIN_DETECT_ZOOM);
        let avail = null;
        if (ready && zoomOk) {
            try {
                avail = isVnf
                    ? await availableQuartersVNF(padBbox(viewportBbox(map)), GRID_START, GRID_END)
                    : await availableQuartersS2(padBbox(viewportBbox(map)));
            } catch (err) { console.error('quarter availability error:', err); }
        }
        btns.forEach(b => b.classList.toggle('unavailable', !!avail && !avail.has(quarterKey(b))));
        // every selected quarter is unavailable here → the map is blank; say why.
        const blank = !!avail && !Array.from(btns).some(b => b.classList.contains('active') && avail.has(quarterKey(b)));
        setQuarterHint(blank ? `No ${isVnf ? 'VNF' : 'archive'} data for the selected quarters here` : '');
        return;
    }

    setQuarterHint('');
    btns.forEach(b => b.classList.remove('unavailable'));
    const quarters = getDetectedQuarters();
    btns.forEach(b => b.classList.toggle('detected', quarters.has(quarterKey(b))));
    updateDetectButton(quarters);
}

// ---------------------------------------------------------------------------
// VNF mode
// ---------------------------------------------------------------------------

let _vnfInitStarted = false;
let _vnfRawFeatures = null;   // raw features from last queryVNF
let _vnfRefreshTimer = null;

async function refreshVNF() {
    if (currentMode !== 'vnf' || !vnfReady()) return;
    if (map.getZoom() < MIN_VNF_ZOOM) {
        _vnfRawFeatures = null;
        map.getSource('client-detections')?.setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const dateRange = getSelectedDateRange();
    if (!dateRange) return;

    try {
        const fc = await queryVNF(viewportBbox(map), dateRange.startDate, dateRange.endDate);
        _vnfRawFeatures = fc.features;
        ensureDetectionLayer();
        if (currentMode === 'vnf') updateVNFSource();
    } catch (err) {
        console.error('VNF query error:', err);
    }
}

function scheduleVNFRefresh() {
    clearTimeout(_vnfRefreshTimer);
    _vnfRefreshTimer = setTimeout(refreshVNF, 200);
}

function updateVNFSource() {
    if (!_vnfRawFeatures) return;
    map.getSource('client-detections')?.setData({
        type: 'FeatureCollection',
        features: enrichVNFFeatures(_vnfRawFeatures, VNF_AVG_RH_MIN)
    });
}

// ---------------------------------------------------------------------------
// S2 archive mode — read precomputed detections straight from the parquet
// archive for the current viewport. Falls back to whatever is already in the
// CRDT (local-worker / synced detections) when the archive has nothing here.
// ---------------------------------------------------------------------------

let _s2RefreshTimer = null;

// Archive builds serve precomputed clusters, so the local-worker detect path — and
// the P2P mesh that shares its workload — only make sense where the archive has no
// coverage. Reveal Detect / peer status / merge slider there; hide them where the
// archive serves. No-op in pure detect builds (no <meta s2-archive>), which always
// expose the controls. Coverage is an in-memory bbox test (one listing at init).
function updateS2Controls() {
    if (!S2_ARCHIVE) return;
    const show = currentMode === 's2' && s2ArchiveReady() &&
        map.getZoom() >= MIN_DETECT_ZOOM && !isCovered(viewportBbox(map)) && !isDetecting();
    // Outside archive coverage the Detect/P2P path is live — load the CRDT lazily.
    if (show) ensureDetect();
    for (const sel of ['#peer-status', '#detect-area'])
        document.querySelector(sel).style.setProperty('display', show ? '' : 'none');
}

async function refreshS2Archive() {
    updateS2Controls();
    if (currentMode !== 's2' || !S2_ARCHIVE || isDetecting()) return;
    if (!s2ArchiveReady() || map.getZoom() < MIN_ARCHIVE_ZOOM) { updateDetectionSource(); return; }
    const dateRange = getSelectedDateRange();
    if (!dateRange) { updateDetectionSource(); return; }
    try {
        const clusters = await queryS2Archive(viewportBbox(map), dateRange.startDate, dateRange.endDate);
        if (currentMode !== 's2' || isDetecting()) return;
        const features = clusters.filter(c => c.avg_b12 >= CLUSTER_AVG_B12_MIN).map(archiveFeature);
        if (!features.length) { updateDetectionSource(); return; }
        ensureDetectionLayer();
        map.getSource('client-detections')?.setData({ type: 'FeatureCollection', features });
    } catch (err) {
        console.error('S2 archive query error:', err);
        updateDetectionSource();
    }
}

function scheduleS2Refresh() {
    if (!S2_ARCHIVE) return;
    clearTimeout(_s2RefreshTimer);
    _s2RefreshTimer = setTimeout(refreshS2Archive, 200);
}

// Refresh the whole s2 view. In archive builds the archive overlay owns the
// `client-detections` source, so a plain updateDetectionSource() (CRDT only)
// would wipe it — route through the archive path, which falls back to the CRDT
// where the archive is empty. Used by the sync-debounce and slider callers.
function refreshS2View() { if (S2_ARCHIVE) refreshS2Archive(); else updateDetectionSource(); }

// Kick the archive when entering s2 mode; initS2Archive memoizes, so this only
// awaits the warm-up fired at page parse before refreshing the viewport.
function ensureS2Archive() {
    if (!S2_ARCHIVE) return;
    initS2Archive(S2_ARCHIVE)
        .then(() => { if (currentMode === 's2') { refreshS2Archive(); updateQuarterIndicators(); } })
        .catch(err => console.error('S2 archive init error:', err));
}

// ---------------------------------------------------------------------------
// Mode switching + legend
// ---------------------------------------------------------------------------

function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.getElementById('title-panel').classList.toggle('mode-s2', mode === 's2');

    closeInfo();
    updateLegend();

    // Events header columns + subtitle
    const cfg = MODE[mode];
    document.getElementById('mode-subtitle').textContent = cfg.subtitle;
    document.getElementById('events-col2').textContent = cfg.col2;
    document.getElementById('events-col3').textContent = cfg.col3;

    // Reconfigure the intensity slider for the mode
    const intRange = document.getElementById('intensity-range');
    const flt = cfg.filter;
    const curIntensity = mode === 'vnf' ? VNF_AVG_RH_MIN : CLUSTER_AVG_B12_MIN;
    intRange.min = flt.min; intRange.max = flt.max; intRange.step = flt.step; intRange.value = curIntensity;
    document.getElementById('intensity-value').textContent = cfg.formatFilter(curIntensity);

    // Update quarter indicators immediately (un-grey in VNF, mark detected in S2)
    updateQuarterIndicators();

    if (mode === 'vnf') {
        // Clear S2 features immediately so they don't linger during VNF load
        ensureDetectionLayer();
        map.getSource('client-detections')?.setData({ type: 'FeatureCollection', features: [] });

        if (!_vnfInitStarted) {
            _vnfInitStarted = true;
            initVNF(vnfUrl()).then(() => {
                if (currentMode === 'vnf') { refreshVNF(); updateQuarterIndicators(); }
            }).catch(err => {
                console.error('VNF init error:', err);
                _vnfInitStarted = false;
                resetVNF();
                switchMode('s2');
            });
        } else if (vnfReady()) {
            refreshVNF();
        }
    } else {
        // Restore S2 features, then overlay the archive for this viewport.
        ensureDetectionLayer();
        updateDetectionSource();
        ensureS2Archive();
    }

    updateS2Controls();
    updateCirclePaint();
}

// Key panel: intensity ramp + infrastructure sections, collapsible, with the
// OGIM rows doubling as layer toggles (inactive rows grey out).
const _keyState = { open: true, ogim: false, pipes: false };
function updateLegend() {
    document.getElementById('key-panel').innerHTML = buildKeyHTML(modeConf(), _keyState);
}

function updateCirclePaint() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setLayoutProperty('client-detection-circles', 'icon-image', markIconExpr(modeConf()));
}

// Key panel: whole-legend collapse + OGIM layer toggles (delegated — rebuilt on mode switch)
document.getElementById('key-panel').addEventListener('click', e => {
    if (e.target.closest('.key-head')) {
        _keyState.open = !_keyState.open;
        return updateLegend();
    }
    const t = e.target.closest('.key-toggle');
    if (!t) return;
    const name = t.dataset.layer;
    const on = (_keyState[name] = !_keyState[name]);
    const ids = name === 'ogim' ? ['ogim-facilities', 'ogim-wells'] : ['ogim-pipelines'];
    for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    updateLegend();
});

// Key needs the inline marking svgs before first render.
loadMarks().then(updateLegend);

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

let _sliderTimer = 0;
function debouncedRecluster() {
    clearTimeout(_sliderTimer);
    _sliderTimer = setTimeout(() => {
        if (currentMode === 'vnf') updateVNFSource();
        else refreshS2View();
        reselectCurrentFeature();
    }, 80);
}

document.getElementById('intensity-range').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    if (currentMode === 'vnf') VNF_AVG_RH_MIN = val;
    else CLUSTER_AVG_B12_MIN = val;
    document.getElementById('intensity-value').textContent = modeConf().formatFilter(val);
    debouncedRecluster();
});

document.getElementById('persistence-range').addEventListener('input', e => {
    CLUSTER_PERSISTENCE_MIN = parseFloat(e.target.value);
    document.getElementById('persistence-value').textContent = `${Math.round(CLUSTER_PERSISTENCE_MIN * 100)}%`;
    applyPersistenceFilter();   // display-only: just re-filter, no recluster
});

// ---------------------------------------------------------------------------
// Map layers + interaction
// ---------------------------------------------------------------------------

let _quarterIndicatorTimeout;
map.on('moveend', () => {
    clearTimeout(_quarterIndicatorTimeout);
    _quarterIndicatorTimeout = setTimeout(updateQuarterIndicators, 300);
    if (currentMode === 'vnf') {
        scheduleVNFRefresh();
    } else {
        updateDetectButton();
        scheduleS2Refresh();
    }
});

map.on('load', () => {
    addSatellite(map);

    // Preload the marking images every layer references.
    [`flare-${RAMP[0]}`, `flare-${RAMP[1]}`, `flare-${RAMP[2]}`,
     'triangle-#FFFFFF', 'square-#FFFFFF', 'highlight-#FFFFFF'].forEach(id => ensureMark(map, id));

    // LNG terminal dots: triangle marking = structure, with a generous hit area
    fetch('terminals.geojson').then(r => r.json()).then(geojson => {
        geojson.features = geojson.features.filter(f => f.properties.type === 'export');
        setTerminals(geojson.features);
        map.addSource('lng-terminals', { type: 'geojson', data: geojson });
        map.addLayer({
            id: 'lng-terminal-hitarea',
            type: 'circle',
            source: 'lng-terminals',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 6, 16, 12, 22],
                'circle-color': 'transparent',
                'circle-opacity': 0
            }
        });
        map.addLayer({
            id: 'lng-terminal-dots',
            type: 'symbol',
            source: 'lng-terminals',
            layout: {
                'icon-image': 'triangle-#FFFFFF',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.65, 12, 0.9],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            }
        });
        hoverPopup(map, 'lng-terminal-hitarea', p =>
            `<span class="dd-title">${p.name}</span><br>${p.country} · ${p.type}<br>` +
            (p.capacity_mtpa ? `${p.capacity_mtpa} mtpa` : '—'));
    });

    // OGIM infrastructure overlay (PMTiles vector tiles), toggled from the key
    try {
        map.addSource('ogim', { type: 'vector', url: `pmtiles://${OGIM_URL}`, maxzoom: 14 });
        const ogimBefore = map.getLayer('lng-terminal-hitarea') ? 'lng-terminal-hitarea' : undefined;

        map.addLayer({
            id: 'ogim-pipelines',
            type: 'line',
            source: 'ogim',
            'source-layer': 'pipelines',
            minzoom: 6,
            layout: { visibility: 'none' },
            paint: {
                'line-color': '#808080',
                'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 1.5]
            }
        }, ogimBefore);

        map.addLayer({
            id: 'ogim-facilities',
            type: 'symbol',
            source: 'ogim',
            'source-layer': 'facilities',
            minzoom: 6,
            layout: {
                visibility: 'none',
                'icon-image': 'square-#FFFFFF',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 0.6, 16, 0.9]
            },
            paint: { 'icon-opacity': 0.8 }
        }, ogimBefore);

        map.addLayer({
            id: 'ogim-wells',
            type: 'symbol',
            source: 'ogim',
            'source-layer': 'wells',
            minzoom: 8,
            layout: {
                visibility: 'none',
                'icon-image': 'square-#FFFFFF',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.25, 12, 0.4, 16, 0.6]
            },
            paint: { 'icon-opacity': 0.5 }
        }, ogimBefore);
    } catch (e) {
        console.warn('OGIM layers not available:', e.message);
    }

    // Selection: heavy-stroke empty highlight box marking around the resolved poi
    map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'selection-highlight',
        type: 'symbol',
        source: 'selection-highlight',
        layout: {
            visibility: 'none',
            'icon-image': 'highlight-#FFFFFF',
            'icon-size': 1.2,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
        }
    });

    const MIN_INTERACTIVE_ZOOM = 10;

    map.on('mouseenter', 'client-detection-circles', () => {
        if (map.getZoom() >= MIN_INTERACTIVE_ZOOM) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'client-detection-circles', () => {
        map.getCanvas().style.cursor = '';
    });

    map.on('click', e => {
        if (!map.getLayer('client-detection-circles')) { closeInfo(); return; }
        const tolerance = 15;
        const bbox = [[e.point.x - tolerance, e.point.y - tolerance], [e.point.x + tolerance, e.point.y + tolerance]];
        const features = map.queryRenderedFeatures(bbox, { layers: ['client-detection-circles'] });
        if (features.length === 0) { closeInfo(); return; }

        let closest = features[0], minDist = Infinity;
        for (const f of features) {
            const [lng, lat] = f.geometry.coordinates;
            const dist = Math.hypot(lng - e.lngLat.lng, lat - e.lngLat.lat);
            if (dist < minDist) { minDist = dist; closest = f; }
        }

        if (map.getZoom() < MIN_INTERACTIVE_ZOOM) {
            map.flyTo({ center: closest.geometry.coordinates, zoom: MIN_INTERACTIVE_ZOOM });
            return;
        }
        showInfo(closest);
        map.flyTo({ center: closest.geometry.coordinates, zoom: Math.max(map.getZoom(), 15) });
    });

    // Start in S2 mode (or VNF if a deep link is present)
    const flareId = parseFlareHash();
    if (flareId) navigateToFlare(flareId);
    else switchMode('s2');
});

// ---------------------------------------------------------------------------
// Startup + deep links
// ---------------------------------------------------------------------------

// Archive builds start with the detect/P2P controls hidden; updateS2Controls reveals
// them — and lazily loads the CRDT — once the viewport lands outside MGRS coverage.
// A pure-detect build (no archive) is all-detect, so load the CRDT up front.
if (S2_ARCHIVE) updateS2Controls();
else ensureDetect();

/** Parse #vnf/{flare_id} from location hash. Returns flare ID or null. */
function parseFlareHash() {
    const m = location.hash.match(/^#vnf\/(\d+)$/);
    return m ? Number(m[1]) : null;
}

// Deep link: navigate to a VNF flare by hash (#vnf/12345)
async function navigateToFlare(flareId) {
    setHashSuppressed(true);
    const done = () => setHashSuppressed(false);

    // Ensure VNF mode is active and initialized (initVNF is triggered by switchMode)
    if (currentMode !== 'vnf') switchMode('vnf');
    const deadline = Date.now() + 15000;
    while (!vnfReady() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
    }
    if (!vnfReady()) return done();

    const dateRange = getSelectedDateRange();
    if (!dateRange) return done();

    const fc = await queryVNFFlare(flareId, dateRange.startDate, dateRange.endDate);
    const enriched = enrichVNFFeatures(fc.features.slice(0, 1), VNF_AVG_RH_MIN);
    if (!enriched.length) return done();

    const feature = enriched[0];
    map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 12) });

    // Wait for map to settle, then refresh VNF layer and show info
    map.once('idle', () => {
        refreshVNF().then(() => {
            showInfo(feature);
            done();
        });
    });
}

// Handle back/forward navigation
window.addEventListener('hashchange', () => {
    const flareId = parseFlareHash();
    if (flareId) navigateToFlare(flareId);
});
