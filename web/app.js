// crdt/sync/rtc/store are loaded lazily by ensureDetect() — only outside the
// archive's coverage, where the Detect button + P2P mesh come into play. A
// pure-archive session never fetches them. These bindings stay null until then.
let LWWMap, Store, PeerMesh, geohash3, SyncManager, validateDetection;
import { initVNF, resetVNF, queryVNF, queryVNFFlare, availableQuartersVNF, isReady as vnfReady } from './vnf.js';
import { initS2Archive, queryS2Archive, availableQuartersS2, isReady as s2ArchiveReady, isCovered, coverageTiles, whenCovered } from './s2archive.js?v=14';
import { clusterDetections } from './s2/cluster.js';
import { wgs84ToUtm, utmToWgs84 } from './s2/geo.js';
import { MODE, RAMP, scaleT, rampRGB, chartNorm, buildKeyHTML, loadMarks, markIconExpr, ICON_SIZE, formatDate } from './render.js';
import { addMarking } from './vendor/dd/markings.js';
import { drawWorldmap, setBoxes } from './vendor/dd/worldmap.js';
import { setTerminals, findNearestTerminal, archiveFeature, enrichVNFFeatures, DEG_TO_RAD } from './clustering.js';
import { GeoTIFF } from './s2/vendor/geotiff-esm.js';

// ---------------------------------------------------------------------------
// Mode state: 'vnf' or 's2'
// ---------------------------------------------------------------------------

let currentMode = null;
let _vnfInitStarted = false;
let _vnfRawFeatures = null; // raw features from last queryVNF
let _vnfRefreshTimer = null;
let _s2InitStarted = false;
let _s2RefreshTimer = null;
let _suppressHashUpdate = false; // avoid feedback loop during deep link nav

