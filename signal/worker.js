// Cloudflare Worker + Durable Object signaling relay.
// Replaces the Node.js WebSocket server with zero infrastructure.
//
// Deploy: npx wrangler deploy signal/worker.js
// Config: wrangler.toml at repo root

export default {
    async fetch(request, env) {
        // WebSocket upgrade — all connections go to a single Durable Object
        if (request.headers.get('Upgrade') === 'websocket') {
            const id = env.SIGNALING.idFromName('global');
            const stub = env.SIGNALING.get(id);
            return stub.fetch(request);
        }

        // Health check
        return new Response('signaling ok', {
            headers: { 'Access-Control-Allow-Origin': '*' },
        });
    },
};

// Durable Object with WebSocket Hibernation API
export class SignalingDO {
    constructor(state) {
        this.state = state;
        // topic -> Set<WebSocket>
        this.topics = new Map();
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 400 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Attach empty subscription state
        this.state.acceptWebSocket(server, []);

        return new Response(null, { status: 101, webSocket: client });
    }

    // Called when a hibernated WebSocket receives a message
    async webSocketMessage(ws, message) {
        let msg;
        try { msg = JSON.parse(message); } catch { return; }

        if (msg.type === 'subscribe') {
            for (const topic of (msg.topics || [])) {
                if (!this.topics.has(topic)) this.topics.set(topic, new Set());
                this.topics.get(topic).add(ws);
            }
        }

        if (msg.type === 'unsubscribe') {
            for (const topic of (msg.topics || [])) {
                const subs = this.topics.get(topic);
                if (subs) {
                    subs.delete(ws);
                    if (subs.size === 0) this.topics.delete(topic);
                }
            }
        }

        if (msg.type === 'publish' && msg.topic) {
            const subs = this.topics.get(msg.topic);
            if (subs) {
                const data = JSON.stringify(msg);
                for (const peer of subs) {
                    if (peer !== ws) {
                        try { peer.send(data); } catch { /* closed */ }
                    }
                }
            }
        }

        if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* closed */ }
        }
    }

    // Called when a WebSocket is closed (including during hibernation)
    async webSocketClose(ws) {
        this._removeFromTopics(ws);
    }

    async webSocketError(ws) {
        this._removeFromTopics(ws);
    }

    _removeFromTopics(ws) {
        for (const [topic, subs] of this.topics) {
            subs.delete(ws);
            if (subs.size === 0) this.topics.delete(topic);
        }
    }
}
