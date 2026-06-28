import { LWWMap } from './crdt.js';
import { Store } from './store.js';
import { PeerMesh, geohash3 } from './rtc.js';
import { SyncManager, validateDetection } from './sync.js';
import { initVNF, resetVNF, queryVNF, queryVNFFlare, isReady as vnfReady } from './vnf.js';
import { initS2Archive, queryS2Archive, isReady as s2ArchiveReady } from './s2archive.js';
import { clusterDetections, isSeasonal } from './vendor/s2-flares/lib/cluster.js';
import { wgs84ToUtm, utmToWgs84 } from './vendor/s2-flares/lib/geo.js';

// ---------------------------------------------------------------------------
// Mode state: 'vnf' or 's2'
// ---------------------------------------------------------------------------

let currentMode = null;
let _vnfInitStarted = false;
let _vnfFeatures = null;   // cached VNF FeatureCollection (clustered)
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

const VNF_BUCKET = document.querySelector('meta[name="vnf-bucket"]')?.content || '';
const VNF_VERSION = document.querySelector('meta[name="vnf-version"]')?.content || '';
// VNF parquet is public — no access key required. The filename is derived
// from the build password at upload time (see `make vnf-upload`).
const VNF_FILE = 'vnf-a35a6ae998275227.parquet';

// S2 mode reads precomputed detections straight from the CloudFerro parquet
// archive (s2-flares `box.sh publish`). When set, panning the viewport queries the
// archive — viewport tiles+dates enumerated via STAC, parquet objects range-read
// directly (anonymous LIST is denied, so no glob). The in-browser COG worker
// ("Detect" button) stays as the fallback for areas not yet archived.
const S2_ARCHIVE = document.querySelector('meta[name="s2-archive"]')?.content || '';

async function getVNFUrl() {
    if (!VNF_BUCKET || location.hostname === 'localhost') return 'vnf.parquet';
    const base = `${VNF_BUCKET}/${VNF_FILE}`;
    return VNF_VERSION && VNF_VERSION !== 'dev' ? `${base}?v=${VNF_VERSION}` : base;
}

// ---------------------------------------------------------------------------
// P2P sync (LWW-Map CRDT)
// ---------------------------------------------------------------------------

const MIN_DETECT_ZOOM = 11;
const MIN_VNF_ZOOM = 6;
let allRawDetections = [];
let terminalFeatures = [];

const detectionMap = new LWWMap();
const processedMap = new LWWMap();

// Local persistence
const store = new Store('burnoff');