/** Parse #vnf/{flare_id} from location hash. Returns flare ID or null. */
function parseFlareHash() {
    const m = location.hash.match(/^#vnf\/(\d+)$/);
    return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// PMTiles protocol — must be registered before map creation
// ---------------------------------------------------------------------------

const _pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', _pmtilesProtocol.tile);

const OGIM_BUCKET = document.querySelector('meta[name="ogim-bucket"]')?.content;
const OGIM_URL = OGIM_BUCKET ? `${OGIM_BUCKET}/ogim.pmtiles` : 'data/ogim.pmtiles';

// VNF parquet now lives in the shared s2-flares CloudFerro archive at a stable
// key (vnf/data.parquet) — public-read, DuckDB range-reads it remotely. Set via
// <meta name="vnf-url">; localhost (or an unset url) falls back to a local build.
const VNF_URL = document.querySelector('meta[name="vnf-url"]')?.content || '';

// S2 mode reads precomputed detections straight from the CloudFerro parquet
// archive (s2-flares `box.sh publish`). When set, panning the viewport queries the
// archive — viewport tiles+dates enumerated via STAC, parquet objects range-read
// directly (anonymous LIST is denied, so no glob). The in-browser COG worker
// ("Detect" button) stays as the fallback for areas not yet archived.
const S2_ARCHIVE = document.querySelector('meta[name="s2-archive"]')?.content || '';
// warm DuckDB + the full-archive cache at page parse, overlapping maplibre init,
// so points are ready the moment s2 mode becomes active (incl. back from vnf).
if (S2_ARCHIVE) initS2Archive(S2_ARCHIVE);

async function getVNFUrl() {
    if (location.hostname === 'localhost' || !VNF_URL) return 'vnf.parquet';
    return VNF_URL;
}

// ---------------------------------------------------------------------------
// P2P sync (LWW-Map CRDT)
// ---------------------------------------------------------------------------

const MIN_DETECT_ZOOM = 11;       // local-worker COG detect (heavy) + its controls
const MIN_ARCHIVE_ZOOM = 4;       // displaying precomputed archive clusters (cheap, in-memory)
const MIN_VNF_ZOOM = 6;
let allRawDetections = [];

let detectionMap = null, processedMap = null, store = null, mesh = null, syncManager = null;
let _detectReady = null;          // promise once ensureDetect() has fired

// Signaling server URL
const _sigMeta = document.querySelector('meta[name="signaling-url"]');
const _sigUrl = _sigMeta
    ? _sigMeta.content
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:4444`;

const AWARENESS_HEARTBEAT_MS = 15_000;

/** Compute geo summary: precision-3 geohash set from processedMap locations. */
function computeGeoSummary() {
    const hashes = new Set();
    processedMap.forEach((value, key) => {
        if (key.startsWith('__')) return;
        if (!Array.isArray(value)) return;
        const [lat, lng] = value;
        if (lat === 0 && lng === 0) return;
        hashes.add(geohash3(lat, lng));
    });
    return hashes;
}

// Lazily spin up the CRDT/P2P detection subsystem: import the modules, build the
// LWW-Maps + mesh + store, restore IndexedDB, wire awareness. Fired the first time
// the viewport sits outside the archive's coverage (updateS2Controls) or the user
// hits Detect — and eagerly in pure-detect builds (no <meta s2-archive>). Idempotent.
function ensureDetect() {
    if (_detectReady) return _detectReady;
    _detectReady = (async () => {
        const [c, st, r, sy] = await Promise.all([
            import('./crdt.js'), import('./store.js'), import('./rtc.js'), import('./sync.js')]);
        ({ LWWMap } = c); ({ Store } = st); ({ PeerMesh, geohash3 } = r);
        ({ SyncManager, validateDetection } = sy);

        detectionMap = new LWWMap();
        processedMap = new LWWMap();
        store = new Store('burnoff');
        mesh = new PeerMesh({
            signalingUrl: _sigUrl, room: 'burnoff',
            onPeerConnect: () => {}, onPeerDisconnect: () => {}, onMessage: () => {},
            maxPeers: 8, getGeoSummary: computeGeoSummary
        });
        syncManager = new SyncManager({ detectionMap, processedMap, store, mesh });

        // Re-render on CRDT change; sanitize remote entries.
        detectionMap.onChange = (key, value, source) => {
            if (source === 'remote') {
                const clean = sanitizeDetections(key, value);
                if (clean === null) {
                    detectionMap.delete(key);
                } else if (clean.length !== value.length) {
                    const entry = detectionMap.getEntry(key);
                    if (entry) detectionMap.set(key, clean, entry.ts, entry.peerId);
                }
            }
            scheduleDetectionUpdate();
        };
        syncManager.onAwarenessChange(updatePeerStatus);
        syncManager.onAwarenessChange(onAwarenessDetect);
        syncManager.setLocalAwareness({ active: true, t: Date.now() });
        window.addEventListener('beforeunload', () => {
            syncManager.setLocalAwareness(null);
            mesh.disconnect();
        });
        setInterval(() => {
            const states = syncManager.getActiveStates();
            const myState = states.get(mesh.localPeerId);
            if (myState) syncManager.setLocalAwareness({ ...myState, t: Date.now() });
        }, AWARENESS_HEARTBEAT_MS);

        await store.open();
        await store.loadAll(detectionMap, processedMap);

        // Purge completion markers for the current (ongoing) quarter so the
        // Detect button stays enabled for picking up new imagery.
        const _now = new Date();
        const _curQKey = `${_now.getFullYear()}_${Math.floor(_now.getMonth() / 3) + 1}`;
        const staleQtrKeys = [];
        processedMap.forEach((_v, key) => {
            if (key.startsWith(`__qtr:${_curQKey}:`)) staleQtrKeys.push(key);
        });
        for (const key of staleQtrKeys) {
            processedMap.delete(key);
            store.delete('proc', key);
        }

        scheduleDetectionUpdate();
        updatePeerStatus();
        updateQuarterIndicators();
        mesh.connect();
    })();
    return _detectReady;
}

function getActiveStates() {
    return syncManager ? syncManager.getActiveStates() : new Map();
}

// Initialize map — data desk dark basemap; grayscale satellite fades in on zoom
const map = new maplibregl.Map({
    container: 'map',
    style: 'vendor/dd/style.dark.json',
    center: [51.52, 25.92],
    zoom: 12,
    minZoom: 1.5,
    maxZoom: 18
});

map.on('style.load', () => map.setProjection({ type: 'globe' }));

// Markings (vendor/dd): loaded on demand; styleimagemissing catches any id
// referenced before its image arrives, so layers can be added without awaiting.
const _marksLoading = new Set();
function ensureMark(id) {
    const m = id.match(/^(flare|triangle|square|highlight)-(#[0-9A-Fa-f]{6})$/);
    if (!m || _marksLoading.has(id)) return;
    _marksLoading.add(id);
    addMarking(map, m[1], { color: m[2], base: new URL('vendor/dd/markings/', location.href) })
        .catch(() => _marksLoading.delete(id));
}
map.on('styleimagemissing', e => ensureMark(e.id));

// Mollweide world maps: viewport box in the main panel (pdf:83), archive
// coverage boxes in the intro panel (pdf:86).
const geomBbox = f => {
    let w = 180, s = 90, e = -180, n = -90;
    for (const [x, y] of f.geometry.coordinates.flat(f.geometry.type === 'MultiPolygon' ? 2 : 1)) {
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
    return [w, s, e, n];
};
function updateWorldBox() {
    setBoxes(document.getElementById('world-map'), [getViewportBbox()]);
}
drawWorldmap(document.getElementById('world-map')).then(updateWorldBox);
const _modalMap = document.getElementById('modal-worldmap');
drawWorldmap(_modalMap).then(() => {
    if (S2_ARCHIVE) whenCovered().then(() => {
        const tiles = coverageTiles();
        if (tiles) setBoxes(_modalMap, tiles.features.map(geomBbox), 0.06);
    });
});

let currentFeature = null;
let selectedDetection = null;
let detectWorker = null;
let _isDetecting = false;
let _preSessionKeys = null;

// ---------------------------------------------------------------------------
// Block detection cache (LWW-Map CRDT — synced across all peers)
// ---------------------------------------------------------------------------

function getCachedBlockKeys() {
    if (!processedMap) return [];
    return Array.from(processedMap.keys()).filter(k => !k.startsWith('__'));
}

// Write block results directly to CRDT + IndexedDB (no batching).
// iOS WebKit kills pages too fast for batched writes to survive reload.
// cloudFree: true (≤30%), false (30-75%), 'skipped' (>75%)
function cacheBlockResult(blockId, date, detections, lat, lng, cloudFree) {
    const key = `${blockId}:${date}`;
    const loc = cloudFree === true ? [lat || 0, lng || 0]
              : cloudFree === 'skipped' ? false
              : null;
    const ts = Date.now();
    const peerId = mesh.localPeerId;

    processedMap.set(key, loc, ts, peerId);
    store.put('proc', key, loc, ts, peerId);
    syncManager.onLocalWrite('proc', key);

    if (detections.length > 0) {
        detectionMap.set(key, detections, ts, peerId);
        store.put('det', key, detections, ts, peerId);
        syncManager.onLocalWrite('det', key);
    }
}

// Rebuild allRawDetections from the full CRDT map
function rebuildDetections() {
    allRawDetections = [];
    if (!detectionMap) return;
    detectionMap.forEach(dets => {
        if (dets && dets.length > 0) {
            allRawDetections = allRawDetections.concat(dets);
        }
    });
}

// Debounced detection update
let _syncUpdateTimer;

function scheduleDetectionUpdate() {
    clearTimeout(_syncUpdateTimer);
    _syncUpdateTimer = setTimeout(() => {
        if (currentMode !== 's2') return;
        rebuildDetections();
        ensureDetectionLayer();
        refreshS2View();
    }, 50);
}

// ---------------------------------------------------------------------------
// Detection sanitisation
// ---------------------------------------------------------------------------

function sanitizeDetections(key, dets) {
    if (!Array.isArray(dets)) return null;
    if (dets.length > 500) return null;
    const valid = dets.filter(validateDetection);
    return valid.length > 0 ? valid : null;
}

// Peer count indicator
function updatePeerStatus() {
    const el = document.getElementById('peer-count');
    if (el) el.textContent = Math.max(0, getActiveStates().size - 1);
}

// ---------------------------------------------------------------------------
// Awareness helpers for distributed detection
// ---------------------------------------------------------------------------

function setDetectingState(job) {
    const states = getActiveStates();
    const prev = states.get(mesh.localPeerId) || {};
    syncManager.setLocalAwareness({ ...prev, detecting: true, job, t: Date.now() });
}

function clearDetectingState() {
    const states = getActiveStates();
    const prev = { ...(states.get(mesh.localPeerId) || {}) };
    delete prev.detecting;
    delete prev.job;
    syncManager.setLocalAwareness({ ...prev, t: Date.now() });
}

function getPeerPartition(jobId) {
    const states = getActiveStates();
    const myId = mesh.localPeerId;
    const ids = [];
    states.forEach((state, id) => {
        if (state.detecting && state.job && state.job.id !== jobId) return;
        ids.push(id);
    });
    ids.sort((a, b) => a - b);
    const peerIndex = ids.indexOf(myId);
    return { peerIndex: Math.max(0, peerIndex), peerCount: ids.length };
}

// --- Helper worker for assisting a peer's detection ---
let _helpWorker = null;
let _helpingJobId = null;
let _helpingPeerCount = 0;

function stopHelping() {
    if (_helpWorker) { _helpWorker.terminate(); _helpWorker = null; }
    _helpingJobId = null;
    _helpingPeerCount = 0;
}

function startHelpingDetection(job, peerIndex, peerCount) {
    stopHelping();
    _helpingJobId = job.id;
    _helpingPeerCount = peerCount;
    store.flush();

    _helpWorker = new Worker('detect-worker.js', { type: 'module' });

    const payload = {
        bbox: job.bbox, epsg: job.epsg,
        startDate: job.startDate, endDate: job.endDate,
        cachedBlockDates: getCachedBlockKeys(),
        peerIndex, peerCount
    };

    _helpWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'ready') {
            _helpWorker.postMessage(payload);
            return;
        }
        if (msg.type === 'blockDetections') {
            const cf = msg.skipped ? 'skipped' : msg.cloudFree !== undefined ? msg.cloudFree : true;
            cacheBlockResult(msg.blockId, msg.date, msg.detections, msg.lat, msg.lng, cf);
        } else if (msg.type === 'done') {
            stopHelping();
        } else if (msg.type === 'error') {
            stopHelping();
        }
    };
    _helpWorker.onerror = () => stopHelping();
}

// Awareness listener for distributed detection coordination (registered in ensureDetect)
function onAwarenessDetect() {
    // Requester: update worker partition without restarting
    if (_isDetecting && _currentJob) {
        const { peerIndex, peerCount } = getPeerPartition(_currentJob.id);
        if (peerCount !== _currentPeerCount) {
            _currentPeerCount = peerCount;
            if (detectWorker) {
                detectWorker.postMessage({ type: 'updatePeers', peerIndex, peerCount });
            }
        }
        return;
    }

    // Helper: look for a peer's job to assist with. Pick the lowest peer id so
    // every helper converges on the same job regardless of iteration order.
    const states = getActiveStates();
    const myId = mesh.localPeerId;
    let activeJob = null, activeId = Infinity;
    states.forEach((state, id) => {
        if (id !== myId && state.detecting && state.job && id < activeId) { activeId = id; activeJob = state.job; }
    });

    if (activeJob && _helpingJobId !== activeJob.id) {
        const { peerIndex, peerCount } = getPeerPartition(activeJob.id);
        if (peerCount > 1) startHelpingDetection(activeJob, peerIndex, peerCount);
    } else if (activeJob && _helpingJobId === activeJob.id && _helpWorker) {
        const { peerIndex, peerCount } = getPeerPartition(activeJob.id);
        if (peerCount !== _helpingPeerCount) {
            _helpingPeerCount = peerCount;
            _helpWorker.postMessage({ type: 'updatePeers', peerIndex, peerCount });
        }
    } else if (!activeJob && _helpWorker) {
        stopHelping();
    }
}

// Block grid is 256px at 20m = ~5120m ≈ 0.046° lat
const BLOCK_DEG = 0.046;

// Date span the quarter grid covers (last 4 calendar years) — bounds the VNF
// availability query so it stays cheap.
const GRID_START = `${new Date().getFullYear() - 3}-01-01`;
const GRID_END = `${new Date().getFullYear()}-12-31`;

function getDetectedQuarters() {
    if (!processedMap) return new Set();
    const bounds = map.getBounds();
    const vw = bounds.getWest(), vs = bounds.getSouth();
    const ve = bounds.getEast(), vn = bounds.getNorth();
    const viewportArea = Math.max(1e-10, (ve - vw) * (vn - vs));

    // --- Phase 1: check for quarter-completion markers ---
    // These are written only when a detection session finishes normally,
    // so interrupted sessions (page close / navigate away) won't have them.
    const markerQuarters = new Set();
    let hasMarkers = false;

    processedMap.forEach((value, key) => {
        if (!key.startsWith('__qtr:')) return;
        hasMarkers = true;
        if (!Array.isArray(value) || value.length < 4) return;
        const [ms, mw, mn, me] = value;

        // Marker bbox must cover ≥70% of the current viewport
        const ow = Math.max(vw, mw), oe = Math.min(ve, me);
        const os = Math.max(vs, ms), on = Math.min(vn, mn);
        if (ow >= oe || os >= on) return;

        if ((oe - ow) * (on - os) / viewportArea >= 0.7) {
            markerQuarters.add(key.split(':')[1]); // "year_quarter"
        }
    });

    if (hasMarkers) return markerQuarters;

    // --- Phase 2: fallback for pre-migration data (no markers yet) ---
    const PAD = BLOCK_DEG / 2;
    const pw = vw - PAD, ps = vs - PAD, pe = ve + PAD, pn = vn + PAD;

    const quarterCells = new Map();
    processedMap.forEach((value, key) => {
        if (key.startsWith('__')) return;
        if (!Array.isArray(value)) return;
        const [lat, lng] = value;
        if (lat === 0 && lng === 0) return;
        if (lng < pw || lng > pe || lat < ps || lat > pn) return;
        const date = key.split(':')[1];
        const y = date.substring(0, 4);
        const q = Math.floor((parseInt(date.substring(5, 7)) - 1) / 3) + 1;
        const qKey = `${y}_${q}`;
        if (!quarterCells.has(qKey)) quarterCells.set(qKey, new Set());
        const cellR = Math.floor(lat / BLOCK_DEG);
        const cellC = Math.floor(lng / BLOCK_DEG);
        quarterCells.get(qKey).add(`${cellR},${cellC}`);
    });

    const expectedRows = Math.max(1, Math.ceil((vn - vs) / BLOCK_DEG));
    const expectedCols = Math.max(1, Math.ceil((ve - vw) / BLOCK_DEG));
    const expectedCells = expectedRows * expectedCols;

    const quarters = new Set();
    for (const [qKey, cells] of quarterCells) {
        if (cells.size / expectedCells >= 0.7) quarters.add(qKey);
    }
    return quarters;
}

// Mark each quarter button: 'detected' (local-worker S2, already processed) or
// 'unavailable' (archive/VNF, no data in this viewport). A null `avail` means the
// data source isn't ready / zoomed-out — leave everything enabled. Uncovered S2
// viewports fall through to the detect branch (same coverage test that reveals the
// Detect button) so quarters stay selectable for the local-worker fallback.
function setQuarterHint(text) {
    const el = document.getElementById('quarter-hint');
    if (el) el.textContent = text;
}

async function updateQuarterIndicators() {
    const btns = document.querySelectorAll('.quarter-btn');
    const key = btn => `${btn.dataset.year}_${btn.dataset.quarter}`;

    if (currentMode === 'vnf' || (S2_ARCHIVE && isCovered(getViewportBbox()))) {
        btns.forEach(b => b.classList.remove('detected'));
        const isVnf = currentMode === 'vnf';
        const ready = isVnf ? vnfReady() : s2ArchiveReady();
        const zoomOk = map.getZoom() >= (isVnf ? MIN_VNF_ZOOM : MIN_DETECT_ZOOM);
        let avail = null;
        if (ready && zoomOk) {
            try {
                avail = isVnf
                    ? await availableQuartersVNF(padBbox(getViewportBbox()), GRID_START, GRID_END)
                    : await availableQuartersS2(padBbox(getViewportBbox()));
            } catch (err) { console.error('quarter availability error:', err); }
        }
        btns.forEach(b => b.classList.toggle('unavailable', !!avail && !avail.has(key(b))));
        // every selected quarter is unavailable here → the map is blank; say why.
        const blank = !!avail && !Array.from(btns).some(b => b.classList.contains('active') && avail.has(key(b)));
        setQuarterHint(blank ? `No ${isVnf ? 'VNF' : 'archive'} data for the selected quarters here` : '');
        return;
    }

    setQuarterHint('');
    btns.forEach(b => b.classList.remove('unavailable'));
    const quarters = getDetectedQuarters();
    btns.forEach(b => b.classList.toggle('detected', quarters.has(key(b))));
    updateDetectButton(quarters);
}

function updateDetectButton(quarters) {
    if (!quarters) quarters = getDetectedQuarters();
    const activeBtns = document.querySelectorAll('.quarter-btn.active');
    const allDetected = activeBtns.length > 0 && Array.from(activeBtns).every(btn => {
        const qKey = `${btn.dataset.year}_${btn.dataset.quarter}`;
        return quarters.has(qKey);
    });
    const tooZoomedOut = map.getZoom() < MIN_DETECT_ZOOM;
    const btn = document.getElementById('detect-btn');
    btn.disabled = allDetected || tooZoomedOut;
    btn.title = tooZoomedOut ? 'Zoom in to at least level 11' : '';
}


// ---------------------------------------------------------------------------
// Quarter picker
// ---------------------------------------------------------------------------

// Quarter grid (pdf:83): Q1-Q4 header columns, one dot row per year — active
// dots 8px, inactive 3px, unavailable/detected greyed (pdf:81 active/inactive).
function initQuarterPicker() {
    const container = document.getElementById('quarter-picker');
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
    container.innerHTML = '';

    const span = (cls, text) => {
        const el = document.createElement('span');
        el.className = cls;
        if (text) el.textContent = text;
        container.appendChild(el);
    };
    for (let q = 1; q <= 4; q++) span('dd-secondary', `Q${q}`);
    span('');

    for (const year of [currentYear - 3, currentYear - 2, currentYear - 1, currentYear]) {
        const maxQ = (year === currentYear) ? currentQuarter : 4;
        for (let q = 1; q <= 4; q++) {
            if (q > maxQ) { span(''); continue; }
            const btn = document.createElement('button');
            btn.className = 'dd-dot-btn quarter-btn';
            btn.innerHTML = '<span class="dd-dot"></span>';
            btn.title = `Q${q} ${year}`;
            btn.dataset.year = year;
            btn.dataset.quarter = q;
            if (year >= currentYear - 1) btn.classList.add('active');
            btn.addEventListener('click', () => toggleQuarter(btn));
            container.appendChild(btn);
        }
        span('dd-secondary', year);
    }
}

function toggleQuarter(btn) {
    const wasActive = btn.classList.contains('active');
    // count only quarters that have data here — keep at least one *available* one
    // selected, else deselecting past the last usable quarter empties the map while
    // unavailable (no-data) quarters stay phantom-active and uncliackable.
    const activeCount = document.querySelectorAll('.quarter-btn.active:not(.unavailable)').length;
    if (wasActive && activeCount <= 1) return;
    btn.classList.toggle('active');
    if (currentMode === 'vnf') {
        scheduleVNFRefresh();
    } else {
        updateDetectButton();
        scheduleS2Refresh();
    }
    // Re-filter the open card to the new window (the async re-query reconciles the map).
    if (currentFeature) showInfo(currentFeature, { skipAutoSelect: true });
}

function getSelectedDateRange() {
    const activeBtns = document.querySelectorAll('.quarter-btn.active');
    if (activeBtns.length === 0) return null;

    const quarterStart = (year, q) => `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    const quarterEnd = (year, q) => {
        const endMonth = q * 3;
        const d = new Date(year, endMonth, 0);
        return `${year}-${String(endMonth).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    let minDate = null, maxDate = null;
    for (const btn of activeBtns) {
        const y = parseInt(btn.dataset.year);
        const q = parseInt(btn.dataset.quarter);
        const start = quarterStart(y, q);
        const end = quarterEnd(y, q);
        if (!minDate || start < minDate) minDate = start;
        if (!maxDate || end > maxDate) maxDate = end;
    }
    return { startDate: minDate, endDate: maxDate };
}

// Active quarter keys (e.g. "2025_3"). Non-contiguous selections are honoured
// exactly — used to filter a cluster card's per-date detections to the window.
function activeQuarterKeys() {
    const keys = new Set();
    document.querySelectorAll('.quarter-btn.active').forEach(b =>
        keys.add(`${b.dataset.year}_${b.dataset.quarter}`));
    return keys;
}

function dateInActiveQuarters(dateStr, keys) {
    if (!keys.size) return true;
    const q = Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1;
    return keys.has(`${dateStr.slice(0, 4)}_${q}`);
}

initQuarterPicker();
updateQuarterIndicators();

// ---------------------------------------------------------------------------
// VNF mode
// ---------------------------------------------------------------------------

async function refreshVNF() {
    if (currentMode !== 'vnf') return;
    if (!vnfReady()) return;
    if (map.getZoom() < MIN_VNF_ZOOM) {
        _vnfRawFeatures = null;
        const src = map.getSource('client-detections');
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const bounds = map.getBounds();
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const dateRange = getSelectedDateRange();
    if (!dateRange) return;

    try {
        const fc = await queryVNF(bbox, dateRange.startDate, dateRange.endDate);
        _vnfRawFeatures = fc.features;
        const clustered = enrichVNFFeatures(_vnfRawFeatures, VNF_AVG_RH_MIN);
        const clusteredFc = { type: 'FeatureCollection', features: clustered };
        ensureDetectionLayer();
        const src = map.getSource('client-detections');
        if (src && currentMode === 'vnf') src.setData(clusteredFc);
    } catch (err) {
        console.error('VNF query error:', err);
    }
}

function scheduleVNFRefresh() {
    clearTimeout(_vnfRefreshTimer);
    _vnfRefreshTimer = setTimeout(refreshVNF, 200);
}

// ---------------------------------------------------------------------------
// S2 archive mode — read precomputed detections straight from the parquet
// archive for the current viewport. Falls back to whatever is already in the
// CRDT (local-worker / synced detections) when the archive has nothing here.
// ---------------------------------------------------------------------------

// Archive builds serve precomputed clusters, so the local-worker detect path — and
// the P2P mesh that shares its workload — only make sense where the archive has no
// coverage. Reveal Detect / peer status / merge slider there; hide them where the
// archive serves. No-op in pure detect builds (no <meta s2-archive>), which always
// expose the controls. Coverage is an in-memory bbox test (one listing at init).
function updateS2Controls() {
    if (!S2_ARCHIVE) return;
    const show = currentMode === 's2' && s2ArchiveReady() &&
        map.getZoom() >= MIN_DETECT_ZOOM && !isCovered(getViewportBbox()) && !_isDetecting;
    // Outside archive coverage the Detect/P2P path is live — load the CRDT lazily.
    if (show) ensureDetect();
    for (const sel of ['#peer-status', '#detect-area'])
        document.querySelector(sel).style.setProperty('display', show ? '' : 'none');
}

async function refreshS2Archive() {
    updateS2Controls();
    if (currentMode !== 's2' || !S2_ARCHIVE || _isDetecting) return;
    if (!s2ArchiveReady() || map.getZoom() < MIN_ARCHIVE_ZOOM) { updateDetectionSource(); return; }
    const dateRange = getSelectedDateRange();
    if (!dateRange) { updateDetectionSource(); return; }
    try {
        const clusters = await queryS2Archive(getViewportBbox(), dateRange.startDate, dateRange.endDate);
        if (currentMode !== 's2' || _isDetecting) return;
        const features = clusters.filter(c => c.avg_b12 >= CLUSTER_AVG_B12_MIN).map(archiveFeature);
        if (!features.length) { updateDetectionSource(); return; }
        ensureDetectionLayer();
        const src = map.getSource('client-detections');
        if (src) src.setData({ type: 'FeatureCollection', features });
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

// Lazily spin up DuckDB for the archive, then refresh the viewport.
function ensureS2Archive() {
    if (!S2_ARCHIVE) return;
    if (s2ArchiveReady()) { refreshS2Archive(); return; }
    if (_s2InitStarted) return;
    _s2InitStarted = true;
    initS2Archive(S2_ARCHIVE)
        .then(() => { if (currentMode === 's2') { refreshS2Archive(); updateQuarterIndicators(); } })
        .catch(err => { console.error('S2 archive init error:', err); _s2InitStarted = false; });
}

function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    // Update toggle buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const panel = document.getElementById('title-panel');
    panel.classList.toggle('mode-s2', mode === 's2');

    // Close any open info panel
    closeInfo();

    // Update legend
    updateLegend();

    // Update events header columns
    const cfg = MODE[mode];
    document.getElementById('mode-subtitle').textContent = cfg.subtitle;
    const col2 = document.getElementById('events-col2');
    const col3 = document.getElementById('events-col3');
    if (col2) col2.textContent = cfg.col2;
    if (col3) col3.textContent = cfg.col3;

    // Reconfigure sliders for current mode
    const intRange = document.getElementById('intensity-range');
    const intValue = document.getElementById('intensity-value');
    const flt = cfg.filter;
    const curIntensity = mode === 'vnf' ? VNF_AVG_RH_MIN : CLUSTER_AVG_B12_MIN;
    intRange.min = flt.min; intRange.max = flt.max; intRange.step = flt.step; intRange.value = curIntensity;
    intValue.textContent = cfg.formatFilter(curIntensity);

    // Update quarter indicators immediately (un-grey in VNF, mark detected in S2)
    updateQuarterIndicators();

    if (mode === 'vnf') {
        // Clear S2 features immediately so they don't linger during VNF load
        ensureDetectionLayer();
        const src = map.getSource('client-detections');
        if (src) src.setData({ type: 'FeatureCollection', features: [] });

        if (!_vnfInitStarted) {
            getVNFUrl().then(url => {
                if (!url) { switchMode('s2'); return; }
                _vnfInitStarted = true;
                initVNF(url).then(() => {
                    if (currentMode === 'vnf') { refreshVNF(); updateQuarterIndicators(); }
                }).catch(err => {
                    console.error('VNF init error:', err);
                    _vnfInitStarted = false;
                    resetVNF();
                    switchMode('s2');
                });
            });
        } else if (vnfReady()) {
            refreshVNF();
        }
    } else {
        // Restore S2 features, then overlay the archive for this viewport.
        rebuildDetections();
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

function modeConf() { return MODE[currentMode] || MODE.s2; }

function copernicusUrl(date) {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const { lat, lng } = map.getCenter();
    // maplibre renders 512px tiles, so its zoom is one level lower than the
    // 256px slippy zoom copernicus browser (leaflet) expects for the same scale.
    const zoom = Math.round(map.getZoom()) + 1;
    return `https://browser.dataspace.copernicus.eu/?zoom=${zoom}&lat=${lat}&lng=${lng}&datasetId=S2_L2A_CDAS&fromTime=${encodeURIComponent(from)}&toTime=${encodeURIComponent(to)}&layerId=6-SWIR&upsampling=NEAREST&downsampling=NEAREST&dateMode=SINGLE`;
}

function setCirclesGreyed() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'icon-opacity', 0.35);
}

