import * as Y from 'https://esm.sh/yjs@13.6.29';
import { WebrtcProvider } from 'https://esm.sh/y-webrtc@10.3.0?deps=yjs@13.6.29';
import { IndexeddbPersistence } from 'https://esm.sh/y-indexeddb@9.0.12?deps=yjs@13.6.29';

// ---------------------------------------------------------------------------
// P2P sync (Yjs CRDT)
// ---------------------------------------------------------------------------

const ydoc = new Y.Doc();
const detectionMap = ydoc.getMap('detections');   // block_id:date → Detection[]
const processedMap = ydoc.getMap('processed');     // block_id:date → timestamp

// Local persistence (replaces localStorage block cache)
const persistence = new IndexeddbPersistence('burnoff', ydoc);

// P2P mesh — all Burnoff users share one room
const provider = new WebrtcProvider('burnoff-global', ydoc, {
    signaling: ['wss://signaling.yjs.dev']
});

// Immediately set awareness state so signaling announces us to peers right away
provider.awareness.setLocalState({ active: true, t: Date.now() });

// ---------------------------------------------------------------------------
// P2P debug bar
// ---------------------------------------------------------------------------

const P2P_DEBUG_MAX = 80;

let _p2pScrollRAF = null;

function p2pLog(text, cls) {
    const el = document.getElementById('p2p-debug');
    if (!el) return;
    const span = document.createElement('span');
    span.className = (cls ? cls + ' ' : '') + 'p2p-enter';
    const now = new Date();
    const ts = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0') + ':' +
               String(now.getSeconds()).padStart(2, '0');
    span.textContent = `[${ts}] ${text}`;
    // Remove animation class after it finishes
    span.addEventListener('animationend', () => span.classList.remove('p2p-enter'), { once: true });
    el.appendChild(span);
    // trim old entries (remove from left — oldest)
    while (el.children.length > P2P_DEBUG_MAX) el.removeChild(el.firstChild);
    // smooth-scroll to newest entry
    if (!_p2pScrollRAF) {
        _p2pScrollRAF = requestAnimationFrame(() => {
            _p2pScrollRAF = null;
            smoothScrollDebugBar(el);
        });
    }
}

