import { LWWMap } from './crdt.js';
import { Store } from './store.js';
import { PeerMesh, geohash3 } from './rtc.js';
import { SyncManager, validateDetection } from './sync.js';

// ---------------------------------------------------------------------------
// P2P sync (LWW-Map CRDT)
// ---------------------------------------------------------------------------

const MIN_DETECT_ZOOM = 11;
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
    processedMap.forEach((value) => {
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
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            }
        },
        layers: [{
            id: 'basemap',
            type: 'raster',
            source: 'satellite',
            paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.85 }
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
    return Array.from(processedMap.keys());
}

// --- Batched block result writes ---
const _pendingBlocks = [];
let _flushTimer = null;
const FLUSH_INTERVAL = 200;
const FLUSH_BATCH_SIZE = 20;

function flushPendingBlocks() {
    if (_pendingBlocks.length === 0) return;
    const batch = _pendingBlocks.splice(0);
    const ts = Date.now();
    const peerId = mesh.localPeerId;
    for (const { blockId, date, detections, lat, lng } of batch) {
        const key = `${blockId}:${date}`;
        const loc = [lat || 0, lng || 0];
        processedMap.set(key, loc, ts, peerId);
        store.put('proc', key, loc, ts, peerId);
        syncManager.onLocalWrite('proc', key);
        if (detections.length > 0) {
            detectionMap.set(key, detections, ts, peerId);
            store.put('det', key, detections, ts, peerId);
            syncManager.onLocalWrite('det', key);
        }
    }
}

function cacheBlockResult(blockId, date, detections, lat, lng) {
    _pendingBlocks.push({ blockId, date, detections, lat, lng });
    if (_pendingBlocks.length >= FLUSH_BATCH_SIZE) {
        flushNow();
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(() => {
            _flushTimer = null;
            flushPendingBlocks();
        }, FLUSH_INTERVAL);
    }
}

function flushNow() {
    clearTimeout(_flushTimer);
    _flushTimer = null;
    flushPendingBlocks();
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
        el.textContent = 'no peers';
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
    flushNow();

    _helpWorker = new Worker('detect.js');
    _helpWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'blockDetections') {
            cacheBlockResult(msg.blockId, msg.date, msg.detections, msg.lat, msg.lng);
        } else if (msg.type === 'done') {
            stopHelping();
        } else if (msg.type === 'error') {
            stopHelping();
        }
    };
    _helpWorker.onerror = () => stopHelping();

    _helpWorker.postMessage({
        bbox: job.bbox, epsg: job.epsg,
        startDate: job.startDate, endDate: job.endDate,
        cachedBlockDates: getCachedBlockKeys(),
        peerIndex, peerCount
    });
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

    // Pad viewport by half a block so edge blocks (processed but centered
    // just outside the viewport) still count toward coverage
    const PAD = BLOCK_DEG / 2;
    const pw = vw - PAD, ps = vs - PAD, pe = ve + PAD, pn = vn + PAD;

    // Build a map of quarter -> set of grid cells that have a processed block
    const quarterCells = new Map();
    processedMap.forEach((value, key) => {
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

    // How many grid cells does the viewport span?
    const expectedRows = Math.max(1, Math.ceil((vn - vs) / BLOCK_DEG));
    const expectedCols = Math.max(1, Math.ceil((ve - vw) / BLOCK_DEG));
    const expectedCells = expectedRows * expectedCols;

    // A quarter is "detected" if its blocks cover ≥70% of the viewport grid
    const quarters = new Set();
    for (const [qKey, cells] of quarterCells) {
        const coverage = cells.size / expectedCells;
        if (coverage >= 0.7) quarters.add(qKey);
    }
    return quarters;
}

function updateQuarterIndicators() {
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
            if (year === currentYear && q === currentQuarter) btn.classList.add('active');
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
    updateDetectButton();
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

// Color scale for B12 intensity
const b12ColorScale = ['interpolate', ['linear'], ['coalesce', ['get', 'max_b12'], 0.9],
    0.9, '#e04090', 1.1, '#ff4530', 1.3, '#ffff00'];

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

function b12Color(b12) {
    const t = Math.max(0.15, Math.min(1, (b12 - 0.9) / 0.4));
    const [r, g, b] = magmaColor(t);
    return `rgb(${r},${g},${b})`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}

function copernicusUrl(lat, lon, date) {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    return `https://browser.dataspace.copernicus.eu/?zoom=15&lat=${lat}&lng=${lon}&datasetId=S2_L2A_CDAS&fromTime=${encodeURIComponent(from)}&toTime=${encodeURIComponent(to)}&layerId=1_TRUE_COLOR&dateMode=SINGLE`;
}

function setCirclesGreyed() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'circle-stroke-color', '#bbb');
    map.setPaintProperty('client-detection-circles', 'circle-stroke-opacity', 0.6);
}

