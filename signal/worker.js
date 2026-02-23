// Cloudflare Worker + Durable Object signaling relay.
// Replaces the Node.js WebSocket server with zero infrastructure.
//
// Deploy: npx wrangler deploy
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

// Durable Object with WebSocket Hibernation API.
// Subscriptions stored via serializeAttachment/deserializeAttachment
// so they survive hibernation.
export class SignalingDO {
    constructor(ctx, env) {
        this.ctx = ctx;
        // Rebuild subscription map from hibernating WebSockets
        this.sessions = new Map();
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att) this.sessions.set(ws, att);
        }
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 400 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        const att = { topics: [] };
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(att);
        this.sessions.set(server, att);

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        let msg;
        try { msg = JSON.parse(message); } catch { return; }

        if (msg.type === 'subscribe') {
            const att = ws.deserializeAttachment() || { topics: [] };
            const set = new Set(att.topics);
            for (const t of (msg.topics || [])) set.add(t);
            att.topics = [...set];
            ws.serializeAttachment(att);
            this.sessions.set(ws, att);
        }

        if (msg.type === 'unsubscribe') {
            const att = ws.deserializeAttachment() || { topics: [] };
            const remove = new Set(msg.topics || []);
            att.topics = att.topics.filter(t => !remove.has(t));
            ws.serializeAttachment(att);
            this.sessions.set(ws, att);
        }

        if (msg.type === 'publish' && msg.topic) {
            const data = JSON.stringify(msg);
            for (const [peer, att] of this.sessions) {
                if (peer === ws) continue;
                if (att.topics.includes(msg.topic)) {
                    try { peer.send(data); } catch { /* closed */ }
                }
            }
        }

        if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* closed */ }
        }
    }

    async webSocketClose(ws) {
        this.sessions.delete(ws);
        ws.close();
    }

    async webSocketError(ws) {
        this.sessions.delete(ws);
        ws.close();
    }
}