function setCirclesDefault() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'icon-opacity', 1);
}

function renderIntensityChart(detections, onSelectDate) {
    const container = document.getElementById('intensity-chart');
    if (!detections?.length) {
        container.innerHTML = '';
        return;
    }

    const sorted = [...detections].sort((a, b) => new Date(a.date) - new Date(b.date));
    const margin = { top: 8, right: 8, bottom: 16, left: 8 };
    const width = 268, height = 50;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const dates = sorted.map(d => new Date(d.date));
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const dateRange = maxDate - minDate || 1;

    const cfg = modeConf();

    let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#808080" stroke-width="1"/>`;

    const firstYear = new Date(minDate).getFullYear();
    const lastYear = new Date(maxDate).getFullYear();
    for (let y = firstYear + 1; y <= lastYear; y++) {
        const jan1 = new Date(y, 0, 1).getTime();
        const x = margin.left + ((jan1 - minDate) / dateRange) * innerW;
        svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#4D4D4D" stroke-width="0.5"/>`;
        svg += `<text x="${x}" y="${height - 2}" fill="#808080" font-size="8" text-anchor="middle">${y}</text>`;
    }

    sorted.forEach((det, i) => {
        const date = new Date(det.date);
        const x = margin.left + ((date - minDate) / dateRange) * innerW;
        const val = cfg.yVal(det);
        if (cfg.sentinel && val >= cfg.sentinel) return;
        const t = Math.max(0, Math.min(1, chartNorm(cfg, val)));
        const y = margin.top + innerH - t * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="2.5" fill="#FFFFFF" data-idx="${i}"/>`;
    });

    svg += '</svg>';
    container.innerHTML = svg;

    container.querySelectorAll('.chart-dot').forEach(dot => {
        dot.addEventListener('click', e => {
            const idx = parseInt(e.target.dataset.idx);
            onSelectDate(sorted[idx]);
        });
    });
}

function utmBoundsToWgs84(utmBounds, epsg) {
    if (!epsg) return null;
    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    const [minX, minY, maxX, maxY] = utmBounds;
    const sw = utmToWgs84(minX, minY, zone, isNorth);
    const ne = utmToWgs84(maxX, maxY, zone, isNorth);
    return [sw[0], sw[1], ne[0], ne[1]];
}

// Quarter-aware card metrics. Detections filter exactly to the selected quarters
// (numerator). The cloud-free observation count has no per-date breakdown — the
// archive carries only a cluster total — so the denominator is scaled by the share
// of the cluster's active-quarter span the selection covers. Left as the published
// totals when every quarter, or none, is selected.
function quarterMetrics(props, dets, qKeys) {
    const detection_count = dets.filter(d => dateInActiveQuarters(d.date, qKeys)).length;
    let { observations, persistence } = props;
    if (observations != null && dets.length) {
        const qi = d => +d.date.slice(0, 4) * 4 + Math.floor((+d.date.slice(5, 7) - 1) / 3);
        const idx = dets.map(qi), lo = Math.min(...idx), hi = Math.max(...idx);
        let span = 0, sel = 0;
        for (let i = lo; i <= hi; i++, span++)
            if (!qKeys.size || qKeys.has(`${Math.floor(i / 4)}_${i % 4 + 1}`)) sel++;
        if (sel < span) {
            observations = Math.round(observations * sel / span);
            persistence = observations > 0 ? Math.min(1, detection_count / observations) : 0;
        }
    }
    return { detection_count, observations, persistence };
}

function showInfo(feature, { skipAutoSelect = false } = {}) {
    currentFeature = feature;
    selectedDetection = null;

    // Update hash for VNF deep links
    if (!_suppressHashUpdate && currentMode === 'vnf' && feature.properties.flare_id) {
        history.replaceState(null, '', `#vnf/${feature.properties.flare_id}`);
    }
    const props = feature.properties;

    // Parse detections once; the active quarter selection drives both the list
    // below and the headline metrics (numerator exactly, observation denominator
    // scaled) — deselecting a quarter updates both, not just the map.
    let allDets = props.detections || [];
    if (typeof allDets === 'string') { try { allDets = JSON.parse(allDets); } catch (e) { allDets = []; } }
    const qKeys = activeQuarterKeys();
    const metrics = quarterMetrics(props, allDets, qKeys);

    setCirclesGreyed();

    const selectionSource = map.getSource('selection-highlight');
    if (selectionSource) selectionSource.setData(feature);
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'visible');
    }

    const infoEl = document.getElementById('info');
    infoEl.classList.add('visible');
    infoEl.classList.remove('collapsed');

    const isVnf = currentMode === 'vnf';
    const title = props.terminal
        ? `Near ${props.name.replace(/\s*Terminal\b/gi, '').trim()}`
        : props.name;
    document.getElementById('info-name').textContent =
        title || (isVnf ? `Flare #${props.flare_id}` : 'Unknown facility');

    // Info rows under the heading (pdf:84): Detections / Persistence / Passes /
    // Cloud-free. Passes is null for archive clusters (no total-pass figure).
    const cfLabel = props.passes && metrics.observations != null
        ? `Cloud-free (${Math.round(metrics.observations / props.passes * 100)}%)` : 'Cloud-free obs.';
    document.getElementById('info-stats').innerHTML = [
        ['Detections', metrics.detection_count],
        ['Persistence', metrics.persistence != null ? `${Math.round(metrics.persistence * 100)}%` : '—'],
        ['Passes', props.passes ?? '—'],
        [cfLabel, metrics.observations ?? '—'],
    ].map(([k, v]) => `<div><span class="dd-secondary">${k}</span><span>${v}</span></div>`).join('');

    // Card shows only detections in the selected quarter window (parsed above).
    let detections = allDets.filter(d => dateInActiveQuarters(d.date, qKeys));

    const list = document.getElementById('events-list');
    list.innerHTML = '';

    const sorted = [...detections].sort((a, b) => new Date(b.date) - new Date(a.date));
    const dateToItem = new Map();
    let firstItem = null;

    const evtCfg = modeConf();
    const isVNF = currentMode === 'vnf';
    sorted.forEach(det => {
        const item = document.createElement('div');
        let isL1C = false;
        // Archive detections have no COG (cluster view only) but still carry a date
        // + raw point — clickable for the intensity halo and external "Open image".
        if (!isVNF && !S2_ARCHIVE) {
            const url = det.cog_b12;
            isL1C = !url || typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif');
        }
        item.className = 'dd-row event-item' + (isL1C ? ' l1c-only' : '');
        item.dataset.date = det.date;
        item.innerHTML = `
            <span class="event-date">${formatDate(det.date)}</span>
            <span class="event-meta event-meta-val">${evtCfg.formatVal(det)}</span>
            <span class="event-meta event-meta-count">${evtCfg.formatCount(det)}</span>
        `;
        item.onclick = () => selectDetection(det, item);
        list.appendChild(item);

        dateToItem.set(det.date, { det, item, isL1C });
        if (!firstItem && !isL1C) firstItem = { det, item };
    });

    renderIntensityChart(detections, det => {
        const entry = dateToItem.get(det.date);
        if (entry) {
            selectDetection(entry.det, entry.item);
            entry.item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });

    const MAX_VISIBLE_ROWS = window.innerWidth <= 768 ? 4 : 10;
    const items = list.querySelectorAll('.event-item');
    if (items.length > 0) {
        const rowH = items[0].offsetHeight;
        const visibleRows = Math.min(items.length, MAX_VISIBLE_ROWS);
        list.style.maxHeight = (rowH * visibleRows) + 'px';
    }

    // In VNF mode, auto-select first item (highlight only, no COG load)
    // In S2 mode, auto-select first L2A item to load COG
    if (firstItem && !skipAutoSelect) selectDetection(firstItem.det, firstItem.item);

    // Hide/show mode-specific buttons (entire actions bar in VNF)
    const actions = document.querySelector('.panel-actions');
    if (actions) actions.style.display = isVnf ? 'none' : '';
    // No CSV export in VNF mode (data comes straight from EOG)
    const dlBtn = document.getElementById('download-btn');
    if (dlBtn) dlBtn.style.display = isVnf ? 'none' : '';

    document.activeElement?.blur();

    if (detections.length === 0) {
        document.getElementById('intensity-chart').innerHTML = '';
        list.innerHTML = '<div class="events-empty">No detections</div>';
    }
}

