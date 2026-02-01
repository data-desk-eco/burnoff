#!/usr/bin/env node

// Zero-dependency WebSocket signaling relay.
// Implements RFC 6455 framing over node:http + node:crypto.

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 4444;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB4BD85B9B3';

// topic -> Set<conn>
const topics = new Map();

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('signaling ok');
});

server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = { socket, subscribed: new Set(), buf: Buffer.alloc(0), alive: true };

    socket.on('data', (chunk) => {
        conn.buf = Buffer.concat([conn.buf, chunk]);
        while (conn.buf.length >= 2) {
            const frame = parseFrame(conn.buf);
            if (!frame) break;
            conn.buf = conn.buf.subarray(frame.consumed);
            handleFrame(conn, frame);
        }
    });

    const cleanup = () => {
        if (!conn.alive) return;
        conn.alive = false;
        for (const topic of conn.subscribed) {
            const subs = topics.get(topic);
            if (subs) { subs.delete(conn); if (subs.size === 0) topics.delete(topic); }
        }
        socket.destroy();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
});

function parseFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0F;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7F;
    let offset = 2;

    if (payloadLen === 126) {
        if (buf.length < 4) return null;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buf.length < 10) return null;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }

    const needed = offset + (masked ? 4 : 0) + payloadLen;
    if (buf.length < needed) return null;

    let payload;
    if (masked) {
        const maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
        payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
            payload[i] = buf[offset + i] ^ maskKey[i & 3];
        }
    } else {
        payload = buf.subarray(offset, offset + payloadLen);
    }

    return { opcode, payload, consumed: offset + payloadLen };
}

function sendFrame(socket, opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.allocUnsafe(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(header);
    socket.write(payload);
}

function sendText(conn, text) {
    if (conn.alive) sendFrame(conn.socket, 0x1, Buffer.from(text));
}

function handleFrame(conn, frame) {
    if (frame.opcode === 0x8) { // close
        conn.socket.end();
        return;
    }
    if (frame.opcode === 0x9) { // ping -> pong
        sendFrame(conn.socket, 0xA, frame.payload);
        return;
    }
    if (frame.opcode !== 0x1) return; // only handle text

    let msg;
    try { msg = JSON.parse(frame.payload.toString()); } catch { return; }

    if (msg.type === 'subscribe') {
        for (const topic of (msg.topics || [])) {
            if (conn.subscribed.has(topic)) continue;
            conn.subscribed.add(topic);
            if (!topics.has(topic)) topics.set(topic, new Set());
            topics.get(topic).add(conn);
        }
    }

    if (msg.type === 'unsubscribe') {
        for (const topic of (msg.topics || [])) {
            conn.subscribed.delete(topic);
            const subs = topics.get(topic);
            if (subs) { subs.delete(conn); if (subs.size === 0) topics.delete(topic); }
        }
    }

    if (msg.type === 'publish' && msg.topic) {
        const subs = topics.get(msg.topic);
        if (subs) {
            const data = JSON.stringify(msg);
            for (const peer of subs) {
                if (peer !== conn && peer.alive) sendText(peer, data);
            }
        }
    }

    if (msg.type === 'ping') {
        sendText(conn, JSON.stringify({ type: 'pong' }));
    }
}

server.listen(PORT, () => {
    console.log(`signaling server listening on :${PORT}`);
});