// Signaling server URL
const _sigMeta = document.querySelector('meta[name="signaling-url"]');
const _sigUrl = _sigMeta
    ? _sigMeta.content
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:4444`;

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

// P2P mesh
const mesh = new PeerMesh({
    signalingUrl: _sigUrl,
    room: 'burnoff',
    onPeerConnect: () => {},
    onPeerDisconnect: () => {},
    onMessage: () => {},
    maxPeers: 8,
    getGeoSummary: computeGeoSummary
});

const syncManager = new SyncManager({
    detectionMap,
    processedMap,
    store,
    mesh
});

// Init: load from IndexedDB, then connect mesh
(async () => {
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
    mesh.connect();
})();

// Set initial awareness
syncManager.setLocalAwareness({ active: true, t: Date.now() });

// Clear awareness on page unload
window.addEventListener('beforeunload', () => {
    syncManager.setLocalAwareness(null);
    mesh.disconnect();
});

// Heartbeat: update timestamp every 15s
const AWARENESS_HEARTBEAT_MS = 15_000;

setInterval(() => {
    const states = syncManager.getActiveStates();
    const myState = states.get(mesh.localPeerId);
    if (myState) syncManager.setLocalAwareness({ ...myState, t: Date.now() });
}, AWARENESS_HEARTBEAT_MS);

function getActiveStates() {
    return syncManager.getActiveStates();
}

// Initialize map
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            },
            labels: {
                type: 'vector',
                url: 'https://tiles.openfreemap.org/planet',
                attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
            }
        },
        layers: [{
            id: 'basemap',
            type: 'raster',
            source: 'satellite',
            paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.85 }
        }, {
            id: 'country-borders',
            type: 'line',
            source: 'labels',
            'source-layer': 'boundary',
            filter: ['==', ['get', 'admin_level'], 2],
            paint: {
                'line-color': 'rgba(255, 255, 255, 0.25)',
                'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.5]
            }
        }, {
            id: 'country-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['==', ['get', 'class'], 'country'],
            minzoom: 2,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
                'text-transform': 'uppercase',
                'text-letter-spacing': 0.15,
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.85)',
                'text-halo-color': 'rgba(0, 0, 0, 0.6)',
                'text-halo-width': 1.5
            }
        }, {
            id: 'state-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['==', ['get', 'class'], 'state'],
            minzoom: 4,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 12],
                'text-letter-spacing': 0.1,
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.6)',
                'text-halo-color': 'rgba(0, 0, 0, 0.5)',
                'text-halo-width': 1
            }
        }, {
            id: 'city-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
            minzoom: 4,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14, 14, 18],
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.9)',
                'text-halo-color': 'rgba(0, 0, 0, 0.6)',
                'text-halo-width': 1.5
            }
        }, {
            id: 'village-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'neighbourhood']]],
            minzoom: 10,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 14],
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.7)',
                'text-halo-color': 'rgba(0, 0, 0, 0.5)',
                'text-halo-width': 1
            }
        }]
    },
    center: [51.52, 25.92],
    zoom: 12,
    minZoom: 1.5,
    maxZoom: 18
});

map.on('style.load', () => map.setProjection({ type: 'globe' }));

let currentFeature = null;
let selectedDetection = null;
let detectWorker = null;
let _isDetecting = false;
let _preSessionKeys = null;

// ---------------------------------------------------------------------------
// Block detection cache (LWW-Map CRDT — synced across all peers)
// ---------------------------------------------------------------------------

function getCachedBlockKeys() {
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
        updateDetectionSource();
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

// Subscribe to CRDT changes
detectionMap.onChange = (key, value, source) => {
    if (source === 'remote') {
        // Sanitize remote entries
        const clean = sanitizeDetections(key, value);
        if (clean === null) {
            detectionMap.delete(key);
        } else if (clean.length !== value.length) {
            const entry = detectionMap.getEntry(key);
            if (entry) {
                detectionMap.set(key, clean, entry.ts, entry.peerId);
            }
        }
    }
    scheduleDetectionUpdate();
};

// Peer count indicator
let _lastPeerCount = 0;
function updatePeerStatus() {
    const states = getActiveStates();
    let peers = states.size - 1;
    const el = document.getElementById('peer-status');
    if (!el) return;
    if (peers > 0) {
        el.textContent = `${peers} peer${peers !== 1 ? 's' : ''} connected`;
        el.classList.add('active');
    } else {
        el.textContent = 'No peers';
        el.classList.remove('active');
    }
    if (peers !== _lastPeerCount) _lastPeerCount = peers;
}

syncManager.onAwarenessChange(updatePeerStatus);
updatePeerStatus();


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

// Awareness listener for distributed detection coordination
syncManager.onAwarenessChange(() => {
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

    // Helper: look for a peer's job to assist with
    const states = getActiveStates();
    const myId = mesh.localPeerId;
    let activeJob = null;
    states.forEach((state, id) => {
        if (id !== myId && state.detecting && state.job) activeJob = state.job;
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
});

// Block grid is 256px at 20m = ~5120m ≈ 0.046° lat
const BLOCK_DEG = 0.046;

function getDetectedQuarters() {
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

function updateQuarterIndicators() {
    if (currentMode === 'vnf') {
        // No detected-quarter indicators in VNF mode
        document.querySelectorAll('.quarter-btn').forEach(btn => {
            btn.classList.remove('detected');
        });
        return;
    }
    const quarters = getDetectedQuarters();
    document.querySelectorAll('.quarter-btn').forEach(btn => {
        btn.classList.toggle('detected', quarters.has(`${btn.dataset.year}_${btn.dataset.quarter}`));
    });
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

function initQuarterPicker() {
    const container = document.getElementById('quarter-picker');
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentQuarter = Math.floor(currentMonth / 3) + 1;

    const years = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear];
    container.innerHTML = '';

    for (const year of years) {
        const row = document.createElement('div');
        row.className = 'quarter-row';

        const label = document.createElement('span');
        label.className = 'quarter-year';
        label.textContent = year;
        row.appendChild(label);

        const maxQ = (year === currentYear) ? currentQuarter : 4;
        for (let q = 1; q <= 4; q++) {
            if (q > maxQ) {
                const spacer = document.createElement('span');
                spacer.className = 'quarter-spacer';
                row.appendChild(spacer);
                continue;
            }
            const btn = document.createElement('button');
            btn.className = 'quarter-btn';
            btn.textContent = `Q${q}`;
            btn.dataset.year = year;
            btn.dataset.quarter = q;
            if (year >= currentYear - 1) btn.classList.add('active');
            btn.addEventListener('click', () => toggleQuarter(btn));
            row.appendChild(btn);
        }

        container.appendChild(row);
    }
}

function toggleQuarter(btn) {
    const wasActive = btn.classList.contains('active');
    const activeCount = document.querySelectorAll('.quarter-btn.active').length;
    if (wasActive && activeCount <= 1) return;
    btn.classList.toggle('active');
    if (currentMode === 'vnf') {
        scheduleVNFRefresh();
    } else {
        updateDetectButton();
        scheduleS2Refresh();
    }
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
        _vnfFeatures = null;
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
        const clustered = enrichVNFFeatures(_vnfRawFeatures);
        const clusteredFc = { type: 'FeatureCollection', features: clustered };
        _vnfFeatures = clusteredFc;
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

async function refreshS2Archive() {
    if (currentMode !== 's2' || !S2_ARCHIVE || _isDetecting) return;
    if (!s2ArchiveReady() || map.getZoom() < MIN_DETECT_ZOOM) { updateDetectionSource(); return; }
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

// Lazily spin up DuckDB for the archive, then refresh the viewport.
function ensureS2Archive() {
    if (!S2_ARCHIVE) return;
    if (s2ArchiveReady()) { refreshS2Archive(); return; }
    if (_s2InitStarted) return;
    _s2InitStarted = true;
    initS2Archive(S2_ARCHIVE)
        .then(() => { if (currentMode === 's2') refreshS2Archive(); })
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
    const col2 = document.getElementById('events-col2');
    const col3 = document.getElementById('events-col3');
    if (col2) col2.textContent = cfg.col2;
    if (col3) col3.textContent = cfg.col3;

    // Reconfigure sliders for current mode
    const clSlider = document.querySelector('.cluster-slider');
    const clRange = document.getElementById('cluster-range');
    // clustering is server-side in archive mode, so the merge-distance slider is
    // inert there; only the local-worker detect fallback (no archive) honours it.
    if (mode === 'vnf' || S2_ARCHIVE) {
        clSlider.style.display = 'none';
    } else {
        clSlider.style.display = '';
        MERGE_DISTANCE_M = S2_MERGE_DISTANCE_M;
        clRange.min = '0'; clRange.max = '200'; clRange.step = '5'; clRange.value = MERGE_DISTANCE_M;
        document.getElementById('cluster-value').textContent = MERGE_DISTANCE_M === 0 ? 'Off' : `${MERGE_DISTANCE_M} m`;
    }

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
                    if (currentMode === 'vnf') refreshVNF();
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

    updateCirclePaint();
}

function updateLegend() {
    const legend = document.querySelector('.legend');
    if (!legend) return;
    legend.innerHTML = buildLegendHTML(modeConf());
}

function updateCirclePaint() {
    if (!map.getLayer('client-detection-circles')) return;
    const isVnf = currentMode === 'vnf';
    map.setPaintProperty('client-detection-circles', 'circle-stroke-color', isVnf ? vnfColorExpr : s2ColorExpr);
    map.setPaintProperty('client-detection-circles', 'circle-radius', isVnf ? vnfRadiusExpr : s2RadiusExpr);
}

// ---------------------------------------------------------------------------
// Magma color ramp (8-stop)
// ---------------------------------------------------------------------------

function magmaColor(t) {
    t = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    const colors = [
        [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99],
        [212, 72, 66], [245, 125, 21], [250, 193, 39], [255, 255, 0]
    ];
    const idx = Math.min(Math.floor(t * (colors.length - 1)), colors.length - 2);
    const f = t * (colors.length - 1) - idx;
    const c1 = colors[idx], c2 = colors[idx + 1];
    return [
        Math.round(c1[0] + f * (c2[0] - c1[0])),
        Math.round(c1[1] + f * (c2[1] - c1[1])),
        Math.round(c1[2] + f * (c2[2] - c1[2]))
    ];
}

function magmaHex(t) {
    const [r, g, b] = magmaColor(t);
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Mode config — single source of truth for color, chart, legend, sliders
// ---------------------------------------------------------------------------

const RH_TO_MCM = 0.0315;

const MODE = {
    s2: {
        label: 'B12 reflectance',
        prop: 'max_b12',
        col2: 'B12', col3: 'px',
        stops: [0.9, 1.15, 1.5],
        log: false,
        chartRange: [0.85, 1.6],
        filter: { min: 0, max: 1.5, step: 0.05, default: 0.85 },
        formatFilter: v => v === 0 ? 'Off' : v.toFixed(2).replace(/^0\./, '.'),
        yVal: d => d.b12_corrected,
        formatVal: d => d.max_b12?.toFixed(2) || '-',
        formatCount: d => String(d.pixels || '-'),
        sentinel: null,
        // Radius: linear in value, zoom-dependent [base, multiplier]
        radiusZooms: [[0, 4, 4], [6, 6, 6], [10, 10, 8], [14, 12, 10]],
    },
    vnf: {
        label: 'Radiant heat (MW)',
        prop: 'max_rh',
        col2: 'RH', col3: 'MCM/d',
        stops: [1, 7, 20],
        log: true,
        chartRange: [0.5, 50],
        filter: { min: 0, max: 10, step: 0.5, default: 3 },
        formatFilter: v => v === 0 ? 'Off' : `${v} MW`,
        yVal: d => d.rh_mw || 0,
        formatVal: d => d.rh_mw >= 999 ? '-' : (d.rh_mw?.toFixed(1) || '-'),
        formatCount: d => d.rh_mw >= 999 ? '-' : (d.rh_mw != null ? (d.rh_mw * RH_TO_MCM).toFixed(2) : '-'),
        sentinel: 999,
        // Radius: log in value, zoom-dependent [base, multiplier, cap]
        radiusZooms: [[0, 4, 2, 8], [6, 6, 3, 12], [10, 8, 4, 14], [14, 10, 5, 16]],
    }
};

function modeConf() { return MODE[currentMode] || MODE.s2; }

// Normalize value to 0→1 on the mode's color scale (stops[0]→stops[2])
function scaleT(cfg, val) {
    const [lo, , hi] = cfg.stops;
    const raw = cfg.log
        ? Math.log(Math.max(lo, val) / lo) / Math.log(hi / lo)
        : (val - lo) / (hi - lo);
    // Map into [0.3, 1.0] of the magma ramp for visibility
    return 0.3 + Math.max(0, Math.min(1, raw)) * 0.7;
}

function scaleColor(cfg, val) {
    const [r, g, b] = magmaColor(scaleT(cfg, val));
    return `rgb(${r},${g},${b})`;
}

// Normalize value to 0→1 on the chart y-axis (wider than color stops)
function chartNorm(cfg, val) {
    const [lo, hi] = cfg.chartRange;
    if (cfg.log) return (Math.log(Math.max(lo, val)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    return (val - lo) / (hi - lo);
}

// Build MapLibre color interpolation expression from config
function buildColorExpr(cfg) {
    const prop = ['coalesce', ['get', cfg.prop], cfg.stops[0]];
    const expr = cfg.log
        ? ['interpolate', ['linear'], ['ln', ['+', prop, 1]]]
        : ['interpolate', ['linear'], prop];
    for (const stop of cfg.stops) {
        if (cfg.log) expr.push(Math.log(stop + 1));
        else expr.push(stop);
        expr.push(magmaHex(scaleT(cfg, stop)));
    }
    return expr;
}

// Build MapLibre radius expression from config
function buildRadiusExpr(cfg) {
    const prop = ['coalesce', ['get', cfg.prop], cfg.log ? 1 : 0];
    const scaled = cfg.log ? ['ln', ['+', prop, 1]] : prop;
    const expr = ['interpolate', ['exponential', 1.5], ['zoom']];
    for (const z of cfg.radiusZooms) {
        if (cfg.log) {
            const [zoom, base, mult, cap] = z;
            expr.push(zoom, ['+', base, ['min', cap, ['*', scaled, mult]]]);
        } else {
            const [zoom, base, mult] = z;
            expr.push(zoom, ['+', base, ['*', scaled, mult]]);
        }
    }
    return expr;
}

// Build legend HTML from config
function buildLegendHTML(cfg) {
    const stops = [...cfg.stops].reverse(); // high to low
    const items = stops.map((v, i) => {
        const label = i === 0 ? `${v}+` : String(v);
        return `<div class="legend-item"><div class="legend-circle" style="border-color: ${magmaHex(scaleT(cfg, v))}"></div>${label}</div>`;
    }).join('\n            ');
    return `
            <h4 class="label-sm">${cfg.label}</h4>
            ${items}
            <h4 class="label-sm legend-section">Infrastructure</h4>
            <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="1" y1="1" x2="9" y2="9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>LNG</div>
            ${new URLSearchParams(location.search).get('layer') === 'licenses' ? '<div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><rect x="1" y="1" width="8" height="8" fill="none" stroke="#6dd" stroke-width="1.2"/></svg>Licenses</div>' : ''}
            <label class="legend-item ogim-toggle-row">
                <input type="checkbox" id="ogim-toggle"${_ogimVisible ? ' checked' : ''}>
                <span>OGIM infrastructure</span>
            </label>
            <div class="ogim-sub-items" id="ogim-legend-items" style="display:${_ogimVisible ? '' : 'none'}">
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="0" y1="5" x2="10" y2="5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/></svg>Pipelines</div>
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><polygon points="5,1 9,5 5,9 1,5" fill="rgba(255,200,100,0.8)"/></svg>Facilities</div>
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="2" y1="2" x2="8" y2="8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="2" x2="2" y2="8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>Wells</div>
            </div>
        `;}

// Pre-built expressions (regenerated from config)
const s2ColorExpr = buildColorExpr(MODE.s2);
const vnfColorExpr = buildColorExpr(MODE.vnf);
const s2RadiusExpr = buildRadiusExpr(MODE.s2);
const vnfRadiusExpr = buildRadiusExpr(MODE.vnf);

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}

function copernicusUrl(date) {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const { lat, lng } = map.getCenter();
    const zoom = Math.round(map.getZoom());
    return `https://browser.dataspace.copernicus.eu/?zoom=${zoom}&lat=${lat}&lng=${lng}&datasetId=S2_L2A_CDAS&fromTime=${encodeURIComponent(from)}&toTime=${encodeURIComponent(to)}&layerId=6-SWIR&dateMode=SINGLE`;
}

