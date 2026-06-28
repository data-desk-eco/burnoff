// ---------------------------------------------------------------------------
// Sync Protocol + Awareness
// ---------------------------------------------------------------------------

import {
    encodeStateVector, decodeStateVector,
    encodeEntries, decodeEntries
} from './crdt.js';

// Message tags
const MSG_STATE_VECTOR = 0x01;
const MSG_STATE_DIFF   = 0x02;
const MSG_LIVE_UPDATE  = 0x03;
const MSG_AWARENESS    = 0x04;
const MSG_PING         = 0x05;
const MSG_PONG         = 0x06;

const LIVE_BATCH_INTERVAL = 200;
const AWARENESS_HEARTBEAT = 15000;
const AWARENESS_STALE = 45000;
const PING_INTERVAL = 30000;
const PING_TIMEOUT = 10000;

// COG URL allowlist for validation
const COG_URL_ALLOWLIST = [
    'https://earth-search.aws.element84.com/',
    'https://sentinel-cogs.s3.us-west-2.amazonaws.com/',
    'https://sentinel-cogs.s3.amazonaws.com/',
];

function isAllowedCogUrl(url) {
    if (!url) return true;
    if (typeof url !== 'string') return false;
    return COG_URL_ALLOWLIST.some(prefix => url.startsWith(prefix));
}

function validateDetection(d) {
    if (!d || typeof d !== 'object') return false;
    if (typeof d.flare_lat !== 'number' || !Number.isFinite(d.flare_lat)) return false;
    if (typeof d.flare_lon !== 'number' || !Number.isFinite(d.flare_lon)) return false;
    if (d.flare_lat < -90 || d.flare_lat > 90) return false;
    if (d.flare_lon < -180 || d.flare_lon > 180) return false;
    if (typeof d.max_b12 !== 'number' || !Number.isFinite(d.max_b12)) return false;
    if (d.max_b12 < 0 || d.max_b12 > 10) return false;
    if (typeof d.pixels !== 'number' || d.pixels < 1 || d.pixels > 10000) return false;
    if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d.date)) return false;
    if (!isAllowedCogUrl(d.cog_b12)) return false;
    return true;
}

export { validateDetection, isAllowedCogUrl };

export class SyncManager {
    constructor({ detectionMap, processedMap, store, mesh }) {
        this._detMap = detectionMap;
        this._procMap = processedMap;
        this._store = store;
        this._mesh = mesh;

        // Live update batching
        this._pendingKeys = []; // { mapName, key }
        this._batchTimer = null;

        // Awareness
        this._localAwareness = null;
        this._remoteAwareness = new Map(); // peerId -> { state, ts }
        this._awarenessCallbacks = [];
        this._awarenessInterval = null;

        // Ping/pong
        this._pingIntervals = new Map(); // peerId -> intervalId
        this._pingTimers = new Map();    // peerId -> timeoutId

        // Wire up mesh callbacks
        mesh._onPeerConnect = (peerId) => this.handlePeerConnect(peerId);
        mesh._onPeerDisconnect = (peerId) => this._handlePeerDisconnect(peerId);
        mesh._onMessage = (peerId, data) => this.handleMessage(peerId, data);

        // Start awareness heartbeat
        this._awarenessInterval = setInterval(() => {
            if (this._localAwareness) {
                this._broadcastAwareness();
            }
            // Prune stale remote awareness
            const now = Date.now();
            let changed = false;
            this._remoteAwareness.forEach((entry, peerId) => {
                if (now - entry.ts > AWARENESS_STALE) {
                    this._remoteAwareness.delete(peerId);
                    changed = true;
                }
            });
            if (changed) this._fireAwarenessChange();
        }, AWARENESS_HEARTBEAT);
    }

    // -----------------------------------------------------------------------
    // Peer connect / disconnect
    // -----------------------------------------------------------------------

    handlePeerConnect(peerId) {
        // Send our state vector
        const sv = encodeStateVector(this._detMap, this._procMap);
        const msg = new Uint8Array(1 + sv.length);
        msg[0] = MSG_STATE_VECTOR;
        msg.set(sv, 1);
        this._mesh.send(peerId, msg.buffer);

        // Send awareness
        if (this._localAwareness) {
            this._sendAwareness(peerId);
        }

        // Start ping
        this._startPing(peerId);

        this._fireAwarenessChange();
    }