function selectDetection(det, element) {
    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');
    selectedDetection = det;
    if (currentMode === 'vnf') showHeatFootprint(det);
    else loadImageryForDetection(det);
}

// Tear down the COG / heat-footprint image overlay (idempotent).
function clearCogLayers() {
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getSource('cog-source')) map.removeSource('cog-source');
}

// Magma radial-gradient footprint at a detection's point, sized by intensity, used
// where there is no COG to render: VNF (sized on radiant heat) and S2 archive rows
// (sized on B12, located at the per-date raw point).
function showHeatFootprint(det) {
    clearCogLayers();
    if (!det || !currentFeature) return;
    const isVnf = currentMode === 'vnf';
    const [cLon, cLat] = currentFeature.geometry.coordinates;
    const lon = isVnf ? cLon : (det.raw_lon ?? cLon);
    const lat = isVnf ? cLat : (det.raw_lat ?? cLat);
    const val = isVnf ? (det.rh_mw || 0) : (det.max_b12 || det.b12_corrected || 0);
    if (val <= 0) return;

    const radiusM = isVnf ? 50 * Math.sqrt(Math.max(val, 0.5)) : 45 * Math.sqrt(val);
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * DEG_TO_RAD));

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const [r, g, b] = rampRGB(scaleT(isVnf ? MODE.vnf : MODE.s2, val));
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
    grad.addColorStop(0.3, `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(0.7, `rgba(${r},${g},${b},0.15)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const coords = [
        [lon - dLon, lat + dLat], [lon + dLon, lat + dLat],
        [lon + dLon, lat - dLat], [lon - dLon, lat - dLat]
    ];
    map.addSource('cog-source', { type: 'image', url: canvas.toDataURL(), coordinates: coords });
    map.addLayer({ id: 'cog-layer', type: 'raster', source: 'cog-source',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' } }, 'client-detection-circles');

    setCirclesGreyed();
    map.setPaintProperty('satellite', 'raster-brightness-max', 0.25);
}

function closeInfo() {
    document.getElementById('info').classList.remove('visible');
    closeImagery();
    currentFeature = null;
    setCirclesDefault();
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'none');
    }
    // Clear deep link hash
    if (!_suppressHashUpdate && location.hash.startsWith('#vnf/')) {
        history.replaceState(null, '', location.pathname + location.search);
    }
}