function setCirclesGreyed() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'circle-stroke-color', '#bbb');
    map.setPaintProperty('client-detection-circles', 'circle-stroke-opacity', 0.6);
}

function setCirclesDefault() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'circle-stroke-color', currentMode === 'vnf' ? vnfColorExpr : s2ColorExpr);
    map.setPaintProperty('client-detection-circles', 'circle-stroke-opacity', 1);
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
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`;

    const firstYear = new Date(minDate).getFullYear();
    const lastYear = new Date(maxDate).getFullYear();
    for (let y = firstYear + 1; y <= lastYear; y++) {
        const jan1 = new Date(y, 0, 1).getTime();
        const x = margin.left + ((jan1 - minDate) / dateRange) * innerW;
        svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
        svg += `<text x="${x}" y="${height - 2}" fill="rgba(255,255,255,0.3)" font-size="8" text-anchor="middle">${y}</text>`;
    }

    sorted.forEach((det, i) => {
        const date = new Date(det.date);
        const x = margin.left + ((date - minDate) / dateRange) * innerW;
        const val = cfg.yVal(det);
        if (cfg.sentinel && val >= cfg.sentinel) return;
        const t = Math.max(0, Math.min(1, chartNorm(cfg, val)));
        const y = margin.top + innerH - t * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="3.5" fill="${scaleColor(cfg, val)}" data-idx="${i}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>`;
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

