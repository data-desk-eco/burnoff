/**
 * Node.js tests for Burnoff P2P CRDT layer.
 * Tests the Yjs document operations that back the P2P sync.
 */
import * as Y from 'yjs';

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  PASS: ${name}`);
        passed++;
    } else {
        console.error(`  FAIL: ${name}`);
        failed++;
    }
}

console.log('=== Burnoff P2P Test Suite ===\n');

// --- 1. Yjs Document ---
console.log('1. Yjs Document');
const doc = new Y.Doc();
const detections = doc.getMap('detections');
const processed = doc.getMap('processed');
assert(doc instanceof Y.Doc, 'Y.Doc instantiates');
assert(detections.size === 0, 'detections map starts empty');
assert(processed.size === 0, 'processed map starts empty');

// --- 2. CRDT map operations (cacheBlockResult equivalent) ---
console.log('\n2. CRDT Map Operations (cacheBlockResult)');
const testDets = [{ date: '2024-01-15', max_b12: 0.95, flare_lon: 51.5, flare_lat: 25.9, pixels: 5 }];
doc.transact(() => {
    detections.set('31RDL_10_20:2024-01-15', testDets);
    processed.set('31RDL_10_20:2024-01-15', Date.now());
});
assert(detections.size === 1, 'detection stored');
assert(processed.size === 1, 'processed marker stored');

const retrieved = detections.get('31RDL_10_20:2024-01-15');
assert(Array.isArray(retrieved) && retrieved.length === 1, 'detection retrieved as array');
assert(retrieved[0].max_b12 === 0.95, 'detection data preserved');
assert(retrieved[0].flare_lon === 51.5, 'coordinate data preserved');

// --- 3. Observer pattern ---
console.log('\n3. Observer Pattern');
let observeCount = 0;
let lastChangedKeys = [];
detections.observe(event => {
    observeCount++;
    lastChangedKeys = [];
    event.changes.keys.forEach((change, key) => lastChangedKeys.push({ key, action: change.action }));
});
detections.set('31RDL_10_21:2024-01-15', [{ date: '2024-01-15', max_b12: 0.80 }]);
assert(observeCount === 1, 'observer fires on set');
assert(lastChangedKeys.length === 1 && lastChangedKeys[0].action === 'add', 'observer reports add action');

// Update existing key
detections.set('31RDL_10_21:2024-01-15', [{ date: '2024-01-15', max_b12: 0.85 }]);
assert(observeCount === 2, 'observer fires on update');
assert(lastChangedKeys[0].action === 'update', 'observer reports update action');

// --- 4. Rebuild pattern (allRawDetections rebuild) ---
console.log('\n4. Detection Rebuild');
let allRaw = [];
detections.forEach(dets => {
    if (dets && dets.length > 0) allRaw = allRaw.concat(dets);
});
assert(allRaw.length === 2, `rebuild collects all detections (got ${allRaw.length})`);

// --- 5. Deduplication (same key overwrites, no duplicates) ---
console.log('\n5. CRDT Deduplication');
detections.set('31RDL_10_20:2024-01-15', testDets);
assert(detections.size === 2, 'same key does not create duplicate entry');

// --- 6. getCachedBlockKeys equivalent ---
console.log('\n6. Cached Block Keys (getCachedBlockKeys)');
// Add more processed entries (some with detections, some without)
doc.transact(() => {
    processed.set('31RDL_10_21:2024-01-15', Date.now());
    processed.set('31RDL_0_0:2024-03-01', Date.now()); // empty block
});
const keys = Array.from(processed.keys());
assert(keys.length === 3, `correct key count (got ${keys.length})`);
assert(keys.includes('31RDL_10_20:2024-01-15'), 'includes detection block');
assert(keys.includes('31RDL_0_0:2024-03-01'), 'includes empty block');

// --- 7. Empty block caching (processed but no detections) ---
console.log('\n7. Empty Block Cache');
assert(processed.has('31RDL_0_0:2024-03-01'), 'empty block marked processed');
assert(!detections.has('31RDL_0_0:2024-03-01'), 'no detection entry for empty block');

// --- 8. Two-doc sync (simulates P2P between peers) ---
console.log('\n8. Two-Doc Sync (P2P simulation)');
const doc2 = new Y.Doc();
const detections2 = doc2.getMap('detections');
const processed2 = doc2.getMap('processed');

// Sync state from doc1 → doc2
const state1 = Y.encodeStateAsUpdate(doc);
Y.applyUpdate(doc2, state1);
assert(detections2.size === 2, `doc2 received detections (got ${detections2.size})`);
assert(processed2.size === 3, `doc2 received processed markers (got ${processed2.size})`);

const d2Retrieved = detections2.get('31RDL_10_20:2024-01-15');
assert(d2Retrieved && d2Retrieved[0].max_b12 === 0.95, 'synced detection data intact');

// --- 9. Bidirectional sync ---
console.log('\n9. Bidirectional Sync');
// Peer 2 discovers new flares
detections2.set('40RBN_5_5:2024-02-01', [{ date: '2024-02-01', max_b12: 1.10, flare_lon: 52.1, flare_lat: 26.3 }]);
doc2.transact(() => {
    processed2.set('40RBN_5_5:2024-02-01', Date.now());
});

// Sync state from doc2 → doc1
const state2 = Y.encodeStateAsUpdate(doc2);
Y.applyUpdate(doc, state2);
assert(detections.size === 3, `doc1 received new detection (got ${detections.size})`);
assert(detections.has('40RBN_5_5:2024-02-01'), 'peer2 detection visible on peer1');

// --- 10. Concurrent edits (both peers detect different blocks simultaneously) ---
console.log('\n10. Concurrent Edits');
detections.set('31RDL_20_30:2024-04-01', [{ date: '2024-04-01', max_b12: 0.70 }]);
detections2.set('40RBN_8_8:2024-04-01', [{ date: '2024-04-01', max_b12: 0.60 }]);

// Merge both ways
const update1 = Y.encodeStateAsUpdate(doc);
const update2 = Y.encodeStateAsUpdate(doc2);
Y.applyUpdate(doc, update2);
Y.applyUpdate(doc2, update1);

assert(detections.size === detections2.size, 'both docs converge to same size');
assert(detections.size === 5, `total detections correct (got ${detections.size})`);

// --- 11. Same block processed by both peers (deterministic dedup) ---
console.log('\n11. Same Block by Both Peers');
const sameDets = [{ date: '2024-05-01', max_b12: 0.92, flare_lon: 51.0, flare_lat: 25.0 }];
detections.set('31RDL_99_99:2024-05-01', sameDets);
detections2.set('31RDL_99_99:2024-05-01', sameDets);

const upA = Y.encodeStateAsUpdate(doc);
const upB = Y.encodeStateAsUpdate(doc2);
Y.applyUpdate(doc, upB);
Y.applyUpdate(doc2, upA);

assert(detections.size === 6, 'no duplicate from same block key');
assert(detections2.size === 6, 'both peers agree on count');

// --- 12. Full rebuild after sync ---
console.log('\n12. Full Rebuild After Sync');
allRaw = [];
detections.forEach(dets => {
    if (dets && dets.length > 0) allRaw = allRaw.concat(dets);
});
assert(allRaw.length === 6, `rebuild after sync collects all (got ${allRaw.length})`);

// --- 13. State vector for incremental sync ---
console.log('\n13. Incremental Sync (State Vectors)');
const sv1 = Y.encodeStateVector(doc);
// Add new detection to doc2
detections2.set('NEW_0_0:2024-06-01', [{ date: '2024-06-01', max_b12: 0.55 }]);
// Only get the diff
const diff = Y.encodeStateAsUpdate(doc2, sv1);
Y.applyUpdate(doc, diff);
assert(detections.has('NEW_0_0:2024-06-01'), 'incremental sync delivers new entry');
assert(detections.size === 7, `incremental sync correct count (got ${detections.size})`);

// --- 14. Migration simulation ---
console.log('\n14. Migration Simulation');
const migDoc = new Y.Doc();
const migDet = migDoc.getMap('detections');
const migProc = migDoc.getMap('processed');

// Simulate localStorage entries
const lsEntries = {
    'b:TILE_1_1:2024-01-01': JSON.stringify([{ date: '2024-01-01', max_b12: 0.90 }]),
    'b:TILE_2_2:2024-01-01': JSON.stringify([]),
    'b:TILE_3_3:2024-02-01': JSON.stringify([{ date: '2024-02-01', max_b12: 1.05 }]),
};

// Simulate migration logic
for (const [key, value] of Object.entries(lsEntries)) {
    const blockDateKey = key.slice(2);
    const dets = JSON.parse(value);
    migDoc.transact(() => {
        migProc.set(blockDateKey, Date.now());
        if (dets.length > 0) migDet.set(blockDateKey, dets);
    });
}

assert(migProc.size === 3, 'all blocks marked processed');
assert(migDet.size === 2, 'only non-empty blocks in detections map');
assert(!migDet.has('TILE_2_2:2024-01-01'), 'empty block excluded from detections');

// === Summary ===
console.log(`\n=== ${passed}/${passed + failed} tests passed ===`);
if (failed > 0) process.exit(1);