function smoothScrollDebugBar(el) {
    const target = el.scrollWidth - el.clientWidth;
    const current = el.scrollLeft;
    const dist = target - current;
    if (dist <= 1) { el.scrollLeft = target; return; }
    const start = performance.now();
    const duration = Math.min(400, Math.max(150, dist * 2));
    function step(now) {
        const t = Math.min(1, (now - start) / duration);
        const ease = t * (2 - t); // ease-out quad
        el.scrollLeft = current + dist * ease;
        if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

p2pLog('p2p init — room: burnoff-global', 'p2p-info');

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
            paint: { 'raster-saturation': -1 }
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
let _preSessionKeys = null;  // snapshot of processedMap keys before detection

// ---------------------------------------------------------------------------
// Block detection cache (Yjs CRDT — synced across all peers)
// ---------------------------------------------------------------------------

function getCachedBlockKeys() {
    return Array.from(processedMap.keys());
}

// --- Batched block result writes ---
const _pendingBlocks = [];
let _flushTimer = null;
const FLUSH_INTERVAL = 200;   // ms — flush every 200ms during detection
const FLUSH_BATCH_SIZE = 20;  // or when this many blocks accumulate

function flushPendingBlocks() {
    if (_pendingBlocks.length === 0) return;
    const batch = _pendingBlocks.splice(0);
    let flareBlocks = 0, totalFlares = 0;
    ydoc.transact(() => {
        for (const { blockId, date, detections } of batch) {
            const key = `${blockId}:${date}`;
            processedMap.set(key, Date.now());
            if (detections.length > 0) {
                detectionMap.set(key, detections);
                flareBlocks++;
                totalFlares += detections.length;
            }
        }
    });
    if (totalFlares > 0) {
        p2pLog(`send: ${batch.length} blocks — ${totalFlares} flare${totalFlares !== 1 ? 's' : ''}`, 'p2p-up');
    } else {
        p2pLog(`send: ${batch.length} blocks — clear`, 'p2p-info');
    }
}

function cacheBlockResult(blockId, date, detections) {
    _pendingBlocks.push({ blockId, date, detections });
    if (_pendingBlocks.length >= FLUSH_BATCH_SIZE) {
        clearTimeout(_flushTimer);
        flushPendingBlocks();
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(() => {
            _flushTimer = null;
            flushPendingBlocks();
        }, FLUSH_INTERVAL);
    }
}

function loadCachedBlock(blockId, date) {
    return detectionMap.get(`${blockId}:${date}`) || null;
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

// Debounced detection update — coalesces rapid changes from sync
let _syncUpdateTimer;

function scheduleDetectionUpdate() {
    clearTimeout(_syncUpdateTimer);
    _syncUpdateTimer = setTimeout(() => {
        rebuildDetections();
        ensureDetectionLayer();
        updateDetectionSource();
    }, 50);
}

// Subscribe to CRDT changes (local writes, IndexedDB restore, remote peers)
detectionMap.observe((event) => {
    scheduleDetectionUpdate();
    // Log remote changes (transaction.local === false means from a peer)
    if (event.transaction.local) return;
    let added = 0, updated = 0, flares = 0;
    event.changes.keys.forEach((change, key) => {
        if (change.action === 'add') { added++; }
        else if (change.action === 'update') { updated++; }
        const dets = detectionMap.get(key);
        if (dets) flares += dets.length;
    });
    const parts = [];
    if (added) parts.push(`${added} new block${added !== 1 ? 's' : ''}`);
    if (updated) parts.push(`${updated} updated`);
    if (flares) parts.push(`${flares} flare${flares !== 1 ? 's' : ''}`);
    if (parts.length) p2pLog(`recv: ${parts.join(', ')}`, 'p2p-down');
});

// Migrate existing localStorage cache to Yjs (one-time)
function migrateFromLocalStorage() {
    if (localStorage.getItem('burnoff:migrated')) return;
    const keysToRemove = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key.startsWith('b:')) continue;
            keysToRemove.push(key);
            const blockDateKey = key.slice(2);
            const data = localStorage.getItem(key);
            if (!data) continue;
            const dets = JSON.parse(data);
            ydoc.transact(() => {
                processedMap.set(blockDateKey, Date.now());
                if (dets.length > 0) detectionMap.set(blockDateKey, dets);
            });
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        localStorage.setItem('burnoff:migrated', '1');
    } catch (e) { console.warn('Migration failed:', e); }
}

persistence.once('synced', () => {
    const blocks = detectionMap.size;
    p2pLog(`indexeddb loaded — ${blocks} block${blocks !== 1 ? 's' : ''} in cache`, 'p2p-info');
    migrateFromLocalStorage();
    scheduleDetectionUpdate();
});

// Peer count indicator
let _lastPeerCount = 0;
function updatePeerStatus() {
    const states = provider.awareness.getStates();
    let peers = states.size - 1; // exclude self
    // Fallback: iOS Chrome can fail to propagate awareness states while the
    // WebRTC data channel works fine — use actual connection count instead.
    if (peers <= 0 && provider.room) {
        const conns = provider.room.webrtcConns;
        if (conns && conns.size > 0) peers = conns.size;
    }
    const el = document.getElementById('peer-status');
    if (!el) return;
    if (peers > 0) {
        el.textContent = `${peers} peer${peers !== 1 ? 's' : ''} connected`;
        el.classList.add('active');
    } else {
        el.textContent = 'no peers';
        el.classList.remove('active');
    }
    if (peers !== _lastPeerCount) {
        if (peers > _lastPeerCount) {
            p2pLog(`peer joined — ${peers} connected`, 'p2p-peer');
        } else {
            p2pLog(`peer left — ${peers} connected`, 'p2p-peer');
        }
        _lastPeerCount = peers;
    }
}

provider.awareness.on('change', updatePeerStatus);
provider.on('synced', () => {
    updatePeerStatus();
    p2pLog('webrtc synced', 'p2p-info');
});
updatePeerStatus();

// Poll peer status every 2s as a fallback — awareness change events can be
// missed when the WebRTC data channel connects slightly after signaling.
setInterval(updatePeerStatus, 2000);

// ---------------------------------------------------------------------------
// Awareness helpers for distributed detection
// ---------------------------------------------------------------------------

function setDetectingState(job) {
    const prev = provider.awareness.getLocalState() || {};
    provider.awareness.setLocalState({ ...prev, detecting: true, job, t: Date.now() });
}

function clearDetectingState() {
    const prev = provider.awareness.getLocalState() || {};
    delete prev.detecting;
    delete prev.job;
    provider.awareness.setLocalState({ ...prev, t: Date.now() });
}

/**
 * Get a deterministic partition for this peer among available peers.
 * Excludes peers that are busy running their own (different) detection,
 * so only idle helpers + the requester participate.
 *
 * @param {string} jobId — the job being partitioned; peers with a
 *   *different* job in their awareness state are excluded.
 */
function getPeerPartition(jobId) {
    const states = provider.awareness.getStates();
    const myId = provider.awareness.clientID;
    const ids = [];
    states.forEach((state, id) => {
        // Exclude peers busy with a different job
        if (state.detecting && state.job && state.job.id !== jobId) return;
        ids.push(id);
    });
    ids.sort((a, b) => a - b);
    const peerIndex = ids.indexOf(myId);
    return { peerIndex: Math.max(0, peerIndex), peerCount: ids.length };
}

// --- Helper worker for assisting a peer's detection ---
let _helpWorker = null;
let _helpingJobId = null;   // tracks which job we're helping with
let _helpingPeerCount = 0;  // tracks partition size so we restart on change

function startHelpingDetection(job, peerIndex, peerCount) {
    if (_helpWorker) { _helpWorker.terminate(); _helpWorker = null; }
    _helpingJobId = job.id;
    _helpingPeerCount = peerCount;

    // Flush any pending results before (re)starting
    clearTimeout(_flushTimer);
    _flushTimer = null;
    flushPendingBlocks();

    const cachedBlockDates = getCachedBlockKeys();
    _helpWorker = new Worker('detect-worker.js');

    _helpWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'blockDetections') {
            cacheBlockResult(msg.blockId, msg.date, msg.detections);
        } else if (msg.type === 'done') {
            const s = msg.stats;
            p2pLog(`help done: ${s.images} img, ${s.rawDetections} detections`, 'p2p-up');
            _helpWorker = null;
            _helpingJobId = null;
            _helpingPeerCount = 0;
        } else if (msg.type === 'error') {
            p2pLog(`help error: ${msg.message}`, 'p2p-info');
            _helpWorker = null;
            _helpingJobId = null;
            _helpingPeerCount = 0;
        }
    };

    _helpWorker.onerror = function() {
        _helpWorker = null;
        _helpingJobId = null;
        _helpingPeerCount = 0;
    };

    p2pLog(`helping: peer ${peerIndex + 1}/${peerCount}`, 'p2p-info');

    _helpWorker.postMessage({
        bbox: job.bbox,
        epsg: job.epsg,
        startDate: job.startDate,
        endDate: job.endDate,
        cachedBlockDates,
        peerIndex,
        peerCount
    });
}