async function loadImageryForDetection(det) {
    clearCogLayers();

    if (!det?.cog_b12) return void showHeatFootprint(det);

    const url = det.cog_b12;
    if (typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif')) {
        document.querySelector('.event-item.active')?.classList.add('l1c-only');
        return;
    }

    const [flareLon, flareLat] = currentFeature.geometry.coordinates;
    const epsg = det.epsg;
    const buffer = 250;

    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    const [flareUtmX, flareUtmY] = wgs84ToUtm(flareLon, flareLat, zone, isNorth);
    const utmBounds = [flareUtmX - buffer, flareUtmY - buffer, flareUtmX + buffer, flareUtmY + buffer];

    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('loading'));
    document.querySelector('.event-item.active')?.classList.add('loading');

    try {
        const tiff = await GeoTIFF.fromUrl(det.cog_b12, { allowFullFile: false });
        const image = await tiff.getImage();

        const imgBbox = image.getBoundingBox();
        const width = image.getWidth(), height = image.getHeight();
        const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;
        const resX = (imgMaxX - imgMinX) / width;
        const resY = (imgMaxY - imgMinY) / height;

        const [minX, minY, maxX, maxY] = utmBounds;
        const x0 = Math.max(0, Math.floor((minX - imgMinX) / resX));
        const y0 = Math.max(0, Math.floor((imgMaxY - maxY) / resY));
        const x1 = Math.min(width, Math.ceil((maxX - imgMinX) / resX));
        const y1 = Math.min(height, Math.ceil((imgMaxY - minY) / resY));

        const windowWidth = x1 - x0, windowHeight = y1 - y0;
        if (windowWidth <= 0 || windowHeight <= 0) throw new Error('Outside image bounds');

        const actualUtmBounds = [imgMinX + x0 * resX, imgMaxY - y1 * resY, imgMinX + x1 * resX, imgMaxY - y0 * resY];
        const bounds = utmBoundsToWgs84(actualUtmBounds, epsg);
        if (!bounds) throw new Error('Could not convert bounds');

        const rasters = await image.readRasters({
            window: [x0, y0, x1, y1],
            width: Math.min(windowWidth, 256),
            height: Math.min(windowHeight, 256)
        });

        const data = rasters[0];
        const w = rasters.width, h = rasters.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(w, h);

        const scale = 0.0001, offset = -0.1, threshold = 0.6, ceiling = 1.5;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] * scale + offset;
            if (v <= threshold) {
                imgData.data[i * 4 + 3] = 0;
            } else {
                const t = Math.min(1, (v - threshold) / (ceiling - threshold));
                const [r, g, b] = rampRGB(t);
                imgData.data[i * 4] = r;
                imgData.data[i * 4 + 1] = g;
                imgData.data[i * 4 + 2] = b;
                imgData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        clearCogLayers();

        const coords = [[bounds[0], bounds[3]], [bounds[2], bounds[3]], [bounds[2], bounds[1]], [bounds[0], bounds[1]]];

        map.addSource('cog-source', {
            type: 'image',
            url: canvas.toDataURL(),
            coordinates: coords
        });

        map.addSource('cog-border', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] } }
        });

        map.addLayer({
            id: 'cog-layer',
            type: 'raster',
            source: 'cog-source',
            paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' }
        }, 'client-detection-circles');

        map.addLayer({
            id: 'cog-border',
            type: 'line',
            source: 'cog-border',
            paint: { 'line-color': '#ffffff', 'line-width': 1 }
        }, 'client-detection-circles');

        setCirclesGreyed();
        document.querySelector('.event-item.active')?.classList.remove('loading');
        map.setPaintProperty('satellite', 'raster-brightness-max', 0.25);
    } catch (err) {
        console.error('Failed to load COG:', err);
        document.querySelector('.event-item.active')?.classList.remove('loading');
    }
}

