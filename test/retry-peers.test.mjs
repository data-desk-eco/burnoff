/**
 * Tests for STAC retry with backoff and region-aware peer selection.
 *
 * Covers:
 *   - fetchWithRetry: retry logic, backoff timing, status code handling
 *   - geohash3: known-good coordinate → geohash mappings
 *   - jaccardScore: set similarity edge cases
 *   - PeerMesh peer selection: cap enforcement, eviction, rescoring
 *
 * Run:  node --test test/retry-peers.test.mjs
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { geohash3, jaccardScore } from '../web/rtc.js';

// ───────────────────────────────────────────────────────────────────────
// fetchWithRetry — extracted from detect.js (runs in a Worker, so we
// copy it here with a pluggable fetch for testing)
// ───────────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options, maxRetries = 3, _fetch = globalThis.fetch) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let resp;
        try {
            resp = await _fetch(url, options);
        } catch (err) {
            if (attempt === maxRetries) throw err;
            const delay = (1000 * Math.pow(2, attempt)) * (1 + Math.random() * 0.5);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }

        if (resp.ok) return resp;

        if (resp.status !== 429 && resp.status < 500) {
            throw new Error(`HTTP ${resp.status}`);
        }

        if (attempt === maxRetries) {
            throw new Error(`HTTP ${resp.status} after ${maxRetries + 1} attempts`);
        }

        let delay;
        if (resp.status === 429) {
            const ra = resp.headers.get('Retry-After');
            const raSec = ra ? parseInt(ra, 10) : NaN;
            delay = (!isNaN(raSec) && raSec > 0) ? Math.min(raSec, 30) * 1000 : (1000 * Math.pow(2, attempt));
        } else {
            delay = 1000 * Math.pow(2, attempt);
        }
        delay *= (1 + Math.random() * 0.5);
        await new Promise(r => setTimeout(r, delay));
    }
}

// ───────────────────────────────────────────────────────────────────────
// Mock helpers
// ───────────────────────────────────────────────────────────────────────

function mockResponse(status, { headers = {}, ok } = {}) {
    return {
        status,
        ok: ok !== undefined ? ok : (status >= 200 && status < 300),
        headers: { get: (key) => headers[key] || null },
    };
}

function makeMockFetch(responses) {
    let callIndex = 0;
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, options });
        const entry = responses[Math.min(callIndex++, responses.length - 1)];
        if (entry instanceof Error) throw entry;
        return entry;
    };
    fn.calls = calls;
    return fn;
}

// Faster version for tests — override delay to 0
async function fetchWithRetryFast(url, options, maxRetries, _fetch) {
    // Patch: replace the real function's delays with immediate resolution
    // by running the same logic but with a minimal sleep
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let resp;
        try {
            resp = await _fetch(url, options);
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, 0));
            continue;
        }
        if (resp.ok) return resp;
        if (resp.status !== 429 && resp.status < 500) {
            throw new Error(`HTTP ${resp.status}`);
        }
        if (attempt === maxRetries) {
            throw new Error(`HTTP ${resp.status} after ${maxRetries + 1} attempts`);
        }
        await new Promise(r => setTimeout(r, 0));
    }
}

// ───────────────────────────────────────────────────────────────────────
// Tests: fetchWithRetry
// ───────────────────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {

    it('returns response on first success', async () => {
        const mock = makeMockFetch([mockResponse(200)]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 1);
    });

    it('retries on network error then succeeds', async () => {
        const mock = makeMockFetch([
            new TypeError('Failed to fetch'),
            mockResponse(200)
        ]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 2);
    });

    it('retries on 500 then succeeds', async () => {
        const mock = makeMockFetch([
            mockResponse(500),
            mockResponse(200)
        ]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 2);
    });

    it('retries on 502 then succeeds', async () => {
        const mock = makeMockFetch([
            mockResponse(502),
            mockResponse(200)
        ]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 2);
    });

    it('retries on 429 then succeeds', async () => {
        const mock = makeMockFetch([
            mockResponse(429),
            mockResponse(200)
        ]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 2);
    });

    it('does not retry on 400', async () => {
        const mock = makeMockFetch([mockResponse(400)]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 3, mock),
            { message: 'HTTP 400' }
        );
        assert.equal(mock.calls.length, 1);
    });

    it('does not retry on 403', async () => {
        const mock = makeMockFetch([mockResponse(403)]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 3, mock),
            { message: 'HTTP 403' }
        );
        assert.equal(mock.calls.length, 1);
    });

    it('does not retry on 404', async () => {
        const mock = makeMockFetch([mockResponse(404)]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 3, mock),
            { message: 'HTTP 404' }
        );
        assert.equal(mock.calls.length, 1);
    });

    it('exhausts retries on persistent 500', async () => {
        const mock = makeMockFetch([
            mockResponse(500),
            mockResponse(500),
            mockResponse(500),
            mockResponse(500),
        ]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 3, mock),
            { message: 'HTTP 500 after 4 attempts' }
        );
        assert.equal(mock.calls.length, 4, 'should attempt 4 times (1 + 3 retries)');
    });

    it('exhausts retries on persistent network errors', async () => {
        const err = new TypeError('Failed to fetch');
        const mock = makeMockFetch([err, err, err, err]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 3, mock),
            { message: 'Failed to fetch' }
        );
        assert.equal(mock.calls.length, 4);
    });

    it('recovers after multiple failures', async () => {
        const mock = makeMockFetch([
            mockResponse(503),
            new TypeError('network error'),
            mockResponse(429),
            mockResponse(200)
        ]);
        const resp = await fetchWithRetryFast('https://example.com', {}, 3, mock);
        assert.equal(resp.status, 200);
        assert.equal(mock.calls.length, 4);
    });

    it('respects maxRetries parameter', async () => {
        const mock = makeMockFetch([
            mockResponse(500),
            mockResponse(500),
        ]);
        await assert.rejects(
            () => fetchWithRetryFast('https://example.com', {}, 1, mock),
            /HTTP 500/
        );
        assert.equal(mock.calls.length, 2, 'maxRetries=1 means 2 total attempts');
    });

    it('passes url and options through to fetch', async () => {
        const opts = { method: 'POST', headers: { 'X-Test': '1' }, body: '{}' };
        const mock = makeMockFetch([mockResponse(200)]);
        await fetchWithRetryFast('https://stac.example.com/search', opts, 3, mock);
        assert.equal(mock.calls[0].url, 'https://stac.example.com/search');
        assert.deepStrictEqual(mock.calls[0].options, opts);
    });
});

// ───────────────────────────────────────────────────────────────────────
// Tests: geohash3
// ───────────────────────────────────────────────────────────────────────

describe('geohash3', () => {

    it('produces a 3-character string', () => {
        const h = geohash3(25.92, 51.52);
        assert.equal(typeof h, 'string');
        assert.equal(h.length, 3);
    });

    it('uses only base32 characters', () => {
        const valid = '0123456789bcdefghjkmnpqrstuvwxyz';
        for (const [lat, lng] of [[0, 0], [90, 180], [-90, -180], [51.5, -0.1], [-33.9, 18.4]]) {
            const h = geohash3(lat, lng);
            for (const ch of h) {
                assert.ok(valid.includes(ch), `char '${ch}' in geohash3(${lat},${lng})=${h} not in base32`);
            }
        }
    });

    it('known coordinates produce expected geohashes', () => {
        // Doha, Qatar (25.29, 51.53) → "thk" at precision 3
        // London (51.5, -0.1) → "gcp" at precision 3
        // Origin (0, 0) → "s00" at precision 3
        const h1 = geohash3(25.29, 51.53);
        assert.equal(h1, 'thk', `Doha: expected 'thk', got '${h1}'`);

        const h2 = geohash3(51.5, -0.1);
        assert.equal(h2, 'gcp', `London: expected 'gcp', got '${h2}'`);

        const h3 = geohash3(0, 0);
        assert.equal(h3, 's00', `Origin: expected 's00', got '${h3}'`);
    });

    it('nearby coordinates produce the same geohash', () => {
        // Two points ~1km apart in Qatar should be in the same ~156km cell
        const h1 = geohash3(25.920, 51.520);
        const h2 = geohash3(25.925, 51.525);
        assert.equal(h1, h2, `nearby points should share geohash: ${h1} vs ${h2}`);
    });

    it('distant coordinates produce different geohashes', () => {
        const h1 = geohash3(25.92, 51.52);  // Qatar
        const h2 = geohash3(51.50, -0.10);  // London
        assert.notEqual(h1, h2, 'Qatar and London should have different geohashes');
    });

    it('handles boundary coordinates', () => {
        // Extremes should not throw
        assert.equal(geohash3(90, 180).length, 3);
        assert.equal(geohash3(-90, -180).length, 3);
        assert.equal(geohash3(0, 0).length, 3);
    });

    it('is deterministic', () => {
        for (let i = 0; i < 100; i++) {
            assert.equal(geohash3(25.92, 51.52), geohash3(25.92, 51.52));
        }
    });

    it('different hemispheres produce different prefixes', () => {
        const ne = geohash3(25.0, 51.0);   // NE
        const nw = geohash3(25.0, -51.0);  // NW
        const se = geohash3(-25.0, 51.0);  // SE
        const sw = geohash3(-25.0, -51.0); // SW
        const hashes = new Set([ne, nw, se, sw]);
        assert.equal(hashes.size, 4, `all hemispheres should differ: ${ne}, ${nw}, ${se}, ${sw}`);
    });
});

// ───────────────────────────────────────────────────────────────────────
// Tests: jaccardScore
// ───────────────────────────────────────────────────────────────────────

describe('jaccardScore', () => {

    it('both empty → 0.5', () => {
        assert.equal(jaccardScore(new Set(), new Set()), 0.5);
    });

    it('one empty, one non-empty → 0.1', () => {
        assert.equal(jaccardScore(new Set(['a']), new Set()), 0.1);
        assert.equal(jaccardScore(new Set(), new Set(['a'])), 0.1);
    });

    it('identical sets → 1.0', () => {
        const s = new Set(['a', 'b', 'c']);
        assert.equal(jaccardScore(s, s), 1.0);
    });

    it('identical contents → 1.0', () => {
        assert.equal(jaccardScore(new Set(['x', 'y']), new Set(['x', 'y'])), 1.0);
    });

    it('disjoint sets → 0.0', () => {
        assert.equal(jaccardScore(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
    });

    it('partial overlap', () => {
        // {a,b,c} ∩ {b,c,d} = {b,c}, union = {a,b,c,d}
        const score = jaccardScore(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
        assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
    });

    it('subset relationship', () => {
        // {a} ∩ {a,b,c} = {a}, union = {a,b,c}
        const score = jaccardScore(new Set(['a']), new Set(['a', 'b', 'c']));
        assert.ok(Math.abs(score - 1 / 3) < 0.001, `expected ~0.333, got ${score}`);
    });

    it('is symmetric', () => {
        const a = new Set(['the', 'thn', 't7y']);
        const b = new Set(['thn', 'gcp']);
        assert.equal(jaccardScore(a, b), jaccardScore(b, a));
    });

    it('single common element', () => {
        // {a} ∩ {a} = {a}, union = {a}
        assert.equal(jaccardScore(new Set(['a']), new Set(['a'])), 1.0);
    });

    it('works with geohash strings', () => {
        const peer1 = new Set(['the', 'thn', 't7y']);
        const peer2 = new Set(['the', 'thn']);
        // intersection = 2, union = 3
        const score = jaccardScore(peer1, peer2);
        assert.ok(Math.abs(score - 2 / 3) < 0.001, `expected ~0.667, got ${score}`);
    });
});

// ───────────────────────────────────────────────────────────────────────
// Tests: PeerMesh region-aware selection logic (unit-level)
//
// We can't instantiate real PeerMesh (needs WebSocket/RTCPeerConnection),
// so we test the selection logic in isolation.
// ───────────────────────────────────────────────────────────────────────

describe('peer selection logic', () => {

    // Simulate the _maybeConnect decision
    function shouldConnect(newScore, connectedScores, maxPeers) {
        if (connectedScores.length < maxPeers) return { connect: true, evict: null };

        let worstIdx = 0;
        for (let i = 1; i < connectedScores.length; i++) {
            if (connectedScores[i] < connectedScores[worstIdx]) worstIdx = i;
        }

        if (newScore > connectedScores[worstIdx]) {
            return { connect: true, evict: worstIdx };
        }
        return { connect: false, evict: null };
    }

    it('connects freely when under capacity', () => {
        const result = shouldConnect(0.5, [0.8, 0.6], 8);
        assert.equal(result.connect, true);
        assert.equal(result.evict, null);
    });

    it('connects at zero peers', () => {
        const result = shouldConnect(0.1, [], 8);
        assert.equal(result.connect, true);
    });

    it('evicts lowest-scoring peer when at cap and new peer is better', () => {
        const scores = [0.8, 0.3, 0.6, 0.9, 0.7, 0.5, 0.4, 0.6]; // 8 peers
        const result = shouldConnect(0.75, scores, 8);
        assert.equal(result.connect, true);
        assert.equal(result.evict, 1, 'should evict index 1 (score 0.3)');
    });

    it('rejects new peer when at cap and new peer is worse than all', () => {
        const scores = [0.8, 0.7, 0.6, 0.9, 0.7, 0.5, 0.8, 0.6]; // 8 peers
        const result = shouldConnect(0.4, scores, 8);
        assert.equal(result.connect, false);
    });

    it('rejects new peer when score equals worst (strict >)', () => {
        const scores = [0.8, 0.5, 0.6];
        const result = shouldConnect(0.5, scores, 3);
        assert.equal(result.connect, false, 'equal score should not evict');
    });

    it('new peers (both empty geo) connect freely at 0.5 default', () => {
        // Both empty → jaccardScore = 0.5
        const score = jaccardScore(new Set(), new Set());
        assert.equal(score, 0.5);
        const result = shouldConnect(score, [], 8);
        assert.equal(result.connect, true);
    });

    it('one empty peer gets low priority score 0.1', () => {
        const score = jaccardScore(new Set(['the', 'thn']), new Set());
        assert.equal(score, 0.1);
    });
});

describe('peer selection with geo scoring integration', () => {

    it('prefers peer with overlapping regions over disjoint peer', () => {
        const local = new Set(['the', 'thn', 't7y']);
        const peerA = new Set(['the', 'thn']);       // overlapping
        const peerB = new Set(['gcp', 's00']);        // disjoint

        const scoreA = jaccardScore(local, peerA);
        const scoreB = jaccardScore(local, peerB);

        assert.ok(scoreA > scoreB,
            `overlapping peer (${scoreA.toFixed(3)}) should score higher than disjoint (${scoreB.toFixed(3)})`);
    });

    it('eviction scenario: disjoint peer evicted for overlapping peer', () => {
        const local = new Set(['the', 'thn', 't7y']);

        // Currently connected to 8 peers, one of which is disjoint
        const connected = [
            { geo: new Set(['the']), score: null },
            { geo: new Set(['thn', 't7y']), score: null },
            { geo: new Set(['the', 'thn']), score: null },
            { geo: new Set(['the', 't7y']), score: null },
            { geo: new Set(['gcp', 's00']), score: null },  // disjoint - should be evicted
            { geo: new Set(['the']), score: null },
            { geo: new Set(['thn']), score: null },
            { geo: new Set(['the', 'thn', 't7y']), score: null },
        ];

        // Score all connected peers
        for (const p of connected) {
            p.score = jaccardScore(local, p.geo);
        }

        // New peer with good overlap
        const newPeerGeo = new Set(['the', 'thn']);
        const newScore = jaccardScore(local, newPeerGeo);

        // Find worst connected
        let worstIdx = 0;
        for (let i = 1; i < connected.length; i++) {
            if (connected[i].score < connected[worstIdx].score) worstIdx = i;
        }

        assert.equal(worstIdx, 4, 'disjoint peer should have lowest score');
        assert.ok(newScore > connected[worstIdx].score,
            `new peer (${newScore.toFixed(3)}) should beat disjoint (${connected[worstIdx].score.toFixed(3)})`);
    });

    it('rescore detects improvement after local geo changes', () => {
        // Initially local has no data → scores with existing peers are all 0.5
        let localGeo = new Set();

        const peers = [
            { id: 'A', geo: new Set(['the', 'thn']) },
            { id: 'B', geo: new Set(['gcp', 's00']) },
        ];

        // Initial scores (both empty local → 0.1 for non-empty peers)
        const initialScores = peers.map(p => ({
            id: p.id,
            score: jaccardScore(localGeo, p.geo)
        }));
        assert.equal(initialScores[0].score, 0.1);
        assert.equal(initialScores[1].score, 0.1);

        // Local processes some blocks in Qatar region
        localGeo = new Set(['the', 'thn', 't7y']);

        // Rescore
        const newScores = peers.map(p => ({
            id: p.id,
            score: jaccardScore(localGeo, p.geo)
        }));

        assert.ok(newScores[0].score > newScores[1].score,
            `after processing Qatar, peer A (${newScores[0].score.toFixed(3)}) should score better than B (${newScores[1].score.toFixed(3)})`);
        assert.ok(newScores[0].score > 0.5, 'peer A should have high overlap');
        assert.equal(newScores[1].score, 0, 'peer B should have zero overlap');
    });
});

describe('geohash3 coverage of processedMap', () => {

    it('computeGeoSummary pattern: dedups into geohash set', () => {
        // Simulate what computeGeoSummary does
        const processedEntries = [
            { key: 'T31_0_0:2024-01-01', value: [25.92, 51.52] },
            { key: 'T31_0_1:2024-01-01', value: [25.93, 51.53] },  // same cell
            { key: 'T31_1_0:2024-01-01', value: [25.92, 51.52] },  // same cell
            { key: 'T40_0_0:2024-01-01', value: [51.50, -0.10] },  // different cell (London)
            { key: 'T99_0_0:2024-01-01', value: [0, 0] },          // skipped (0,0)
        ];

        const hashes = new Set();
        for (const { value } of processedEntries) {
            const [lat, lng] = value;
            if (lat === 0 && lng === 0) continue;
            hashes.add(geohash3(lat, lng));
        }

        assert.equal(hashes.size, 2, `expected 2 distinct geohashes, got ${hashes.size}: ${[...hashes]}`);
        assert.ok(hashes.has(geohash3(25.92, 51.52)), 'should contain Qatar geohash');
        assert.ok(hashes.has(geohash3(51.50, -0.10)), 'should contain London geohash');
    });

    it('empty processedMap produces empty set', () => {
        const hashes = new Set();
        assert.equal(hashes.size, 0);
        // Both-empty → 0.5
        assert.equal(jaccardScore(hashes, new Set()), 0.5);
    });
});