function setCirclesDefault() {
    if (!map.getLayer('client-detection-circles')) return;
    map.setPaintProperty('client-detection-circles', 'circle-stroke-color', b12ColorScale);
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

    const b12Val = d => d.b12_corrected;
    const b12Values = sorted.map(b12Val).filter(v => v > 0);
    const dataMin = Math.min(...b12Values), dataMax = Math.max(...b12Values);
    const padding = (dataMax - dataMin) * 0.1 || 0.1;
    const minB12 = Math.max(0, dataMin - padding), maxB12 = dataMax + padding;
    const b12Range = maxB12 - minB12 || 0.1;

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
        const b12 = b12Val(det);
        const y = margin.top + innerH - ((b12 - minB12) / b12Range) * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="3.5" fill="${b12Color(b12)}" data-idx="${i}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>`;
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
    const sw = self.utmToWgs84(minX, minY, zone, isNorth);
    const ne = self.utmToWgs84(maxX, maxY, zone, isNorth);
    return [sw[0], sw[1], ne[0], ne[1]];
}

function showInfo(feature, { skipAutoSelect = false } = {}) {
    currentFeature = feature;
    selectedDetection = null;
    const props = feature.properties;

    setCirclesGreyed();

    const selectionSource = map.getSource('selection-highlight');
    if (selectionSource) selectionSource.setData(feature);
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'visible');
    }

    document.getElementById('info').classList.add('visible');
    document.getElementById('info-name').textContent = props.name || 'Unknown facility';
    const sub = document.getElementById('info-subtitle');
    if (sub) sub.textContent = props.terminal
        ? `${props.detection_count} detection${props.detection_count !== 1 ? 's' : ''}`
        : '';

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

    const list = document.getElementById('events-list');
    list.innerHTML = '';

    const sorted = [...detections].sort((a, b) => new Date(b.date) - new Date(a.date));
    const dateToItem = new Map();
    let firstItem = null;

    sorted.forEach(det => {
        const item = document.createElement('div');
        const url = det.cog_b12;
        const isL1C = !url || typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif');
        item.className = 'event-item' + (isL1C ? ' l1c-only' : '');
        item.dataset.date = det.date;
        item.innerHTML = `
            <span class="event-date">${formatDate(det.date)}</span>
            <span class="event-meta event-meta-b12">${det.max_b12?.toFixed(2) || '-'}</span>
            <span class="event-meta event-meta-px">${det.pixels || '-'}</span>
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

    const MAX_VISIBLE_ROWS = window.innerWidth <= 768 ? 4 : 7;
    const items = list.querySelectorAll('.event-item');
    if (items.length > 0) {
        const rowH = items[0].offsetHeight;
        const visibleRows = Math.min(items.length, MAX_VISIBLE_ROWS);
        list.style.maxHeight = (rowH * visibleRows + 4) + 'px';
    }

    if (firstItem && !skipAutoSelect) selectDetection(firstItem.det, firstItem.item);

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
    loadImageryForDetection(det);
}

function closeInfo() {
    document.getElementById('info').classList.remove('visible');
    closeImagery();
    currentFeature = null;
    setCirclesDefault();
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'none');
    }
}

async function loadImageryForDetection(det) {
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');

    if (!det?.cog_b12) return;

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
    const [flareUtmX, flareUtmY] = self.wgs84ToUtm(flareLon, flareLat, zone, isNorth);
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
    if (!currentFeature) return;
    const props = currentFeature.properties;
    const [lon, lat] = currentFeature.geometry.coordinates;

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

    const rows = [['facility', 'terminal', 'lat', 'lon', 'date', 'max_b12', 'pixels']];
    for (const det of detections) {
        rows.push([
            `"${(props.name || '').replace(/"/g, '""')}"`,
            `"${(props.terminal || '').replace(/"/g, '""')}"`,
            det.raw_lat?.toFixed(6) || lat.toFixed(6),
            det.raw_lon?.toFixed(6) || lon.toFixed(6),
            det.date,
            det.max_b12?.toFixed(4) || '',
            det.pixels || ''
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
let CLUSTER_AVG_B12_MIN = 0.85;

function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fast equirectangular distance — accurate to <0.1% at distances under 1 km
// and at latitudes under ~70°. Used in the hot clustering loop to avoid trig.
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