// Watch for peers that start detecting — automatically help them
provider.awareness.on('change', () => {
    // Don't help if we're running our own detection
    if (_isDetecting) return;

    const states = provider.awareness.getStates();
    const myId = provider.awareness.clientID;

    // Find any peer that is detecting
    let activeJob = null;
    states.forEach((state, id) => {
        if (id === myId) return;
        if (state.detecting && state.job) activeJob = state.job;
    });

    if (activeJob && _helpingJobId !== activeJob.id) {
        // New job to help with
        const { peerIndex, peerCount } = getPeerPartition(activeJob.id);
        if (peerCount > 1) {
            startHelpingDetection(activeJob, peerIndex, peerCount);
        }
    } else if (activeJob && _helpingJobId === activeJob.id && _helpWorker) {
        // Same job but peer count may have changed (peer joined or left)
        const { peerIndex, peerCount } = getPeerPartition(activeJob.id);
        if (peerCount !== _helpingPeerCount) {
            p2pLog(`peers changed ${_helpingPeerCount}→${peerCount}, restarting help`, 'p2p-info');
            startHelpingDetection(activeJob, peerIndex, peerCount);
        }
    } else if (!activeJob && _helpWorker) {
        // Requesting peer finished or disconnected — stop helping
        _helpWorker.terminate();
        _helpWorker = null;
        _helpingJobId = null;
        _helpingPeerCount = 0;
        p2pLog('help stopped — requester done', 'p2p-info');
    }
});

