// ---------------------------------------------------------------------------
// PeerMesh — WebRTC DataChannel mesh via signaling relay
// ---------------------------------------------------------------------------

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

export class PeerMesh {
    constructor({ signalingUrl, room, onPeerConnect, onPeerDisconnect, onMessage }) {
        this.signalingUrl = signalingUrl;
        this.room = room;
        this._onPeerConnect = onPeerConnect || (() => {});
        this._onPeerDisconnect = onPeerDisconnect || (() => {});
        this._onMessage = onMessage || (() => {});

        this.localPeerId = (Math.random() * 0xFFFF) >>> 0;
        this._peers = new Map(); // peerId -> { pc, dc, state }
        this._ws = null;
        this._reconnectDelay = RECONNECT_MIN;
        this._closed = false;
    }

    get connectedPeerIds() {
        const ids = [];
        this._peers.forEach((peer, id) => {
            if (peer.dc && peer.dc.readyState === 'open') ids.push(id);
        });
        return ids;
    }

    get peerCount() {
        return this.connectedPeerIds.length;
    }

    connect() {
        this._closed = false;
        this._connectWs();
    }

    disconnect() {
        this._closed = true;
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._peers.forEach((peer, id) => this._closePeer(id));
        this._peers.clear();
    }

    broadcast(data) {
        this._peers.forEach((peer) => {
            if (peer.dc && peer.dc.readyState === 'open') {
                try { peer.dc.send(data); } catch (e) { /* ignore */ }
            }
        });
    }

    send(peerId, data) {
        const peer = this._peers.get(peerId);
        if (peer?.dc?.readyState === 'open') {
            try { peer.dc.send(data); } catch (e) { /* ignore */ }
        }
    }

    // -----------------------------------------------------------------------
    // WebSocket signaling
    // -----------------------------------------------------------------------

    _connectWs() {
        if (this._closed || this._ws) return;

        const ws = new WebSocket(this.signalingUrl);
        this._ws = ws;

        ws.onopen = () => {
            this._reconnectDelay = RECONNECT_MIN;
            ws.send(JSON.stringify({ type: 'subscribe', topics: [this.room] }));
            // Announce ourselves
            this._publish({ kind: 'join', from: this.localPeerId });
        };

        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.type !== 'publish' || msg.topic !== this.room) return;

            // Filter out our own messages
            if (msg.from === this.localPeerId) return;

            this._handleSignal(msg);
        };

        ws.onclose = () => {
            this._ws = null;
            if (!this._closed) {
                setTimeout(() => this._connectWs(), this._reconnectDelay);
                this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX);
            }
        };

        ws.onerror = () => ws.close();
    }

    _publish(payload) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify({
                type: 'publish',
                topic: this.room,
                ...payload
            }));
        }
    }

    // -----------------------------------------------------------------------
    // Signaling message handler
    // -----------------------------------------------------------------------

    _handleSignal(msg) {
        if (msg.kind === 'join') {
            const remotePeerId = msg.from;
            if (remotePeerId === this.localPeerId) return;

            // Respond so the joiner knows about us
            this._publish({ kind: 'join-ack', from: this.localPeerId, to: remotePeerId });

            // Higher peerId creates offer (deterministic, avoids duplicate connections)
            if (this.localPeerId > remotePeerId && !this._peers.has(remotePeerId)) {
                this._createConnection(remotePeerId, true);
            }
        } else if (msg.kind === 'join-ack') {
            if (msg.to !== this.localPeerId) return;
            const remotePeerId = msg.from;
            if (this.localPeerId > remotePeerId && !this._peers.has(remotePeerId)) {
                this._createConnection(remotePeerId, true);
            }
        } else if (msg.kind === 'offer') {
            if (msg.to !== this.localPeerId) return;
            this._handleOffer(msg.from, msg.sdp);
        } else if (msg.kind === 'answer') {
            if (msg.to !== this.localPeerId) return;
            this._handleAnswer(msg.from, msg.sdp);
        } else if (msg.kind === 'ice') {
            if (msg.to !== this.localPeerId) return;
            this._handleIce(msg.from, msg.candidate);
        }
    }

    // -----------------------------------------------------------------------
    // RTCPeerConnection lifecycle
    // -----------------------------------------------------------------------

    _createConnection(remotePeerId, isOfferer) {
        if (this._peers.has(remotePeerId)) return;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const peer = { pc, dc: null, state: 'connecting' };
        this._peers.set(remotePeerId, peer);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._publish({
                    kind: 'ice',
                    from: this.localPeerId,
                    to: remotePeerId,
                    candidate: e.candidate.toJSON()
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this._closePeer(remotePeerId);
            }
        };

        if (isOfferer) {
            const dc = pc.createDataChannel('sync', { ordered: true });
            peer.dc = dc;
            this._setupDataChannel(dc, remotePeerId);

            pc.createOffer().then(offer => {
                return pc.setLocalDescription(offer);
            }).then(() => {
                this._publish({
                    kind: 'offer',
                    from: this.localPeerId,
                    to: remotePeerId,
                    sdp: pc.localDescription.toJSON()
                });
            }).catch(() => this._closePeer(remotePeerId));
        } else {
            pc.ondatachannel = (e) => {
                peer.dc = e.channel;
                this._setupDataChannel(e.channel, remotePeerId);
            };
        }
    }

    _setupDataChannel(dc, remotePeerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            const peer = this._peers.get(remotePeerId);
            if (peer) peer.state = 'connected';
            this._onPeerConnect(remotePeerId);
        };

        dc.onclose = () => {
            this._closePeer(remotePeerId);
        };

        dc.onmessage = (e) => {
            this._onMessage(remotePeerId, e.data);
        };
    }

    async _handleOffer(remotePeerId, sdp) {
        // Close existing connection if any
        if (this._peers.has(remotePeerId)) {
            this._closePeer(remotePeerId);
        }

        this._createConnection(remotePeerId, false);
        const peer = this._peers.get(remotePeerId);
        if (!peer) return;

        try {
            await peer.pc.setRemoteDescription(sdp);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            this._publish({
                kind: 'answer',
                from: this.localPeerId,
                to: remotePeerId,
                sdp: peer.pc.localDescription.toJSON()
            });
        } catch (e) {
            this._closePeer(remotePeerId);
        }
    }

    async _handleAnswer(remotePeerId, sdp) {
        const peer = this._peers.get(remotePeerId);
        if (!peer) return;
        try {
            await peer.pc.setRemoteDescription(sdp);
        } catch (e) {
            this._closePeer(remotePeerId);
        }
    }

    async _handleIce(remotePeerId, candidate) {
        const peer = this._peers.get(remotePeerId);
        if (!peer) return;
        try {
            await peer.pc.addIceCandidate(candidate);
        } catch (e) { /* ignore */ }
    }

    _closePeer(remotePeerId) {
        const peer = this._peers.get(remotePeerId);
        if (!peer) return;
        try { peer.dc?.close(); } catch (e) { /* ignore */ }
        try { peer.pc?.close(); } catch (e) { /* ignore */ }
        this._peers.delete(remotePeerId);
        this._onPeerDisconnect(remotePeerId);
    }
}