    _handlePeerDisconnect(peerId) {
        this._remoteAwareness.delete(peerId);
        this._stopPing(peerId);
        this._fireAwarenessChange();
    }

    // -----------------------------------------------------------------------
    // Message dispatch
    // -----------------------------------------------------------------------

    handleMessage(peerId, data) {
        const buf = new Uint8Array(data);
        if (buf.length === 0) return;
        const tag = buf[0];
        const payload = buf.subarray(1);

        switch (tag) {
            case MSG_STATE_VECTOR:
                this._handleStateVector(peerId, payload);
                break;
            case MSG_STATE_DIFF:
            case MSG_LIVE_UPDATE:
                this._handleDiff(payload);
                break;
            case MSG_AWARENESS:
                this._handleAwareness(peerId, payload);
                break;
            case MSG_PING:
                this._sendPong(peerId);
                break;
            case MSG_PONG:
                this._handlePong(peerId);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // State vector sync
    // -----------------------------------------------------------------------

    _handleStateVector(peerId, payload) {
        const remote = decodeStateVector(payload);

        // Compute what we have that the remote doesn't
        const toSend = [];

        this._detMap._entries.forEach((entry, key) => {
            const r = remote.det.get(key);
            if (!r || entry.ts / 1000 > r.ts || (Math.floor(entry.ts / 1000) === r.ts && entry.peerId > r.peerId)) {
                toSend.push({ mapName: 'det', key });
            }
        });

        this._procMap._entries.forEach((entry, key) => {
            const r = remote.proc.get(key);
            if (!r || entry.ts / 1000 > r.ts || (Math.floor(entry.ts / 1000) === r.ts && entry.peerId > r.peerId)) {
                toSend.push({ mapName: 'proc', key });
            }
        });

        if (toSend.length === 0) return;

        // Send in chunks
        for (let i = 0; i < toSend.length; i += 500) {
            const chunk = toSend.slice(i, i + 500);
            const encoded = encodeEntries(chunk, this._detMap, this._procMap);
            const msg = new Uint8Array(1 + encoded.length);
            msg[0] = MSG_STATE_DIFF;
            msg.set(encoded, 1);
            this._mesh.send(peerId, msg.buffer);
        }
    }

    _handleDiff(payload) {
        const entries = decodeEntries(payload);
        for (const { mapName, key, value, ts, peerId } of entries) {
            // Validate detections
            if (mapName === 'det' && Array.isArray(value)) {
                const valid = value.filter(validateDetection);
                if (valid.length === 0) continue;
                if (this._detMap.merge(key, valid, ts, peerId)) {
                    this._store.put('det', key, valid, ts, peerId);
                }
            } else if (mapName === 'proc') {
                if (this._procMap.merge(key, value, ts, peerId)) {
                    this._store.put('proc', key, value, ts, peerId);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Local writes → broadcast
    // -----------------------------------------------------------------------

    onLocalWrite(mapName, key) {
        this._pendingKeys.push({ mapName, key });
        if (!this._batchTimer) {
            this._batchTimer = setTimeout(() => {
                this._batchTimer = null;
                this._flushLiveUpdates();
            }, LIVE_BATCH_INTERVAL);
        }
    }

    _flushLiveUpdates() {
        if (this._pendingKeys.length === 0) return;
        const keys = this._pendingKeys.splice(0);

        const encoded = encodeEntries(keys, this._detMap, this._procMap);
        const msg = new Uint8Array(1 + encoded.length);
        msg[0] = MSG_LIVE_UPDATE;
        msg.set(encoded, 1);
        this._mesh.broadcast(msg.buffer);
    }

    // -----------------------------------------------------------------------
    // Awareness
    // -----------------------------------------------------------------------

    setLocalAwareness(state) {
        this._localAwareness = state;
        this._broadcastAwareness();
        this._fireAwarenessChange();
    }

    getActiveStates() {
        const now = Date.now();
        const states = new Map();

        // Add self
        if (this._localAwareness) {
            states.set(this._mesh.localPeerId, this._localAwareness);
        }

        // Add non-stale remotes
        this._remoteAwareness.forEach((entry, peerId) => {
            if (now - entry.ts <= AWARENESS_STALE) {
                states.set(peerId, entry.state);
            }
        });

        return states;
    }

    onAwarenessChange(cb) {
        this._awarenessCallbacks.push(cb);
    }

    _fireAwarenessChange() {
        for (const cb of this._awarenessCallbacks) {
            try { cb(); } catch (e) { /* ignore */ }
        }
    }

    _broadcastAwareness() {
        const state = this._localAwareness;
        if (!state) return;

        const json = JSON.stringify(state);
        const encoder = new TextEncoder();
        const encoded = encoder.encode(json);

        // [u16 peerId][u32 ts][payload...]
        const buf = new Uint8Array(6 + encoded.length);
        const view = new DataView(buf.buffer);
        view.setUint16(0, this._mesh.localPeerId, true);
        view.setUint32(2, (Date.now() / 1000) >>> 0, true);
        buf.set(encoded, 6);

        const msg = new Uint8Array(1 + buf.length);
        msg[0] = MSG_AWARENESS;
        msg.set(buf, 1);
        this._mesh.broadcast(msg.buffer);
    }

    _sendAwareness(peerId) {
        const state = this._localAwareness;
        if (!state) return;

        const json = JSON.stringify(state);
        const encoder = new TextEncoder();
        const encoded = encoder.encode(json);

        const buf = new Uint8Array(6 + encoded.length);
        const view = new DataView(buf.buffer);
        view.setUint16(0, this._mesh.localPeerId, true);
        view.setUint32(2, (Date.now() / 1000) >>> 0, true);
        buf.set(encoded, 6);

        const msg = new Uint8Array(1 + buf.length);
        msg[0] = MSG_AWARENESS;
        msg.set(buf, 1);
        this._mesh.send(peerId, msg.buffer);
    }

    _handleAwareness(fromPeerId, payload) {
        if (payload.length < 6) return;
        const view = new DataView(payload.buffer, payload.byteOffset);
        const peerId = view.getUint16(0, true);

        // Only accept awareness from the peer who sent it
        if (peerId !== fromPeerId) return;

        const decoder = new TextDecoder();
        const json = decoder.decode(payload.subarray(6));
        let state;
        try { state = JSON.parse(json); } catch { return; }

        this._remoteAwareness.set(peerId, { state, ts: Date.now() });
        this._fireAwarenessChange();
    }

    // -----------------------------------------------------------------------
    // Ping / Pong
    // -----------------------------------------------------------------------

    _startPing(peerId) {
        this._stopPing(peerId);
        const interval = setInterval(() => {
            this._mesh.send(peerId, new Uint8Array([MSG_PING]).buffer);
            const timeout = setTimeout(() => {
                // Peer didn't respond — consider disconnected
                this._mesh._closePeer(peerId);
            }, PING_TIMEOUT);
            this._pingTimers.set(peerId, timeout);
        }, PING_INTERVAL);
        this._pingIntervals.set(peerId, interval);
    }

    _stopPing(peerId) {
        const interval = this._pingIntervals.get(peerId);
        if (interval) { clearInterval(interval); this._pingIntervals.delete(peerId); }
        const timeout = this._pingTimers.get(peerId);
        if (timeout) { clearTimeout(timeout); this._pingTimers.delete(peerId); }
    }

    _sendPong(peerId) {
        this._mesh.send(peerId, new Uint8Array([MSG_PONG]).buffer);
    }

    _handlePong(peerId) {
        const timeout = this._pingTimers.get(peerId);
        if (timeout) { clearTimeout(timeout); this._pingTimers.delete(peerId); }
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    destroy() {
        if (this._awarenessInterval) clearInterval(this._awarenessInterval);
        // Flush any batched live updates before tearing the timer down so a
        // teardown mid-batch doesn't silently drop them.
        if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; this._flushLiveUpdates(); }
        this._pingIntervals.forEach(id => clearInterval(id));
        this._pingTimers.forEach(id => clearTimeout(id));
    }
}
