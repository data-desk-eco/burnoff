// local-detect + P2P subsystem: the LWW-Map CRDT document, WebRTC mesh, IndexedDB
// persistence, the detect Web Worker (s2-flares wasm core) with distributed help
// from idle peers, and the cross-date clusterer over the CRDT maps. the CRDT stack
// (crdt/sync/rtc/store) is imported lazily by ensureDetect() — only outside the
// archive's coverage, where the Detect button + mesh come into play — so a
// pure-archive session never fetches it.

import { clusterDetections } from './s2/cluster.js';
import { findNearestTerminal } from './clustering.js';
import { viewportBbox } from './vendor/cartograph/shell.js';

let LWWMap, Store, PeerMesh, geohash3, SyncManager, validateDetection;   // lazy imports

export const MIN_DETECT_ZOOM = 11;    // local-worker COG detect (heavy) + its controls
const AWARENESS_HEARTBEAT_MS = 15_000;
const MERGE_DISTANCE_M = 135;         // the bulk pipeline's cluster default (s2-flares ClusterOptions)
const BLOCK_DEG = 0.046;              // block grid: 256px at 20m = ~5120m ≈ 0.046° lat

const _sigMeta = document.querySelector('meta[name="signaling-url"]');
const SIGNALING_URL = _sigMeta
    ? _sigMeta.content
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:4444`;

// injected by initDetect: the map, the cartograph quarter-picker api, a render
// callback (re-cluster + redraw in the active mode), a quarter-indicator
// refresh, and the live avg-B12 slider gate.
let map, quarters, render, updateQuarters, minAvgB12;

let detectionMap = null, processedMap = null, store = null, mesh = null, syncManager = null;
let allRawDetections = [];
let _detectReady = null;              // promise once ensureDetect() has fired
let detectWorker = null;
let _isDetecting = false;
let _preSessionKeys = null;
let _currentJob = null;
let _currentPeerCount = 0;

export const isDetecting = () => _isDetecting;

export function initDetect(deps) {
    ({ map, quarters, render, updateQuarters, minAvgB12 } = deps);
    document.getElementById('detect-btn').addEventListener('click', startDetection);
}

// ---------------------------------------------------------------------------
// CRDT document (lazy)
// ---------------------------------------------------------------------------

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
// the viewport sits outside the archive's coverage or the user hits Detect — and
// eagerly in pure-detect builds (no <meta s2-archive>). Idempotent.
export function ensureDetect() {
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
            signalingUrl: SIGNALING_URL, room: 'burnoff',
            onPeerConnect: () => {}, onPeerDisconnect: () => {}, onMessage: () => {},
            maxPeers: 8, getGeoSummary: computeGeoSummary
        });
        syncManager = new SyncManager({ detectionMap, processedMap, store, mesh });

        // Re-render on CRDT change; sanitize remote entries.
        detectionMap.onChange = (key, value, source) => {
            if (source === 'remote') {
                const clean = sanitizeDetections(value);
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
        const now = new Date();
        const curQKey = `${now.getFullYear()}_${Math.floor(now.getMonth() / 3) + 1}`;
        const staleQtrKeys = [];
        processedMap.forEach((_v, key) => {
            if (key.startsWith(`__qtr:${curQKey}:`)) staleQtrKeys.push(key);
        });
        for (const key of staleQtrKeys) {
            processedMap.delete(key);
            store.delete('proc', key);
        }

        scheduleDetectionUpdate();
        updatePeerStatus();
        updateQuarters();
        mesh.connect();
    })();
    return _detectReady;
}

function getActiveStates() {
    return syncManager ? syncManager.getActiveStates() : new Map();
}

function sanitizeDetections(dets) {
    if (!Array.isArray(dets)) return null;
    if (dets.length > 500) return null;
    const valid = dets.filter(validateDetection);
    return valid.length > 0 ? valid : null;
}

function updatePeerStatus() {
    const el = document.getElementById('peer-count');
    if (el) el.textContent = Math.max(0, getActiveStates().size - 1);
}

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
        if (dets && dets.length > 0) allRawDetections = allRawDetections.concat(dets);
    });
}

// Debounced re-cluster + redraw after CRDT changes
let _syncUpdateTimer;
function scheduleDetectionUpdate() {
    clearTimeout(_syncUpdateTimer);
    _syncUpdateTimer = setTimeout(() => { rebuildDetections(); render(); }, 50);
}

/** Redraw the detection source from the CRDT-held detections. */
export function updateDetectionSource() {
    const src = map.getSource('detections');
    if (!src) return;
    src.setData({ type: 'FeatureCollection', features: crossDateCluster(allRawDetections) });
    map.triggerRepaint();
}

// ---------------------------------------------------------------------------
// Cross-date clustering (main thread, for live updates as results stream in)
// ---------------------------------------------------------------------------

// `obs` (optional) overrides the persistence source: an array of
// {block_id, date, cloudFree} records (the S2-archive path). When omitted, the
// per-block/per-date observation budget is derived from processedMap.
export function crossDateCluster(allDetections, obs) {
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
    // active quality gate. The vision-validated score is computed for display only
    // — not gated — until we commit to syncing the B12/B11 ratio (a binary-format
    // change, deferred). `observations` gives the cloud-free denominator for both
    // the persistence metric and persistence_score.
    const clusters = clusterDetections(allDetections, {
        mergeDistance: MERGE_DISTANCE_M,
        minDates: 4,
        minAvgB12: minAvgB12(),
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
        const bids = new Set();
        for (const d of cl.detections) {
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
        for (const d of cl.detections) { passDates.add(d.date); obsDates.add(d.date); }
        const passes = passDates.size;
        const observations = obsDates.size;
        const persistence = observations > 0 ? cl.detections.length / observations : null;

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
                lat: cl.lat, lon: cl.lon,   // exact coords for detail/highlight
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
// Detected-quarter tracking
// ---------------------------------------------------------------------------

/** Quarters ("year_quarter") the current viewport has already been detected for. */
export function getDetectedQuarters() {
    if (!processedMap) return new Set();
    const [vw, vs, ve, vn] = viewportBbox(map);
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

export function updateDetectButton(detected = getDetectedQuarters()) {
    const active = quarters.keys();
    const allDetected = active.size > 0 && [...active].every(k => detected.has(k));
    const tooZoomedOut = map.getZoom() < MIN_DETECT_ZOOM;
    const btn = document.getElementById('detect-btn');
    btn.disabled = allDetected || tooZoomedOut;
    btn.title = tooZoomedOut ? 'Zoom in to at least level 11' : '';
}

// ---------------------------------------------------------------------------
// Detect workers (requester + helper) and distributed-detection awareness
// ---------------------------------------------------------------------------

// One message pump for both the requester's worker and a helper's: ready
// handshake, block-result caching (the single write path for local + peer help),
// and progress/done/error handlers.
function spawnWorker(job, peerIndex, peerCount, handlers = {}) {
    const w = new Worker('detect-worker.js', { type: 'module' });
    w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') w.postMessage({
            bbox: job.bbox, epsg: job.epsg, startDate: job.startDate, endDate: job.endDate,
            cachedBlockDates: getCachedBlockKeys(), peerIndex, peerCount });
        else if (m.type === 'blockDetections') cacheBlockResult(
            m.blockId, m.date, m.detections, m.lat, m.lng,
            m.skipped ? 'skipped' : m.cloudFree !== undefined ? m.cloudFree : true);
        else if (m.type === 'progress') handlers.progress?.(m);
        else if (m.type === 'done') handlers.done?.(m);
        else if (m.type === 'error') handlers.error?.(m);
    };
    w.onerror = err => handlers.error?.(err);
    return w;
}

function setDetectingState(job) {
    const prev = getActiveStates().get(mesh.localPeerId) || {};
    syncManager.setLocalAwareness({ ...prev, detecting: true, job, t: Date.now() });
}

function clearDetectingState() {
    const prev = { ...(getActiveStates().get(mesh.localPeerId) || {}) };
    delete prev.detecting;
    delete prev.job;
    syncManager.setLocalAwareness({ ...prev, t: Date.now() });
}

function getPeerPartition(jobId) {
    const states = getActiveStates();
    const ids = [];
    states.forEach((state, id) => {
        if (state.detecting && state.job && state.job.id !== jobId) return;
        ids.push(id);
    });
    ids.sort((a, b) => a - b);
    const peerIndex = ids.indexOf(mesh.localPeerId);
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
    _helpWorker = spawnWorker(job, peerIndex, peerCount, { done: stopHelping, error: stopHelping });
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

// ---------------------------------------------------------------------------
// Detection sessions (the Detect button)
// ---------------------------------------------------------------------------

function guessEpsg(bbox) {
    const lon = (bbox[0] + bbox[2]) / 2;
    const lat = (bbox[1] + bbox[3]) / 2;
    const zone = Math.floor((lon + 180) / 6) + 1;
    return lat >= 0 ? 32600 + zone : 32700 + zone;
}

function launchDetectWorker(job) {
    if (detectWorker) { detectWorker.terminate(); detectWorker = null; }

    const { peerIndex, peerCount } = getPeerPartition(job.id);
    _currentPeerCount = peerCount;

    const bar = document.getElementById('detect-bar');
    const text = document.getElementById('detect-text');
    const fail = message => {
        cleanupDetection();
        _isDetecting = false;
        _preSessionKeys = null;
        bar.style.width = '100%';
        bar.style.background = '#F52E2E';
        text.textContent = message;
        setTimeout(resetDetectUI, 3000);
    };

    detectWorker = spawnWorker(job, peerIndex, peerCount, {
        progress: m => { bar.style.width = m.pct + '%'; text.textContent = m.stage; },
        done: m => {
            const j = _currentJob;
            cleanupDetection();
            finishDetection(m.stats, j);
        },
        error: m => {
            console.error('Detect worker error:', m);
            fail('Error: ' + (m.message || 'worker failed'));
        },
    });
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
    render();

    document.getElementById('detect-btn').classList.add('hidden');
    document.getElementById('detect-progress').classList.remove('hidden');
    document.getElementById('detect-bar').style.width = '0%';
    document.getElementById('detect-text').textContent = 'Searching...';

    const bbox = viewportBbox(map);
    const dateRange = quarters.range();
    const job = {
        id: `${mesh.localPeerId}-${Date.now()}`,
        bbox, epsg: guessEpsg(bbox),
        startDate: dateRange?.startDate,
        endDate: dateRange?.endDate
    };
    _currentJob = job;

    setDetectingState(job);
    await new Promise(r => setTimeout(r, 200));   // let awareness propagate
    launchDetectWorker(job);
}

function resetDetectUI() {
    document.getElementById('detect-btn').classList.remove('hidden');
    document.getElementById('detect-progress').classList.add('hidden');
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
    updateDetectionSource();

    const sessionDetections = _preSessionKeys
        ? allRawDetections.filter(d => !_preSessionKeys.has(`${d.block_id}:${d.date}`))
        : allRawDetections;
    const sessionClusters = crossDateCluster(sessionDetections);

    _isDetecting = false;
    _preSessionKeys = null;

    writeQuarterCompletionMarkers(job);
    updateQuarters();

    document.getElementById('detect-bar').style.width = '100%';
    document.getElementById('detect-bar').style.background = '#808080';
    document.getElementById('detect-text').textContent = sessionClusters.length === 0
        ? (stats ? `No flares found · ${stats.images} images` : 'No flares found')
        : `${sessionClusters.length} flare${sessionClusters.length !== 1 ? 's' : ''} · ${stats?.images || '?'} images`;
    setTimeout(resetDetectUI, 3000);
}