function closeImagery() {
    clearCogLayers();
    map.setPaintProperty('satellite', 'raster-brightness-max', 0.75);
    if (currentFeature) setCirclesGreyed();
    else setCirclesDefault();
}

function downloadFlareCSV() {
    if (!currentFeature || currentMode === 'vnf') return;
    const props = currentFeature.properties;
    const [lon, lat] = currentFeature.geometry.coordinates;

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

    const rows = [['facility', 'terminal', 'lat', 'lon', 'date', 'max_b12', 'pixels', 'persistence', 'passes', 'observations']];
    const persistStr = props.persistence != null ? props.persistence.toFixed(4) : '';
    const passStr = props.passes != null ? String(props.passes) : '';
    const obsStr = props.observations != null ? String(props.observations) : '';
    for (const det of detections) {
        rows.push([
            `"${(props.name || '').replace(/"/g, '""')}"`,
            `"${(props.terminal || '').replace(/"/g, '""')}"`,
            det.raw_lat?.toFixed(6) || lat.toFixed(6),
            det.raw_lon?.toFixed(6) || lon.toFixed(6),
            det.date,
            det.max_b12?.toFixed(4) || '',
            det.pixels || '',
            persistStr,
            passStr,
            obsStr
        ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(props.name || 'flare').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-detections.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Cross-date clustering (Union-Find, runs on main thread for live updates)
// ---------------------------------------------------------------------------

// fixed to the bulk pipeline's cluster default (s2-flares core ClusterOptions)
const MERGE_DISTANCE_M = 135;
let CLUSTER_AVG_B12_MIN = MODE.s2.filter.default;
let VNF_AVG_RH_MIN = MODE.vnf.filter.default;
let CLUSTER_PERSISTENCE_MIN = 0.25;   // display-only min persistence gate (all modes)

// `obs` (optional) overrides the persistence source: an array of
// {block_id, date, cloudFree} records (the S2-archive path). When omitted, the
// per-block/per-date observation budget is derived from processedMap as before.
function crossDateCluster(allDetections, obs) {
    if (allDetections.length === 0) return [];

    // Per-block date sets for burnoff-specific persistence calculation
    // passesByBlock: all entries (including >75% skipped)
    // obsByBlock:    analysed entries (≤75% cloud, i.e. value !== false)
    const passesByBlock = new Map();
    const obsByBlock = new Map();
    // Global cloud-free observation budget for the persistence_score denominator.
    // A date is cloud-free if any block that date resolved to a coord (≤30% cloud,
    // i.e. an array value — not null/30-75% or false/skipped).
    const obsByDate = new Map();
    const ingest = (bid, date, cloudFree, analysed) => {
        if (!passesByBlock.has(bid)) passesByBlock.set(bid, new Set());
        passesByBlock.get(bid).add(date);
        if (analysed) {
            if (!obsByBlock.has(bid)) obsByBlock.set(bid, new Set());
            obsByBlock.get(bid).add(date);
        }
        const prev = obsByDate.get(date);
        if (!prev) obsByDate.set(date, { cloudFree });
        else if (cloudFree) prev.cloudFree = true;
    };
    if (obs) {
        for (const o of obs) ingest(o.block_id, o.date, o.cloudFree === true, o.cloudFree !== false);
    } else if (processedMap) {
        processedMap.forEach((value, key) => {
            if (key.startsWith('__')) return;
            const i = key.lastIndexOf(':');
            ingest(key.substring(0, i), key.substring(i + 1), Array.isArray(value), value !== false);
        });
    }

    // Delegate spatial clustering to s2-flares. The avg-B12 slider remains the
    // active quality gate (unchanged for existing users). The vision-validated
    // score is computed for display only — not gated — until we commit to syncing
    // the B12/B11 ratio (a binary-format change, deferred). `observations` gives the
    // cloud-free denominator for both the persistence metric and persistence_score.
    const clusters = clusterDetections(allDetections, {
        mergeDistance: MERGE_DISTANCE_M,
        minDates: 4,
        minAvgB12: CLUSTER_AVG_B12_MIN,
        observations: obsByDate,
    });

    // Wrap s2-flares cluster results into GeoJSON Features with burnoff-specific
    // persistence, terminal naming, and detection detail fields. Index the raw
    // detections by date+coord once so the per-cluster metadata lookups stay O(1).
    const origByKey = new Map();
    for (const o of allDetections) origByKey.set(`${o.date}|${o.flare_lon ?? o.lon}|${o.flare_lat ?? o.lat}`, o);

    const features = [];
    for (const cl of clusters) {
        const terminal = findNearestTerminal(cl.lat, cl.lon);
        const name = terminal ? terminal.name : `${cl.detection_count} detection${cl.detection_count !== 1 ? 's' : ''}`;

        // Burnoff persistence: detections / block-level observations
        let passes = null, observations = null, persistence = cl.persistence;
        {
            // Collect block IDs from the original detections that belong to this cluster
            const clusterDets = cl.detections;
            const bids = new Set();
            for (const d of clusterDets) {
                // Find original detection with matching date/lon/lat to get block metadata
                const orig = origByKey.get(`${d.date}|${d.lon}|${d.lat}`);
                if (orig) {
                    const bid = orig.block_id || `${orig.mgrs}_${orig.block_row}_${orig.block_col}`;
                    if (bid) bids.add(bid);
                }
            }
            const passDates = new Set();
            const obsDates = new Set();
            for (const bid of bids) {
                const p = passesByBlock.get(bid);
                if (p) for (const d of p) passDates.add(d);
                const o = obsByBlock.get(bid);
                if (o) for (const d of o) obsDates.add(d);
            }
            for (const d of clusterDets) { passDates.add(d.date); obsDates.add(d.date); }
            passes = passDates.size;
            observations = obsDates.size;
            persistence = observations > 0 ? clusterDets.length / observations : null;
        }

        // Map cluster detections back to burnoff's detail format, pulling extra
        // fields (cog_b12, epsg, utm_bounds) from the original detection records
        const detailDets = cl.detections.map(d => {
            const orig = origByKey.get(`${d.date}|${d.lon}|${d.lat}`);
            return {
                date: d.date, max_b12: d.max_b12, pixels: d.pixels,
                cog_b12: orig?.cog_b12, epsg: orig?.epsg, utm_bounds: orig?.utm_bounds,
                raw_lon: d.lon, raw_lat: d.lat,
                b12_corrected: d.max_b12
            };
        });

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [cl.lon, cl.lat] },
            properties: {
                name,
                terminal: terminal?.name || null,
                max_b12: cl.max_b12,
                detection_count: cl.detection_count,
                seasonal: cl.seasonal,
                // s2-flares vision-validated quality score
                total_score: cl.total_score,
                ratio_score: cl.ratio_score,
                persistence_score: cl.persistence_score,
                glint_penalty: cl.glint_penalty,
                max_ratio: cl.max_ratio,
                min_glint: cl.min_glint,
                glint_suspect: cl.glint_suspect,
                persistence,
                passes,
                observations,
                detections: detailDets
            }
        });
    }
    return features;
}

// ---------------------------------------------------------------------------
// Client-side detection
// ---------------------------------------------------------------------------

function getViewportBbox() {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

// expand a viewport bbox to at least `min` degrees per axis (centered). quarter
// availability tests whether flares fall inside it; zoomed in far the raw viewport
// is razor-thin, so every quarter greys out the moment you sit between flares. a
// ~3 km floor makes availability reflect the surrounding area instead.
function padBbox([w, s, e, n], min = 0.03) {
    const dw = Math.max(0, (min - (e - w)) / 2), dh = Math.max(0, (min - (n - s)) / 2);
    return [w - dw, s - dh, e + dw, n + dh];
}

function guessEpsg(bbox) {
    const lon = (bbox[0] + bbox[2]) / 2;
    const lat = (bbox[1] + bbox[3]) / 2;
    const zone = Math.floor((lon + 180) / 6) + 1;
    return lat >= 0 ? 32600 + zone : 32700 + zone;
}

function ensureDetectionLayer() {
    if (!map.isStyleLoaded()) {
        map.once('styledata', () => scheduleDetectionUpdate());
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

function updateDetectionSource() {
    const features = crossDateCluster(allRawDetections);
    const src = map.getSource('client-detections');
    if (src) {
        src.setData({ type: 'FeatureCollection', features });
        map.triggerRepaint();
    }
}

function updateVNFSource() {
    if (!_vnfRawFeatures) return;
    const clustered = enrichVNFFeatures(_vnfRawFeatures, VNF_AVG_RH_MIN);
    const fc = { type: 'FeatureCollection', features: clustered };
    const src = map.getSource('client-detections');
    if (src) src.setData(fc);
}

function updateCurrentSource() {
    if (currentMode === 'vnf') updateVNFSource();
    else refreshS2View();
}

function reselectCurrentFeature() {
    if (!currentFeature) return;
    const src = map.getSource('client-detections');
    if (!src) return;
    const fc = src._data || { features: [] };
    const features = fc.features || [];
    const [lon, lat] = currentFeature.geometry.coordinates;
    const match = features.find(f => {
        const [fLon, fLat] = f.geometry.coordinates;
        return Math.abs(fLon - lon) < 0.0001 && Math.abs(fLat - lat) < 0.0001;
    });
    if (match) showInfo(match, { skipAutoSelect: true });
    else closeInfo();
}

// Track the current detection job and peer partition
let _currentJob = null;
let _currentPeerCount = 0;

function launchDetectWorker(job) {
    if (detectWorker) { detectWorker.terminate(); detectWorker = null; }

    const { peerIndex, peerCount } = getPeerPartition(job.id);
    _currentPeerCount = peerCount;

    const bar = document.getElementById('detect-bar');
    const text = document.getElementById('detect-text');

    detectWorker = new Worker('detect-worker.js', { type: 'module' });

    const cached = getCachedBlockKeys();
    const payload = {
        bbox: job.bbox, epsg: job.epsg,
        startDate: job.startDate, endDate: job.endDate,
        cachedBlockDates: cached,
        peerIndex, peerCount
    };

    detectWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'ready') {
            // Worker module loaded — now safe to send the job
            detectWorker.postMessage(payload);
            return;
        }
        if (msg.type === 'progress') {
            bar.style.width = msg.pct + '%';
            text.textContent = msg.stage;
        } else if (msg.type === 'blockDetections') {
            const cf = msg.skipped ? 'skipped' : msg.cloudFree !== undefined ? msg.cloudFree : true;
            cacheBlockResult(msg.blockId, msg.date, msg.detections, msg.lat, msg.lng, cf);
        } else if (msg.type === 'done') {
            const job = _currentJob;
            cleanupDetection();
            finishDetection(msg.stats, job);
        } else if (msg.type === 'error') {
            cleanupDetection();
            _isDetecting = false;
            _preSessionKeys = null;
            bar.style.width = '100%';
            bar.style.background = '#F52E2E';
            text.textContent = 'Error: ' + msg.message;
            setTimeout(resetDetectUI, 3000);
        }
    };
    detectWorker.onerror = function(err) {
        cleanupDetection();
        _isDetecting = false;
        _preSessionKeys = null;
        console.error('Worker error:', err);
        bar.style.width = '100%';
        bar.style.background = '#F52E2E';
        text.textContent = 'Worker error';
        setTimeout(resetDetectUI, 3000);
    };
}

function cleanupDetection() {
    clearDetectingState();
    _currentJob = null;
    _currentPeerCount = 0;
}

async function startDetection() {
    await ensureDetect();
    if (detectWorker) { detectWorker.terminate(); detectWorker = null; }
    _isDetecting = true;
    _preSessionKeys = new Set(processedMap.keys());
    ensureDetectionLayer();

    document.getElementById('detect-btn').classList.add('hidden');
    document.getElementById('detect-progress').classList.remove('hidden');
    document.getElementById('detect-bar').style.width = '0%';
    document.getElementById('detect-text').textContent = 'Searching...';

    const bbox = getViewportBbox();
    const epsg = guessEpsg(bbox);
    const dateRange = getSelectedDateRange();

    const job = {
        id: `${mesh.localPeerId}-${Date.now()}`,
        bbox, epsg,
        startDate: dateRange?.startDate,
        endDate: dateRange?.endDate
    };
    _currentJob = job;

    setDetectingState(job);

    await new Promise(r => setTimeout(r, 200));

    launchDetectWorker(job);
}

function resetDetectUI() {
    document.getElementById('detect-btn').classList.remove('hidden');
    const prog = document.getElementById('detect-progress');
    prog.classList.add('hidden');
    const bar = document.getElementById('detect-bar');
    bar.style.width = '0%';
    bar.style.background = '';
}

function writeQuarterCompletionMarkers(job) {
    if (!job || !job.bbox || !job.startDate || !job.endDate) return;
    const [west, south, east, north] = job.bbox;
    const ts = Date.now();
    const peerId = mesh.localPeerId;

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1;

    const sy = parseInt(job.startDate.substring(0, 4));
    const sm = parseInt(job.startDate.substring(5, 7));
    const ey = parseInt(job.endDate.substring(0, 4));
    const em = parseInt(job.endDate.substring(5, 7));
    const sq = Math.ceil(sm / 3), eq = Math.ceil(em / 3);

    // Round viewport center to 0.5° grid for stable keys across small pans
    const cLat = (Math.round((south + north) / 2 / 0.5) * 0.5).toFixed(1);
    const cLng = (Math.round((west + east) / 2 / 0.5) * 0.5).toFixed(1);

    for (let y = sy; y <= ey; y++) {
        const q0 = y === sy ? sq : 1;
        const q1 = y === ey ? eq : 4;
        for (let q = q0; q <= q1; q++) {
            // Don't mark the current quarter as complete — new imagery
            // keeps arriving, so the user should be able to re-detect.
            if (y === currentYear && q === currentQuarter) continue;
            const key = `__qtr:${y}_${q}:${cLat}_${cLng}`;
            const val = [south, west, north, east];
            processedMap.set(key, val, ts, peerId);
            store.put('proc', key, val, ts, peerId);
            syncManager.onLocalWrite('proc', key);
        }
    }
}

function finishDetection(stats, job) {
    store.flush();

    rebuildDetections();
    const features = crossDateCluster(allRawDetections);
    const src = map.getSource('client-detections');
    if (src) src.setData({ type: 'FeatureCollection', features });

    const sessionDetections = _preSessionKeys
        ? allRawDetections.filter(d => !_preSessionKeys.has(`${d.block_id}:${d.date}`))
        : allRawDetections;
    const sessionClusters = crossDateCluster(sessionDetections);

    _isDetecting = false;
    _preSessionKeys = null;

    writeQuarterCompletionMarkers(job);
    updateQuarterIndicators();

    document.getElementById('detect-bar').style.width = '100%';
    document.getElementById('detect-bar').style.background = '#808080';

    if (sessionClusters.length === 0) {
        document.getElementById('detect-text').textContent = stats
            ? `No flares found · ${stats.images} images`
            : 'No flares found';
    } else {
        document.getElementById('detect-text').textContent =
            `${sessionClusters.length} flare${sessionClusters.length !== 1 ? 's' : ''} · ${stats?.images || '?'} images`;
    }
    setTimeout(resetDetectUI, 3000);
}

map.on('move', updateWorldBox);

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

    // Grayscale, underexposed satellite imagery fades in over the dark basemap
    // once facilities resolve (guidelines: gradient-map grayscale, approximated
    // with full desaturation + lowered brightness ceiling).
    map.addSource('satellite', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256
    });
    map.addLayer({
        id: 'satellite', type: 'raster', source: 'satellite', minzoom: 7,
        paint: {
            'raster-saturation': -1,
            'raster-brightness-max': 0.75,
            'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 9, 1]
        }
    });

    // Preload the marking images every layer references.
    [`flare-${RAMP[0]}`, `flare-${RAMP[1]}`, `flare-${RAMP[2]}`, 'triangle-#FFFFFF', 'square-#FFFFFF', 'highlight-#FFFFFF'].forEach(ensureMark);

    // Detections restored from IndexedDB + peers via onChange callback.
    scheduleDetectionUpdate();

    // LNG terminal dots
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
        // Triangle marking = structure (LNG terminals)
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

        // labels attach up-and-right of the marking (dd cartography label rule)
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'dd-popup', anchor: 'bottom-left', offset: 10 });

        map.on('mousemove', 'lng-terminal-hitarea', e => {
            map.getCanvas().style.cursor = 'pointer';
            const f = e.features[0];
            const p = f.properties;
            const cap = p.capacity_mtpa ? `${p.capacity_mtpa} mtpa` : '\u2014';
            popup.setLngLat(e.lngLat)
                .setHTML(`<span class="dd-title">${p.name}</span><br>${p.country} \u00b7 ${p.type}<br>${cap}`)
                .addTo(map);
        });
        map.on('mouseleave', 'lng-terminal-hitarea', () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
        });
    });

    // OGIM infrastructure overlay (PMTiles vector tiles)
    try {
        // Canvas icons for wells and facilities
        map.addSource('ogim', {
            type: 'vector',
            url: `pmtiles://${OGIM_URL}`,
            maxzoom: 14
        });

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

    map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    // Selection: heavy-stroke empty highlight box marking around the resolved poi
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
        const tolerance = 15;
        const bbox = [[e.point.x - tolerance, e.point.y - tolerance], [e.point.x + tolerance, e.point.y + tolerance]];

        const queryLayers = [];
        if (map.getLayer('client-detection-circles')) queryLayers.push('client-detection-circles');
        if (queryLayers.length === 0) { closeInfo(); return; }
        const features = map.queryRenderedFeatures(bbox, { layers: queryLayers });

        if (features.length === 0) {
            closeInfo();
            return;
        }

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

});

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