function formatMetrics(props) {
    if (!props.observations) return '';
    const pct = Math.round(props.persistence * 100);
    return `<span class="sub-hi">${pct}%</span> persistence<br>` +
        `<span class="sub-hi">${props.detection_count}</span> detections, <span class="sub-hi">${props.observations}</span> clear observations`;
}

function showInfo(feature, { skipAutoSelect = false } = {}) {
    currentFeature = feature;
    selectedDetection = null;

    // Update hash for VNF deep links
    if (!_suppressHashUpdate && currentMode === 'vnf' && feature.properties.flare_id) {
        history.replaceState(null, '', `#vnf/${feature.properties.flare_id}`);
    }
    const props = feature.properties;

    setCirclesGreyed();

    const selectionSource = map.getSource('selection-highlight');
    if (selectionSource) selectionSource.setData(feature);
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'visible');
    }

    document.getElementById('info').classList.add('visible');

    const isVnf = currentMode === 'vnf';
    document.getElementById('info-name').textContent =
        props.name || (isVnf ? `Flare #${props.flare_id}` : 'Unknown facility');

    const sub = document.getElementById('info-subtitle');
    if (sub) {
        if (isVnf || props.terminal || props.total_score != null) {
            sub.innerHTML = formatMetrics(props) ||
                `${props.detection_count} detection${props.detection_count !== 1 ? 's' : ''}`;
        } else {
            sub.textContent = '';
        }
    }

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

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
        item.className = 'event-item' + (isL1C ? ' l1c-only' : '');
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
    if (currentMode === 'vnf') showVNFHeatFootprint(det);
    else loadImageryForDetection(det);
}