function crossDateCluster(allDetections) {
    if (allDetections.length === 0) return [];

    // No clustering — emit every detection as its own feature
    if (MERGE_DISTANCE_M === 0) {
        const features = [];
        for (const det of allDetections) {
            if (det.max_b12 < CLUSTER_AVG_B12_MIN) continue;
            const terminal = findNearestTerminal(det.flare_lat, det.flare_lon);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [det.flare_lon, det.flare_lat] },
                properties: {
                    name: terminal ? terminal.name : det.date,
                    terminal: terminal?.name || null,
                    max_b12: det.max_b12,
                    detection_count: 1,
                    detections: [{
                        date: det.date, max_b12: det.max_b12, pixels: det.pixels,
                        cog_b12: det.cog_b12, epsg: det.epsg, utm_bounds: det.utm_bounds,
                        raw_lon: det.flare_lon, raw_lat: det.flare_lat,
                        b12_corrected: det.max_b12
                    }]
                }
            });
        }
        return features;
    }

    const sorted = allDetections.slice().sort((a, b) => b.max_b12 - a.max_b12);

    const CELL_DEG = MERGE_DISTANCE_M / 111320;
    const grid = new Map();
    const clusters = [];
    // Numeric grid key: pack row/col into a single integer (avoids string alloc)
    const KEY_SHIFT = 0x100000;  // 2^20, enough for ~±500 000 grid rows

    for (const det of sorted) {
        const gRow = Math.floor(det.flare_lat / CELL_DEG);
        const gCol = Math.floor(det.flare_lon / CELL_DEG);
        let bestIdx = -1, bestDist = Infinity;

        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const key = (gRow + dr) * KEY_SHIFT + (gCol + dc);
                const bucket = grid.get(key);
                if (!bucket) continue;
                for (const ci of bucket) {
                    const a = clusters[ci].anchor;
                    const d = fastDistM(det.flare_lat, det.flare_lon, a.flare_lat, a.flare_lon);
                    if (d <= MERGE_DISTANCE_M && d < bestDist) {
                        bestDist = d;
                        bestIdx = ci;
                    }
                }
            }
        }

        if (bestIdx >= 0) {
            clusters[bestIdx].members.push(det);
        } else {
            const ci = clusters.length;
            clusters.push({ anchor: det, members: [det] });
            const key = gRow * KEY_SHIFT + gCol;
            const bucket = grid.get(key);
            if (bucket) bucket.push(ci);
            else grid.set(key, [ci]);
        }
    }

    const features = [];
    for (const cluster of clusters) {
        const members = cluster.members;
        const byDate = {};
        for (const d of members) {
            if (!byDate[d.date] || d.max_b12 > byDate[d.date].max_b12) byDate[d.date] = d;
        }
        const deduped = Object.values(byDate);
        if (deduped.length < 4) continue;
        const avgClusterB12 = deduped.reduce((s, d) => s + d.max_b12, 0) / deduped.length;
        if (avgClusterB12 < CLUSTER_AVG_B12_MIN) continue;
        let anchor = deduped[0];
        for (const d of deduped) { if (d.max_b12 > anchor.max_b12) anchor = d; }

        const terminal = findNearestTerminal(anchor.flare_lat, anchor.flare_lon);
        const name = terminal ? terminal.name : `${deduped.length} detection${deduped.length !== 1 ? 's' : ''}`;

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [anchor.flare_lon, anchor.flare_lat] },
            properties: {
                name,
                terminal: terminal?.name || null,
                max_b12: anchor.max_b12,
                detection_count: deduped.length,
                detections: deduped.map(d => {
                    return {
                        date: d.date, max_b12: d.max_b12, pixels: d.pixels,
                        cog_b12: d.cog_b12, epsg: d.epsg, utm_bounds: d.utm_bounds,
                        raw_lon: d.flare_lon, raw_lat: d.flare_lat,
                        b12_corrected: d.max_b12
                    };
                })
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

function guessEpsg(bbox) {
    const lon = (bbox[0] + bbox[2]) / 2;
    const lat = (bbox[1] + bbox[3]) / 2;
    const zone = Math.floor((lon + 180) / 6) + 1;
    return lat >= 0 ? 32600 + zone : 32700 + zone;
}

function ensureDetectionLayer() {
    if (!map.isStyleLoaded()) return;
    if (!map.getSource('client-detections')) {
        map.addSource('client-detections', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('client-detection-circles')) {
        const circleRadius = ['interpolate', ['exponential', 1.5], ['zoom'],
            0, ['+', 4, ['*', ['coalesce', ['get', 'max_b12'], 0], 4]],
            6, ['+', 6, ['*', ['coalesce', ['get', 'max_b12'], 0], 6]],
            10, ['+', 10, ['*', ['coalesce', ['get', 'max_b12'], 0], 8]],
            14, ['+', 12, ['*', ['coalesce', ['get', 'max_b12'], 0], 10]]
        ];
        map.addLayer({
            id: 'client-detection-circles',
            type: 'circle',
            source: 'client-detections',
            paint: {
                'circle-radius': circleRadius,
                'circle-color': 'transparent',
                'circle-opacity': 0,
                'circle-stroke-color': b12ColorScale,
                'circle-stroke-width': 2,
                'circle-stroke-opacity': 1
            }
        });
    }
}

function updateDetectionSource() {
    const features = crossDateCluster(allRawDetections);
    const src = map.getSource('client-detections');
    if (src) src.setData({ type: 'FeatureCollection', features });
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

    detectWorker = new Worker('detect.js');
    detectWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'progress') {
            bar.style.width = msg.pct + '%';
            text.textContent = msg.stage;
        } else if (msg.type === 'blockDetections') {
            cacheBlockResult(msg.blockId, msg.date, msg.detections, msg.lat, msg.lng);
        } else if (msg.type === 'done') {
            cleanupDetection();
            finishDetection(msg.stats);
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

    detectWorker.postMessage({
        bbox: job.bbox, epsg: job.epsg,
        startDate: job.startDate, endDate: job.endDate,
        cachedBlockDates: getCachedBlockKeys(),
        peerIndex, peerCount
    });
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

function finishDetection(stats) {
    flushNow();

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

    if (terminalName) {
        locEl.style.display = 'none';
        termEl.textContent = terminalName;
    } else {
        locEl.style.display = '';
        locEl.textContent = `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
        termEl.textContent = '';
    }
}

map.on('move', updateMapCentre);

let _quarterIndicatorTimeout;
map.on('moveend', () => {
    clearTimeout(_quarterIndicatorTimeout);
    _quarterIndicatorTimeout = setTimeout(updateQuarterIndicators, 300);
    updateDetectButton();
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
        map.addLayer({
            id: 'lng-terminal-dots',
            type: 'circle',
            source: 'lng-terminals',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 6, 6, 12, 9],
                'circle-color': '#ffffff',
                'circle-opacity': 0.55,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1,
                'circle-stroke-opacity': 0.4
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

    map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    const circleRadius = ['interpolate', ['exponential', 1.5], ['zoom'],
        0, ['+', 4, ['*', ['coalesce', ['get', 'max_b12'], 0], 4]],
        6, ['+', 6, ['*', ['coalesce', ['get', 'max_b12'], 0], 6]],
        10, ['+', 10, ['*', ['coalesce', ['get', 'max_b12'], 0], 8]],
        14, ['+', 12, ['*', ['coalesce', ['get', 'max_b12'], 0], 10]]
    ];

    map.addLayer({
        id: 'selection-highlight',
        type: 'circle',
        source: 'selection-highlight',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': circleRadius,
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
    const [lon, lat] = currentFeature.geometry.coordinates;
    window.open(copernicusUrl(lat, lon, selectedDetection.date), '_blank');
});
document.querySelector('.close-btn').addEventListener('click', closeInfo);
document.getElementById('detect-btn').addEventListener('click', startDetection);

let _clusterSliderTimer = 0;
document.getElementById('cluster-range').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    MERGE_DISTANCE_M = val;
    document.getElementById('cluster-value').textContent = val === 0 ? 'Off' : `${val} m`;
    // Debounce clustering to avoid re-running on every pixel of slider drag
    clearTimeout(_clusterSliderTimer);
    _clusterSliderTimer = setTimeout(() => {
        updateDetectionSource();
        if (currentFeature) {
            const src = map.getSource('client-detections');
            if (src) {
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
        }
    }, 80);
});

let _intensitySliderTimer = 0;
document.getElementById('intensity-range').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    CLUSTER_AVG_B12_MIN = val;
    document.getElementById('intensity-value').textContent = val === 0 ? 'Off' : val.toFixed(2).replace(/^0\./, '.');
    clearTimeout(_intensitySliderTimer);
    _intensitySliderTimer = setTimeout(() => {
        updateDetectionSource();
        if (currentFeature) {
            const src = map.getSource('client-detections');
            if (src) {
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
        }
    }, 80);
});

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('title-panel').classList.toggle('collapsed');
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
    const items = Array.from(document.querySelectorAll('.event-item:not(.l1c-only)'));
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el.classList.contains('active'));
    const nextIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
    if (nextIdx === activeIdx) return;
    items[nextIdx].click();
    items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
