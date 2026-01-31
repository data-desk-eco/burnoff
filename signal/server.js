#!/usr/bin/env node

// Minimal y-webrtc signaling server — relays WebSocket messages between peers
// in named rooms. No state is stored; peers handle sync via Yjs CRDT.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 4444;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
    });
    res.end('signaling ok');
});

const wss = new WebSocket.Server({ noServer: true });

// topic → Set<WebSocket>
const topics = new Map();

wss.on('connection', (conn) => {
    const subscribed = new Set();
    let alive = true;

    conn.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'subscribe') {
            for (const topic of (msg.topics || [])) {
                if (subscribed.has(topic)) continue;
                subscribed.add(topic);
                if (!topics.has(topic)) topics.set(topic, new Set());
                topics.get(topic).add(conn);
            }
        }

        if (msg.type === 'unsubscribe') {
            for (const topic of (msg.topics || [])) {
                subscribed.delete(topic);
                const subs = topics.get(topic);
                if (subs) { subs.delete(conn); if (subs.size === 0) topics.delete(topic); }
            }
        }

        if (msg.type === 'publish' && msg.topic) {
            const subs = topics.get(msg.topic);
            if (subs) {
                const data = JSON.stringify(msg);
                for (const peer of subs) {
                    if (peer !== conn && peer.readyState === WebSocket.OPEN) {
                        peer.send(data);
                    }
                }
            }
        }

        if (msg.type === 'ping') {
            conn.send(JSON.stringify({ type: 'pong' }));
        }
    });

    const cleanup = () => {
        if (!alive) return;
        alive = false;
        for (const topic of subscribed) {
            const subs = topics.get(topic);
            if (subs) { subs.delete(conn); if (subs.size === 0) topics.delete(topic); }
        }
    };

    conn.on('close', cleanup);
    conn.on('error', cleanup);
});

server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

server.listen(PORT, () => {
    console.log(`signaling server listening on :${PORT}`);
});
