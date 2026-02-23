// Node.js signaling test using ws package.
// Usage: NODE_PATH=/tmp/node_modules node test/signaling-node.test.mjs [url]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://localhost:8787';
let pass = 0, fail = 0;

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        ws.on('open', () => resolve(ws));
        ws.on('error', (e) => reject(new Error('connect: ' + e.message)));
        setTimeout(() => reject(new Error('connect timeout')), 5000);
    });
}

function waitMsg(ws, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('msg timeout')), timeout);
        ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
    });
}

async function test(name, fn) {
    try { await fn(); pass++; console.log('  PASS', name); }
    catch (e) { fail++; console.log('  FAIL', name + ':', e.message); }
}

console.log('signaling tests against', URL, '\n');

await test('ping/pong', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitMsg(ws);
    if (msg.type !== 'pong') throw new Error('got ' + msg.type);
    ws.close();
});

await test('publish relays to subscriber', async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    ws1.send(JSON.stringify({ type: 'subscribe', topics: ['room-a'] }));
    ws2.send(JSON.stringify({ type: 'subscribe', topics: ['room-a'] }));
    await new Promise(r => setTimeout(r, 300));
    const pending = waitMsg(ws1);
    ws2.send(JSON.stringify({ type: 'publish', topic: 'room-a', kind: 'test', data: 'hello' }));
    const msg = await pending;
    if (msg.kind !== 'test') throw new Error('wrong: ' + JSON.stringify(msg));
    ws1.close(); ws2.close();
});

await test('no echo to sender', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['room-b'] }));
    await new Promise(r => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'publish', topic: 'room-b', kind: 'echo' }));
    const got = await Promise.race([
        waitMsg(ws, 1000).then(() => true).catch(() => false),
        new Promise(r => setTimeout(() => r(false), 1200)),
    ]);
    if (got) throw new Error('got own message');
    ws.close();
});

await test('non-subscriber ignored', async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    ws1.send(JSON.stringify({ type: 'subscribe', topics: ['room-c'] }));
    await new Promise(r => setTimeout(r, 300));
    const pending = waitMsg(ws1);
    ws2.send(JSON.stringify({ type: 'publish', topic: 'room-c', kind: 'x' }));
    const msg = await pending;
    if (msg.kind !== 'x') throw new Error('wrong');
    const ws2got = await Promise.race([
        waitMsg(ws2, 500).then(() => true).catch(() => false),
        new Promise(r => setTimeout(() => r(false), 700)),
    ]);
    if (ws2got) throw new Error('non-sub got msg');
    ws1.close(); ws2.close();
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