function showVNFHeatFootprint(det) {
    // Inline cleanup (no brightness flash — mirrors loadImageryForDetection)
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');

    if (!det || !currentFeature) return;
    const [lon, lat] = currentFeature.geometry.coordinates;
    const rh = det.rh_mw || 0;
    if (rh <= 0) return;

    // Radius in real-world meters, sqrt-scaled from RH
    const radiusM = 50 * Math.sqrt(Math.max(rh, 0.5));
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * DEG_TO_RAD));

    // Canvas with radial gradient heat signature
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');

    const [r, g, b] = magmaColor(scaleT(MODE.vnf, rh));

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

    map.addSource('cog-source', {
        type: 'image',
        url: canvas.toDataURL(),
        coordinates: coords
    });
    map.addLayer({
        id: 'cog-layer',
        type: 'raster',
        source: 'cog-source',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' }
    }, 'client-detection-circles');

    setCirclesGreyed();
    map.setPaintProperty('basemap', 'raster-brightness-max', 0.25);
}

// Per-date halo for archive detections (no COG to render): a magma footprint at
// the detection's raw point, sized by its B12 intensity. Mirrors showVNFHeatFootprint.
function showS2HeatFootprint(det) {
    if (!det || !currentFeature) return;
    const lon = det.raw_lon ?? currentFeature.geometry.coordinates[0];
    const lat = det.raw_lat ?? currentFeature.geometry.coordinates[1];
    const b12 = det.max_b12 || det.b12_corrected || 0;
    if (b12 <= 0) return;

    const radiusM = 45 * Math.sqrt(b12);
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * DEG_TO_RAD));

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const [r, g, b] = magmaColor(scaleT(MODE.s2, b12));
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
    map.setPaintProperty('basemap', 'raster-brightness-max', 0.25);
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
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');

    if (!det?.cog_b12) return void showS2HeatFootprint(det);

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
                const [r, g, b] = magmaColor(t);
                imgData.data[i * 4] = r;
                imgData.data[i * 4 + 1] = g;
                imgData.data[i * 4 + 2] = b;
                imgData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        if (map.getLayer('cog-border')) map.removeLayer('cog-border');
        if (map.getSource('cog-border')) map.removeSource('cog-border');
        if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
        if (map.getSource('cog-source')) map.removeSource('cog-source');

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
        map.setPaintProperty('basemap', 'raster-brightness-max', 0.25);
    } catch (err) {
        console.error('Failed to load COG:', err);
        document.querySelector('.event-item.active')?.classList.remove('loading');
    }
}

function closeImagery() {
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');
    map.setPaintProperty('basemap', 'raster-brightness-max', 1);
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

let MERGE_DISTANCE_M = 135;
let S2_MERGE_DISTANCE_M = 135;
let CLUSTER_AVG_B12_MIN = MODE.s2.filter.default;
let VNF_AVG_RH_MIN = MODE.vnf.filter.default;

// Fast equirectangular distance — accurate to <0.1% at distances under 1 km
// and at latitudes under ~70°. Used in terminal grid lookup.
const DEG_TO_RAD = Math.PI / 180;
const R_EARTH = 6371000;
function fastDistM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD * Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
    return R_EARTH * Math.sqrt(dLat * dLat + dLon * dLon);
}

const TERMINAL_MATCH_M = 7500;

// Pre-built grid index for terminal features, rebuilt when terminals load.
let _terminalGrid = null;
let _terminalGridCell = 0;

function buildTerminalGrid() {
    const cell = TERMINAL_MATCH_M / 111320;       // degrees per grid cell
    _terminalGridCell = cell;
    const g = new Map();
    for (const f of terminalFeatures) {
        const [lon, lat] = f.geometry.coordinates;
        const r = Math.floor(lat / cell), c = Math.floor(lon / cell);
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const key = (r + dr) * 0x100000 + (c + dc);
                const bucket = g.get(key);
                if (bucket) bucket.push(f);
                else g.set(key, [f]);
            }
        }
    }
    _terminalGrid = g;
}

function findNearestTerminal(lat, lon) {
    if (!_terminalGrid || terminalFeatures.length === 0) return null;
    const cell = _terminalGridCell;
    const r = Math.floor(lat / cell), c = Math.floor(lon / cell);
    const key = r * 0x100000 + c;
    const bucket = _terminalGrid.get(key);
    if (!bucket) return null;
    let best = null, bestDist = Infinity;
    for (const f of bucket) {
        const [tLon, tLat] = f.geometry.coordinates;
        const d = fastDistM(lat, lon, tLat, tLon);
        if (d < bestDist) { bestDist = d; best = f; }
    }
    return best && bestDist <= TERMINAL_MATCH_M ? { name: best.properties.name, distance: bestDist } : null;
}