// Key needs the inline marking svgs before first render.
loadMarks().then(updateLegend);

document.getElementById('download-btn').addEventListener('click', downloadFlareCSV);
document.getElementById('open-image-btn').addEventListener('click', () => {
    if (!currentFeature || !selectedDetection) return;
    window.open(copernicusUrl(selectedDetection.date), '_blank');
});
document.getElementById('detect-btn').addEventListener('click', startDetection);

let _sliderTimer = 0;
function debouncedRecluster() {
    clearTimeout(_sliderTimer);
    _sliderTimer = setTimeout(() => { updateCurrentSource(); reselectCurrentFeature(); }, 80);
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

// chevron and heading text both toggle expand/contract (dd heading rule)
for (const [ids, panel] of [[['collapse-toggle', 'collapse-title'], 'title-panel'], [['info-collapse', 'info-name'], 'info']])
    for (const id of ids)
        document.getElementById(id).addEventListener('click', () =>
            document.getElementById(panel).classList.toggle('collapsed'));

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

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

// Archive builds start with the detect/P2P controls hidden; updateS2Controls reveals
// them — and lazily loads the CRDT — once the viewport lands outside MGRS coverage.
// A pure-detect build (no archive) is all-detect, so load the CRDT up front.
if (S2_ARCHIVE) updateS2Controls();
else ensureDetect();

// Deep link: navigate to a VNF flare by hash (#vnf/12345)
async function navigateToFlare(flareId) {
    _suppressHashUpdate = true;

    // Ensure VNF mode is active and initialized
    if (currentMode !== 'vnf') switchMode('vnf');

    // Wait for VNF to be ready (initVNF is triggered by switchMode)
    const deadline = Date.now() + 15000;
    while (!vnfReady() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
    }
    if (!vnfReady()) { _suppressHashUpdate = false; return; }

    const dateRange = getSelectedDateRange();
    if (!dateRange) { _suppressHashUpdate = false; return; }

    const fc = await queryVNFFlare(flareId, dateRange.startDate, dateRange.endDate);
    if (!fc.features.length) { _suppressHashUpdate = false; return; }

    const raw = fc.features[0];
    const enriched = enrichVNFFeatures([raw], VNF_AVG_RH_MIN);
    if (!enriched.length) { _suppressHashUpdate = false; return; }

    const feature = enriched[0];
    const [lon, lat] = feature.geometry.coordinates;
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12) });

    // Wait for map to settle, then refresh VNF layer and show info
    map.once('idle', () => {
        refreshVNF().then(() => {
            showInfo(feature);
            _suppressHashUpdate = false;
        });
    });
}

// Start in S2 mode (or VNF if deep link present)
map.on('load', () => {
    const flareId = parseFlareHash();
    if (flareId) {
        navigateToFlare(flareId);
    } else {
        switchMode('s2');
    }
});

// Handle back/forward navigation
window.addEventListener('hashchange', () => {
    const flareId = parseFlareHash();
    if (flareId) navigateToFlare(flareId);
});

document.addEventListener('keydown', e => {
    if (!document.getElementById('info').classList.contains('visible')) return;
    const key = e.key;
    if (key === 'Escape') { closeInfo(); return; }
    let dir = 0;
    if (key === 'ArrowDown' || key === 'j') dir = 1;
    else if (key === 'ArrowUp' || key === 'k') dir = -1;
    if (!dir) return;
    e.preventDefault();
    const sel = currentMode === 'vnf' ? '.event-item' : '.event-item:not(.l1c-only)';
    const items = Array.from(document.querySelectorAll(sel));
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el.classList.contains('active'));
    const nextIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
    if (nextIdx === activeIdx) return;
    items[nextIdx].click();
    items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