// Viewport-keyed detection run tracking for quarter indicators
const RUNS_KEY = 'burnoff:runs';

function viewportKey() {
    const c = map.getCenter();
    // Round to 0.02° (~2km) — small enough that a real pan clears the state,
    // large enough that tiny jitter doesn't.
    return `${Math.round(c.lat * 50) / 50},${Math.round(c.lng * 50) / 50}`;
}

function markQuartersDetected(quarters) {
    try {
        const all = JSON.parse(localStorage.getItem(RUNS_KEY) || '{}');
        const vk = viewportKey();
        if (!all[vk]) all[vk] = {};
        for (const q of quarters) {
            all[vk][`${q.year}_${q.quarter}`] = true;
        }
        localStorage.setItem(RUNS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
}

function getDetectedQuarters() {
    try {
        const all = JSON.parse(localStorage.getItem(RUNS_KEY) || '{}');
        return all[viewportKey()] || {};
    } catch (e) { return {}; }
}

function updateQuarterIndicators() {
    const detected = getDetectedQuarters();
    document.querySelectorAll('.quarter-btn').forEach(btn => {
        const qKey = `${btn.dataset.year}_${btn.dataset.quarter}`;
        btn.classList.toggle('detected', !!detected[qKey]);
    });
    updateDetectButton();
}

function updateDetectButton() {
    const detected = getDetectedQuarters();
    const activeBtns = document.querySelectorAll('.quarter-btn.active');
    const allDetected = activeBtns.length > 0 && Array.from(activeBtns).every(btn => {
        const qKey = `${btn.dataset.year}_${btn.dataset.quarter}`;
        return !!detected[qKey];
    });
    const btn = document.getElementById('detect-btn');
    btn.disabled = allDetected;
}


// ---------------------------------------------------------------------------
// Quarter picker
// ---------------------------------------------------------------------------

function initQuarterPicker() {
    const container = document.getElementById('quarter-picker');
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed
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
        for (let q = 1; q <= maxQ; q++) {
            const btn = document.createElement('button');
            btn.className = 'quarter-btn';
            btn.textContent = `Q${q}`;
            btn.dataset.year = year;
            btn.dataset.quarter = q;
            // Default: current quarter selected
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
    // Prevent deselecting the last active quarter
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
        const d = new Date(year, endMonth, 0); // last day of end month
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
    const firstDate = new Date(Math.min(...dates));
    const minDate = new Date(firstDate.getFullYear(), 0, 1).getTime();
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

    sorted.forEach((det, i) => {
        const date = new Date(det.date);
        const x = margin.left + ((date - minDate) / dateRange) * innerW;
        const b12 = b12Val(det);
        const y = margin.top + innerH - ((b12 - minB12) / b12Range) * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="3.5" fill="${b12Color(b12)}" data-idx="${i}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>`;
    });

    if (dateRange > 30 * 24 * 60 * 60 * 1000) {
        const endMonth = new Date(maxDate).toLocaleString('en', { month: 'short' });
        svg += `<text x="${margin.left}" y="${height - 2}" fill="rgba(255,255,255,0.3)" font-size="8">Jan</text>`;
        svg += `<text x="${width - margin.right}" y="${height - 2}" fill="rgba(255,255,255,0.3)" font-size="8" text-anchor="end">${endMonth}</text>`;
    }

    svg += '</svg>';
    container.innerHTML = svg;

    container.querySelectorAll('.chart-dot').forEach(dot => {
        dot.addEventListener('click', e => {
            const idx = parseInt(e.target.dataset.idx);
            onSelectDate(sorted[idx]);
        });
    });
}

function utmToWgs84(utmBounds, epsg) {
    if (!epsg) return null;
    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    const utmProj = `+proj=utm +zone=${zone} ${isNorth ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
    const [minX, minY, maxX, maxY] = utmBounds;
    const sw = proj4(utmProj, 'EPSG:4326', [minX, minY]);
    const ne = proj4(utmProj, 'EPSG:4326', [maxX, maxY]);
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
            <span class="event-meta" style="text-align: right; width: 40px;">${det.max_b12?.toFixed(2) || '-'}</span>
            <span class="event-meta" style="text-align: right; width: 32px;">${det.pixels || '-'}</span>
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

    // Snap list height to whole rows (fewer on small screens)
    const MAX_VISIBLE_ROWS = window.innerWidth <= 768 ? 4 : 7;
    const items = list.querySelectorAll('.event-item');
    if (items.length > 0) {
        const rowH = items[0].offsetHeight;
        const visibleRows = Math.min(items.length, MAX_VISIBLE_ROWS);
        list.style.maxHeight = (rowH * visibleRows + 4) + 'px';
    }

    if (firstItem && !skipAutoSelect) selectDetection(firstItem.det, firstItem.item);

    // Release focus from map canvas so document keydown fires immediately
    document.activeElement?.blur();

    if (detections.length === 0) {
        document.getElementById('intensity-chart').innerHTML = '';
        list.innerHTML = '<div style="padding: 16px; color: rgba(255,255,255,0.4); text-align: center;">No detections</div>';
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
    const utmProj = `+proj=utm +zone=${zone} ${isNorth ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
    const [flareUtmX, flareUtmY] = proj4('EPSG:4326', utmProj, [flareLon, flareLat]);
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
        const bounds = utmToWgs84(actualUtmBounds, epsg);
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

    const rows = [['facility', 'lat', 'lon', 'date', 'max_b12', 'pixels']];
    for (const det of detections) {
        rows.push([
            `"${(props.name || '').replace(/"/g, '""')}"`,
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

const MERGE_DISTANCE_M = 50;
const CLUSTER_AVG_B12_MIN = 0.70;

function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function crossDateCluster(allDetections) {
    if (allDetections.length === 0) return [];

    // Sort brightest first so cluster anchors are the strongest detections.
    const sorted = allDetections.slice().sort((a, b) => b.max_b12 - a.max_b12);

    // Anchor-based clustering: each detection joins the nearest cluster whose
    // anchor is within MERGE_DISTANCE_M, or starts a new cluster. No transitive
    // chaining — prevents nearby but distinct flares from merging.
    const clusters = [];  // [{anchor, members}]
    for (const det of sorted) {
        let bestIdx = -1, bestDist = Infinity;
        for (let c = 0; c < clusters.length; c++) {
            const a = clusters[c].anchor;
            const d = haversineM(det.flare_lat, det.flare_lon, a.flare_lat, a.flare_lon);
            if (d <= MERGE_DISTANCE_M && d < bestDist) {
                bestDist = d;
                bestIdx = c;
            }
        }
        if (bestIdx >= 0) {
            clusters[bestIdx].members.push(det);
        } else {
            clusters.push({ anchor: det, members: [det] });
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

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [anchor.flare_lon, anchor.flare_lat] },
            properties: {
                name: `${deduped.length} detection${deduped.length !== 1 ? 's' : ''}`,
                max_b12: anchor.max_b12,
                detection_count: deduped.length,
                detections: deduped.map(d => {
                    const se = d.sun_elevation;
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

const MIN_DETECT_ZOOM = 11;
let allRawDetections = [];

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

// Track the current detection job and peer partition so we can restart on peer changes
let _currentJob = null;
let _currentPeerCount = 0;
let _peerChangeHandler = null;

function launchDetectWorker(job, bar, text) {
    if (detectWorker) { detectWorker.terminate(); detectWorker = null; }

    const { peerIndex, peerCount } = getPeerPartition(job.id);
    _currentPeerCount = peerCount;
    if (peerCount > 1) {
        p2pLog(`distributed: peer ${peerIndex + 1}/${peerCount}`, 'p2p-info');
    }

    // Include blocks that are already in the CRDT (from us or peers) so the
    // worker skips them — this is key for restart after peer disconnect
    const cachedBlockDates = getCachedBlockKeys();

    detectWorker = new Worker('detect-worker.js');

    detectWorker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'progress') {
            bar.style.width = msg.pct + '%';
            text.textContent = msg.stage;
        } else if (msg.type === 'blockDetections') {
            cacheBlockResult(msg.blockId, msg.date, msg.detections);
        } else if (msg.type === 'cachedBlock') {
            // Already in CRDT — nothing to do
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
        bbox: job.bbox,
        epsg: job.epsg,
        startDate: job.startDate,
        endDate: job.endDate,
        cachedBlockDates,
        peerIndex,
        peerCount
    });
}

function cleanupDetection() {
    clearDetectingState();
    _currentJob = null;
    _currentPeerCount = 0;
    if (_peerChangeHandler) {
        provider.awareness.off('change', _peerChangeHandler);
        _peerChangeHandler = null;
    }
}

async function startDetection() {
    if (map.getZoom() < MIN_DETECT_ZOOM) {
        alert('Zoom in to at least level 11 before running detection.');
        return;
    }

    if (detectWorker) { detectWorker.terminate(); detectWorker = null; }
    _isDetecting = true;
    _preSessionKeys = new Set(processedMap.keys());

    // Keep existing detections — new results accumulate
    ensureDetectionLayer();

    const btn = document.getElementById('detect-btn');
    const prog = document.getElementById('detect-progress');
    const bar = document.getElementById('detect-bar');
    const text = document.getElementById('detect-text');

    btn.classList.add('hidden');
    prog.classList.remove('hidden');
    bar.style.width = '0%';
    text.textContent = 'Searching...';

    const bbox = getViewportBbox();
    const epsg = guessEpsg(bbox);
    const dateRange = getSelectedDateRange();

    // Build a job descriptor shared with all peers so they can help
    const job = {
        id: `${provider.awareness.clientID}-${Date.now()}`,
        bbox, epsg,
        startDate: dateRange?.startDate,
        endDate: dateRange?.endDate
    };
    _currentJob = job;

    // Broadcast job via awareness — all idle peers auto-join
    setDetectingState(job);

    // Brief delay to let awareness propagate so helpers can join
    await new Promise(r => setTimeout(r, 200));

    // Monitor peer changes — if a helper disconnects, restart with updated
    // partition so orphaned blocks get picked up.  Already-processed blocks
    // are in the CRDT and will be skipped via the cache.
    _peerChangeHandler = () => {
        if (!_currentJob) return;
        const { peerCount } = getPeerPartition(_currentJob.id);
        if (peerCount !== _currentPeerCount) {
            p2pLog(`peers changed ${_currentPeerCount}→${peerCount}, restarting`, 'p2p-info');
            // Flush any pending results before restart
            clearTimeout(_flushTimer);
            _flushTimer = null;
            flushPendingBlocks();
            launchDetectWorker(_currentJob, bar, text);
        }
    };
    provider.awareness.on('change', _peerChangeHandler);

    launchDetectWorker(job, bar, text);
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
    // Flush any remaining batched block results before final clustering
    clearTimeout(_flushTimer);
    _flushTimer = null;
    flushPendingBlocks();

    // Rebuild from CRDT after flush, then cluster once
    rebuildDetections();
    const features = crossDateCluster(allRawDetections);
    const src = map.getSource('client-detections');
    if (src) src.setData({ type: 'FeatureCollection', features });

    // Count only clusters from this session's new detections
    const sessionDetections = _preSessionKeys
        ? allRawDetections.filter(d => !_preSessionKeys.has(`${d.block_id}:${d.date}`))
        : allRawDetections;
    const sessionClusters = crossDateCluster(sessionDetections);

    _isDetecting = false;
    _preSessionKeys = null;

    // Mark selected quarters as detected for this viewport
    const activeBtns = document.querySelectorAll('.quarter-btn.active');
    const quarters = Array.from(activeBtns).map(btn => ({
        year: parseInt(btn.dataset.year),
        quarter: parseInt(btn.dataset.quarter)
    }));
    markQuartersDetected(quarters);
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
function updateMapCentre() {
    const c = map.getCenter();
    document.getElementById('map-centre').textContent =
        `LOC: ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
}

map.on('move', updateMapCentre);

let _quarterIndicatorTimeout;
map.on('moveend', () => {
    clearTimeout(_quarterIndicatorTimeout);
    _quarterIndicatorTimeout = setTimeout(updateQuarterIndicators, 300);
});

map.on('load', () => {
    updateMapCentre();

    // Detections are restored from Yjs IndexedDB + peers via the observer.
    // Trigger an update in case persistence synced before the map loaded.
    scheduleDetectionUpdate();

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