// `obs` (optional) overrides the persistence source: an array of
// {block_id, date, cloudFree} records (the S2-archive path). When omitted, the
// per-block/per-date observation budget is derived from processedMap as before.
// Map a precomputed archive cluster (clusters/data.parquet row) to the same Feature
// shape crossDateCluster emits, so rendering/detail/CSV are unchanged. The view is
// pre-clustered server-side, so the avg-B12 slider gates these rows client-side and
// the merge-distance/score controls don't re-run. The view carries no cloud counts,
// only the published persistence, so we report the cloud-free observation count
// (detections / persistence) and leave passes null — there is no total-pass figure
// to compute a meaningful cloud-free fraction from.
function archiveFeature(c) {
    const terminal = findNearestTerminal(c.lat, c.lon);
    const observations = c.persistence ? Math.round(c.detection_count / c.persistence) : c.date_count;
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
            name: terminal ? terminal.name : `${c.detection_count} detection${c.detection_count !== 1 ? 's' : ''}`,
            terminal: terminal?.name || null,
            max_b12: c.max_b12, detection_count: c.detection_count, seasonal: c.seasonal,
            total_score: c.total_score, ratio_score: c.ratio_score,
            persistence_score: c.persistence_score, glint_penalty: c.glint_penalty,
            max_ratio: c.max_ratio, min_glint: c.min_glint, glint_suspect: c.glint_suspect,
            persistence: c.persistence, passes: null, observations,
            detections: c.detections.map(d => ({
                date: d.date, max_b12: d.max_b12, pixels: d.pixels,
                raw_lon: d.lon, raw_lat: d.lat, b12_corrected: d.max_b12,
            })),
        },
    };
}

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
    } else {
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
        minDates: MERGE_DISTANCE_M === 0 ? 1 : 4,
        minAvgB12: CLUSTER_AVG_B12_MIN,
        observations: obsByDate,
    });

    // Wrap s2-flares cluster results into GeoJSON Features with burnoff-specific
    // persistence, terminal naming, and detection detail fields.
    const features = [];
    for (const cl of clusters) {
        const terminal = findNearestTerminal(cl.lat, cl.lon);
        const name = MERGE_DISTANCE_M === 0
            ? (terminal ? terminal.name : (cl.detections[0]?.date || ''))
            : (terminal ? terminal.name : `${cl.detection_count} detection${cl.detection_count !== 1 ? 's' : ''}`);

        // Burnoff persistence: detections / block-level observations
        let passes = null, observations = null, persistence = cl.persistence;
        if (MERGE_DISTANCE_M > 0) {
            // Collect block IDs from the original detections that belong to this cluster
            const clusterDets = cl.detections;
            const bids = new Set();
            for (const d of clusterDets) {
                // Find original detection with matching date/lon/lat to get block metadata
                const orig = allDetections.find(o =>
                    o.date === d.date &&
                    (o.flare_lon ?? o.lon) === d.lon &&
                    (o.flare_lat ?? o.lat) === d.lat
                );
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
            const orig = allDetections.find(o =>
                o.date === d.date &&
                (o.flare_lon ?? o.lon) === d.lon &&
                (o.flare_lat ?? o.lat) === d.lat
            );
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
// VNF spatial clustering (reuses grid-merge pattern from crossDateCluster)
// ---------------------------------------------------------------------------

function enrichVNFFeatures(features) {
    const result = [];
    for (const feat of features) {
        const p = feat.properties;
        const [lon, lat] = feat.geometry.coordinates;

        if (VNF_AVG_RH_MIN > 0 && p.avg_rh < VNF_AVG_RH_MIN) continue;

        const terminal = findNearestTerminal(lat, lon);
        const facilityName = p.facility_name || '';
        const facilityType = p.facility_type || '';
        const typeCat = [p.type, p.category].filter(Boolean).join(' \u2014 ');
        const name = facilityName || (terminal ? terminal.name : typeCat || `Flare #${p.flare_id}`);

        const passes = p.total_dates;
        const detection_count = p.detection_dates;
        const observations = Math.max(p.clear_dates, detection_count);
        const persistence = observations > 0 ? detection_count / observations : 0;

        result.push({
            type: 'Feature',
            geometry: feat.geometry,
            properties: {
                name,
                terminal: terminal?.name || null,
                facility_type: facilityType,
                facility_name: facilityName,
                flare_id: p.flare_id,
                type: p.type || '',
                category: p.category || '',
                country: p.country || '',
                avg_rh: p.avg_rh,
                max_rh: p.max_rh,
                detection_count,
                passes,
                observations,
                persistence,
                detections: p.detections
            }
        });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Client-side detection
// ---------------------------------------------------------------------------

function getViewportBbox() {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
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
        const circleRadius = currentMode === 'vnf' ? vnfRadiusExpr : s2RadiusExpr;
        const colorScale = currentMode === 'vnf' ? vnfColorExpr : s2ColorExpr;
        map.addLayer({
            id: 'client-detection-circles',
            type: 'circle',
            source: 'client-detections',
            paint: {
                'circle-radius': circleRadius,
                'circle-color': 'transparent',
                'circle-opacity': 0,
                'circle-stroke-color': colorScale,
                'circle-stroke-width': 2,
                'circle-stroke-opacity': 1
            }
        });
    }
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
    const dateRange = getSelectedDateRange();
    const clustered = enrichVNFFeatures(_vnfRawFeatures);
    const fc = { type: 'FeatureCollection', features: clustered };
    _vnfFeatures = fc;
    const src = map.getSource('client-detections');
    if (src) src.setData(fc);
}

function updateCurrentSource() {
    if (currentMode === 'vnf') updateVNFSource();
    else updateDetectionSource();
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
            bar.style.background = 'rgba(255,80,80,0.4)';
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
        bar.style.background = 'rgba(255,80,80,0.4)';
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
    document.getElementById('detect-bar').style.background = 'rgba(255,255,255,0.1)';

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

// Map load handler
const MIN_TERMINAL_LABEL_ZOOM = 12;

function updateMapCentre() {
    const c = map.getCenter();
    const locEl = document.getElementById('map-centre');
    const termEl = document.getElementById('map-terminal');

    let terminalName = null;
    if (map.getZoom() >= MIN_TERMINAL_LABEL_ZOOM && terminalFeatures.length > 0) {
        const bounds = map.getBounds();
        const names = new Set();
        for (const f of terminalFeatures) {
            const [lon, lat] = f.geometry.coordinates;
            if (bounds.contains([lon, lat])) names.add(f.properties.name);
        }
        if (names.size > 0) {
            const arr = [...names];
            terminalName = arr.length > 3
                ? arr.slice(0, 3).join(', ') + ', \u2026'
                : arr.join(', ');
        }
    }

    // Google Earth camera distance from visible map extent.
    // GE field of view is 35°, so visible_height = 2 * d * tan(17.5°).
    const bounds = map.getBounds();
    const visibleM = (bounds.getNorth() - bounds.getSouth()) * 111320;
    const geD = Math.round(visibleM / (2 * Math.tan(17.5 * Math.PI / 180)));
    const geH = map.getBearing().toFixed(1);
    const geT = map.getPitch().toFixed(1);
    const geUrl = `https://earth.google.com/web/@${c.lat.toFixed(6)},${c.lng.toFixed(6)},0a,${geD}d,35y,${geH}h,${geT}t,0r`;

    if (terminalName) {
        locEl.style.display = 'none';
        termEl.innerHTML = `<a href="${geUrl}" target="_blank" rel="noopener">${terminalName}</a>`;
    } else {
        locEl.style.display = '';
        locEl.innerHTML = `<a href="${geUrl}" target="_blank" rel="noopener">${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}</a>`;
        termEl.textContent = '';
    }
}

map.on('move', updateMapCentre);

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
    updateMapCentre();

    // Detections restored from IndexedDB + peers via onChange callback.
    scheduleDetectionUpdate();

    // LNG terminal dots
    fetch('terminals.geojson').then(r => r.json()).then(geojson => {
        terminalFeatures = geojson.features;
        buildTerminalGrid();
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
        // Generate X icon via canvas
        const xSize = 32;
        const xCanvas = document.createElement('canvas');
        xCanvas.width = xSize;
        xCanvas.height = xSize;
        const xCtx = xCanvas.getContext('2d');
        const pad = 6;
        xCtx.strokeStyle = '#ffffff';
        xCtx.lineWidth = 3;
        xCtx.lineCap = 'round';
        xCtx.beginPath();
        xCtx.moveTo(pad, pad);
        xCtx.lineTo(xSize - pad, xSize - pad);
        xCtx.moveTo(xSize - pad, pad);
        xCtx.lineTo(pad, xSize - pad);
        xCtx.stroke();
        const xData = xCtx.getImageData(0, 0, xSize, xSize);
        map.addImage('x-icon', { width: xSize, height: xSize, data: xData.data });

        map.addLayer({
            id: 'lng-terminal-dots',
            type: 'symbol',
            source: 'lng-terminals',
            layout: {
                'icon-image': 'x-icon',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 6, 0.55, 12, 0.85],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            },
            paint: {
                'icon-opacity': 1
            }
        });

        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'terminal-popup', offset: 10 });

        map.on('mousemove', 'lng-terminal-hitarea', e => {
            map.getCanvas().style.cursor = 'pointer';
            const f = e.features[0];
            const p = f.properties;
            const cap = p.capacity_mtpa ? `${p.capacity_mtpa} mtpa` : '\u2014';
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${p.name}</strong><br>${p.country} \u00b7 ${p.type}<br>${cap}`)
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
        const ogimCanvas = document.createElement('canvas');
        const ogimCtxOpts = { willReadFrequently: true };

        // × icon for wells
        const ws = 16;
        ogimCanvas.width = ws; ogimCanvas.height = ws;
        const wctx = ogimCanvas.getContext('2d', ogimCtxOpts);
        wctx.clearRect(0, 0, ws, ws);
        wctx.strokeStyle = 'white';
        wctx.lineWidth = 2;
        wctx.lineCap = 'round';
        const wp = 4;
        wctx.beginPath();
        wctx.moveTo(wp, wp); wctx.lineTo(ws - wp, ws - wp);
        wctx.moveTo(ws - wp, wp); wctx.lineTo(wp, ws - wp);
        wctx.stroke();
        map.addImage('ogim-well-x', { width: ws, height: ws, data: wctx.getImageData(0, 0, ws, ws).data });

        // ◆ icon for facilities
        const fs = 16;
        ogimCanvas.width = fs; ogimCanvas.height = fs;
        const fctx = ogimCanvas.getContext('2d');
        fctx.clearRect(0, 0, fs, fs);
        fctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
        const mid = fs / 2, fr = 5;
        fctx.beginPath();
        fctx.moveTo(mid, mid - fr);
        fctx.lineTo(mid + fr, mid);
        fctx.lineTo(mid, mid + fr);
        fctx.lineTo(mid - fr, mid);
        fctx.closePath();
        fctx.fill();
        map.addImage('ogim-facility-diamond', { width: fs, height: fs, data: fctx.getImageData(0, 0, fs, fs).data });

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
                'line-color': 'rgba(255, 255, 255, 0.3)',
                'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 2]
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
                'icon-image': 'ogim-facility-diamond',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 0.7, 16, 1]
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
                'icon-image': 'ogim-well-x',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 0.6, 16, 0.8]
            },
            paint: { 'icon-opacity': 0.6 }
        }, ogimBefore);
    } catch (e) {
        console.warn('OGIM layers not available:', e.message);
    }

    // Oil/gas licenses & concessions (gated behind ?layer=licenses URL param)
    if (new URLSearchParams(location.search).get('layer') === 'licenses')
    fetch('concessions.geojson').then(r => {
        if (!r.ok) return null;
        return r.json();
    }).then(geojson => {
        if (!geojson) return;
        map.addSource('licenses', { type: 'geojson', data: geojson });
        // Insert below terminal layer if it exists, otherwise append
        const before = map.getLayer('lng-terminal-hitarea') ? 'lng-terminal-hitarea' : undefined;
        map.addLayer({
            id: 'licenses-fill',
            type: 'fill',
            source: 'licenses',
            minzoom: 5,
            paint: {
                'fill-color': '#6dd',
                'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.03, 10, 0.1]
            }
        }, before);
        map.addLayer({
            id: 'licenses-outline',
            type: 'line',
            source: 'licenses',
            minzoom: 5,
            paint: {
                'line-color': '#6dd',
                'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 10, 1],
                'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 10, 0.6]
            }
        }, before);
        map.addLayer({
            id: 'licenses-labels',
            type: 'symbol',
            source: 'licenses',
            minzoom: 9,
            layout: {
                'text-field': ['get', 'name'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 13],
                'text-anchor': 'center',
                'text-max-width': 8,
                'text-allow-overlap': false
            },
            paint: {
                'text-color': '#aee',
                'text-halo-color': 'rgba(0,0,0,0.8)',
                'text-halo-width': 1,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.9]
            }
        });
        const licPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'terminal-popup', offset: 10 });
        map.on('mousemove', 'licenses-fill', e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            const type = (p.type || '').replace(/_/g, ' ').toLowerCase();
            const status = (p.status || '').replace(/_/g, ' ').toLowerCase();
            const area = p.area_sqkm ? `${Math.round(+p.area_sqkm)} km\u00b2` : '';
            const parts = [`<strong>${p.name}</strong>`];
            if (p.country) parts.push(p.country);
            if (type) parts.push(type);
            if (status) parts.push(status);
            if (area) parts.push(area);
            if (p.operator) parts.push(p.operator);
            licPopup.setLngLat(e.lngLat).setHTML(parts.join('<br>')).addTo(map);
        });
        map.on('mouseleave', 'licenses-fill', () => {
            map.getCanvas().style.cursor = '';
            licPopup.remove();
        });
    });

    map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'selection-highlight',
        type: 'circle',
        source: 'selection-highlight',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['exponential', 1.5], ['zoom'], 0, 8, 6, 12, 10, 18, 14, 22],
            'circle-color': 'transparent',
            'circle-opacity': 0,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-opacity': 1
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

document.getElementById('about-modal').addEventListener('click', function(e) {
    if (e.target === this || !e.target.closest('a')) this.classList.add('hidden');
});

document.getElementById('download-btn').addEventListener('click', downloadFlareCSV);
document.getElementById('open-image-btn').addEventListener('click', () => {
    if (!currentFeature || !selectedDetection) return;
    window.open(copernicusUrl(selectedDetection.date), '_blank');
});
document.querySelector('.close-btn').addEventListener('click', closeInfo);
document.getElementById('detect-btn').addEventListener('click', startDetection);

let _sliderTimer = 0;
function debouncedRecluster() {
    clearTimeout(_sliderTimer);
    _sliderTimer = setTimeout(() => { updateCurrentSource(); reselectCurrentFeature(); }, 80);
}

document.getElementById('cluster-range').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    MERGE_DISTANCE_M = val;
    S2_MERGE_DISTANCE_M = val;
    document.getElementById('cluster-value').textContent = val === 0 ? 'Off' : `${val} m`;
    debouncedRecluster();
});

document.getElementById('intensity-range').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    if (currentMode === 'vnf') VNF_AVG_RH_MIN = val;
    else CLUSTER_AVG_B12_MIN = val;
    document.getElementById('intensity-value').textContent = modeConf().formatFilter(val);
    debouncedRecluster();
});

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('title-panel').classList.toggle('collapsed');
});

// OGIM infrastructure toggle (delegated — legend is rebuilt on mode switch)
let _ogimVisible = false;
document.querySelector('.legend').addEventListener('change', e => {
    if (e.target.id !== 'ogim-toggle') return;
    _ogimVisible = e.target.checked;
    const vis = _ogimVisible ? 'visible' : 'none';
    for (const id of ['ogim-pipelines', 'ogim-facilities', 'ogim-wells']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    const items = document.getElementById('ogim-legend-items');
    if (items) items.style.display = _ogimVisible ? '' : 'none';
});

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

// Archive mode serves pre-computed clusters, so the local-worker detect path —
// and the P2P mesh that shares its workload — never runs. Hide both controls.
if (S2_ARCHIVE) {
    for (const id of ['peer-status', 'detect-btn'])
        document.getElementById(id)?.style.setProperty('display', 'none');
}

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
    const enriched = enrichVNFFeatures([raw]);
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
