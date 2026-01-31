// ---------------------------------------------------------------------------
// LWW-Map CRDT + Binary Codec
// ---------------------------------------------------------------------------
// Pure data structure, no I/O dependencies.

const EPOCH = Date.UTC(2020, 0, 1); // 2020-01-01 in ms
const MS_PER_DAY = 86400000;

// ---------------------------------------------------------------------------
// LWW-Map
// ---------------------------------------------------------------------------

export class LWWMap {
    constructor() {
        this._entries = new Map(); // key -> { value, ts, peerId }
        this.onChange = null;      // (key, value, source) => void
    }

    set(key, value, ts = Date.now(), peerId = 0) {
        const existing = this._entries.get(key);
        if (existing && (ts < existing.ts || (ts === existing.ts && peerId <= existing.peerId))) {
            return false;
        }
        this._entries.set(key, { value, ts, peerId });
        if (this.onChange) this.onChange(key, value, 'local');
        return true;
    }

    merge(key, value, ts, peerId) {
        const existing = this._entries.get(key);
        if (existing && (ts < existing.ts || (ts === existing.ts && peerId <= existing.peerId))) {
            return false;
        }
        this._entries.set(key, { value, ts, peerId });
        if (this.onChange) this.onChange(key, value, 'remote');
        return true;
    }

    get(key) {
        const e = this._entries.get(key);
        return e ? e.value : undefined;
    }

    getEntry(key) {
        return this._entries.get(key) || null;
    }

    has(key) {
        return this._entries.has(key);
    }

    keys() {
        return this._entries.keys();
    }

    delete(key) {
        return this._entries.delete(key);
    }

    forEach(fn) {
        this._entries.forEach((entry, key) => fn(entry.value, key));
    }

    get size() {
        return this._entries.size;
    }
}

// ---------------------------------------------------------------------------
// Binary key encoding (9 bytes)
// ---------------------------------------------------------------------------
// Format: mgrs (5 ASCII) + row (u8) + col (u8) + date (u16 days since epoch)

export function encodeKey(keyStr) {
    // keyStr format: "MGRS5_row_col:YYYY-MM-DD"
    const colonIdx = keyStr.indexOf(':');
    const blockPart = keyStr.substring(0, colonIdx);
    const datePart = keyStr.substring(colonIdx + 1);

    const parts = blockPart.split('_');
    const mgrs = parts[0];
    const row = parseInt(parts[1]);
    const col = parseInt(parts[2]);

    const dateMs = Date.UTC(
        parseInt(datePart.substring(0, 4)),
        parseInt(datePart.substring(5, 7)) - 1,
        parseInt(datePart.substring(8, 10))
    );
    const days = Math.round((dateMs - EPOCH) / MS_PER_DAY);

    const buf = new Uint8Array(9);
    for (let i = 0; i < 5; i++) {
        buf[i] = i < mgrs.length ? mgrs.charCodeAt(i) : 0x20;
    }
    buf[5] = row;
    buf[6] = col;
    buf[7] = days & 0xFF;
    buf[8] = (days >> 8) & 0xFF;
    return buf;
}

export function decodeKey(buf, offset = 0) {
    let mgrs = '';
    for (let i = 0; i < 5; i++) {
        const c = buf[offset + i];
        if (c !== 0x20) mgrs += String.fromCharCode(c);
    }
    const row = buf[offset + 5];
    const col = buf[offset + 6];
    const days = buf[offset + 7] | (buf[offset + 8] << 8);

    const dateMs = EPOCH + days * MS_PER_DAY;
    const d = new Date(dateMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');

    return {
        key: `${mgrs}_${row}_${col}:${yyyy}-${mm}-${dd}`,
        mgrs, row, col,
        date: `${yyyy}-${mm}-${dd}`,
        bytesRead: 9
    };
}

// ---------------------------------------------------------------------------
// Binary detection encoding (44 bytes)
// ---------------------------------------------------------------------------

export function encodeDetection(det, cogUrlIdx) {
    const buf = new ArrayBuffer(44);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // date: u16 (days since epoch)
    const dateMs = Date.UTC(
        parseInt(det.date.substring(0, 4)),
        parseInt(det.date.substring(5, 7)) - 1,
        parseInt(det.date.substring(8, 10))
    );
    const days = Math.round((dateMs - EPOCH) / MS_PER_DAY);
    view.setUint16(0, days, true);

    // max_b12: u16 (x10000)
    view.setUint16(2, Math.round((det.max_b12 || 0) * 10000), true);
    // avg_b12: u16 (x10000)
    view.setUint16(4, Math.round((det.avg_b12 || 0) * 10000), true);
    // pixels: u16
    view.setUint16(6, det.pixels || 0, true);
    // flare_lon: f32
    view.setFloat32(8, det.flare_lon, true);
    // flare_lat: f32
    view.setFloat32(12, det.flare_lat, true);
    // epsg: u16
    view.setUint16(16, det.epsg || 0, true);
    // sun_elevation: i8 (-128 = null)
    view.setInt8(18, det.sun_elevation != null ? Math.round(det.sun_elevation) : -128);
    // utm_bounds: f32 x 4
    const ub = det.utm_bounds || [0, 0, 0, 0];
    view.setFloat32(19, ub[0], true);
    view.setFloat32(23, ub[1], true);
    view.setFloat32(27, ub[2], true);
    view.setFloat32(31, ub[3], true);
    // block_row: u8
    u8[35] = det.block_row || 0;
    // block_col: u8
    u8[36] = det.block_col || 0;
    // mgrs: 5 ASCII
    const mgrs = det.mgrs || '';
    for (let i = 0; i < 5; i++) {
        u8[37 + i] = i < mgrs.length ? mgrs.charCodeAt(i) : 0x20;
    }
    // cog_url_idx: u16
    view.setUint16(42, cogUrlIdx || 0, true);

    return new Uint8Array(buf);
}

export function decodeDetection(buf, offset, stringTable) {
    const view = new DataView(buf.buffer || buf, buf.byteOffset ? buf.byteOffset + offset : offset);

    const days = view.getUint16(0, true);
    const dateMs = EPOCH + days * MS_PER_DAY;
    const d = new Date(dateMs);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    const sunEl = view.getInt8(18);

    let mgrs = '';
    const base = buf.byteOffset ? buf.byteOffset + offset : offset;
    const rawBuf = buf.buffer || buf;
    const u8 = new Uint8Array(rawBuf);
    for (let i = 0; i < 5; i++) {
        const c = u8[base + 37 + i];
        if (c !== 0x20) mgrs += String.fromCharCode(c);
    }

    const cogUrlIdx = view.getUint16(42, true);

    return {
        date,
        max_b12: view.getUint16(2, true) / 10000,
        avg_b12: view.getUint16(4, true) / 10000,
        pixels: view.getUint16(6, true),
        flare_lon: view.getFloat32(8, true),
        flare_lat: view.getFloat32(12, true),
        epsg: view.getUint16(16, true),
        sun_elevation: sunEl === -128 ? null : sunEl,
        utm_bounds: [
            view.getFloat32(19, true),
            view.getFloat32(23, true),
            view.getFloat32(27, true),
            view.getFloat32(31, true)
        ],
        block_row: u8[base + 35],
        block_col: u8[base + 36],
        mgrs,
        cog_b12: stringTable ? stringTable[cogUrlIdx] || null : null
    };
}

// ---------------------------------------------------------------------------
// String table (COG URL dedup)
// ---------------------------------------------------------------------------

export function encodeStringTable(strings) {
    // [u16 count][u16 len, UTF-8 bytes]...
    const encoder = new TextEncoder();
    const encoded = strings.map(s => encoder.encode(s));
    let totalLen = 2; // count
    for (const e of encoded) totalLen += 2 + e.length;

    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);
    view.setUint16(0, strings.length, true);

    let pos = 2;
    for (const e of encoded) {
        view.setUint16(pos, e.length, true);
        pos += 2;
        buf.set(e, pos);
        pos += e.length;
    }
    return buf;
}

export function decodeStringTable(buf, offset = 0) {
    const view = new DataView(buf.buffer || buf, buf.byteOffset ? buf.byteOffset + offset : offset);
    const count = view.getUint16(0, true);
    const decoder = new TextDecoder();
    const strings = [];

    let pos = 2;
    for (let i = 0; i < count; i++) {
        const len = view.getUint16(pos, true);
        pos += 2;
        const base = buf.byteOffset ? buf.byteOffset + offset + pos : offset + pos;
        const rawBuf = buf.buffer || buf;
        strings.push(decoder.decode(new Uint8Array(rawBuf, base, len)));
        pos += len;
    }
    return { strings, bytesRead: pos };
}

// ---------------------------------------------------------------------------
// State vector encoding
// ---------------------------------------------------------------------------
// [u32 detCount][9B key, u32 ts, u16 peerId]... [u32 procCount][9B key, u32 ts, u16 peerId]...

const SV_ENTRY_SIZE = 9 + 4 + 2; // 15 bytes per entry

export function encodeStateVector(detMap, procMap) {
    const detSize = detMap.size;
    const procSize = procMap.size;
    const totalLen = 4 + detSize * SV_ENTRY_SIZE + 4 + procSize * SV_ENTRY_SIZE;
    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);

    let pos = 0;
    view.setUint32(pos, detSize, true); pos += 4;

    detMap._entries.forEach((entry, key) => {
        buf.set(encodeKey(key), pos); pos += 9;
        // Truncate ts to u32 (seconds since some epoch — use lower 32 bits of ms)
        view.setUint32(pos, (entry.ts / 1000) >>> 0, true); pos += 4;
        view.setUint16(pos, entry.peerId, true); pos += 2;
    });

    view.setUint32(pos, procSize, true); pos += 4;

    procMap._entries.forEach((entry, key) => {
        buf.set(encodeKey(key), pos); pos += 9;
        view.setUint32(pos, (entry.ts / 1000) >>> 0, true); pos += 4;
        view.setUint16(pos, entry.peerId, true); pos += 2;
    });

    return buf;
}

export function decodeStateVector(buf) {
    const view = new DataView(buf.buffer || buf, buf.byteOffset || 0);
    const u8 = new Uint8Array(buf.buffer || buf);
    const baseOffset = buf.byteOffset || 0;
    const entries = { det: new Map(), proc: new Map() };

    let pos = 0;
    const detCount = view.getUint32(pos, true); pos += 4;
    for (let i = 0; i < detCount; i++) {
        const { key } = decodeKey(u8, baseOffset + pos); pos += 9;
        const ts = view.getUint32(pos, true); pos += 4;
        const peerId = view.getUint16(pos, true); pos += 2;
        entries.det.set(key, { ts, peerId });
    }

    const procCount = view.getUint32(pos, true); pos += 4;
    for (let i = 0; i < procCount; i++) {
        const { key } = decodeKey(u8, baseOffset + pos); pos += 9;
        const ts = view.getUint32(pos, true); pos += 4;
        const peerId = view.getUint16(pos, true); pos += 2;
        entries.proc.set(key, { ts, peerId });
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Entry encoding (for STATE_DIFF and LIVE_UPDATE)
// ---------------------------------------------------------------------------
// [stringTable][u32 count][per entry: u8 mapType(0=det,1=proc), 9B key, u32 ts, u16 peerId, payload]
// Detection payload: u16 detCount, [44B detection]...
// Processed payload: i16 lat×100, i16 lng×100 (block center, ~1.1 km precision)

export function encodeEntries(keys, detMap, procMap) {
    // Build string table from all COG URLs
    const urlToIdx = new Map();
    const urls = [];

    // Collect entries to encode
    const items = [];
    for (const { mapName, key } of keys) {
        const map = mapName === 'det' ? detMap : procMap;
        const entry = map.getEntry(key);
        if (!entry) continue;

        if (mapName === 'det' && Array.isArray(entry.value)) {
            for (const det of entry.value) {
                const url = det.cog_b12 || '';
                if (url && !urlToIdx.has(url)) {
                    urlToIdx.set(url, urls.length);
                    urls.push(url);
                }
            }
        }
        items.push({ mapName, key, entry });
    }

    const strTable = encodeStringTable(urls);

    // Calculate total size
    let payloadSize = 0;
    for (const { mapName, entry } of items) {
        payloadSize += 1 + 9 + 4 + 2; // mapType + key + ts + peerId
        if (mapName === 'det' && Array.isArray(entry.value)) {
            payloadSize += 2 + entry.value.length * 44;
        } else {
            payloadSize += 4; // processed [lat, lng] packed as 2x i16
        }
    }

    const totalLen = strTable.length + 4 + payloadSize;
    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);

    // Write string table
    buf.set(strTable, 0);
    let pos = strTable.length;

    // Write entry count
    view.setUint32(pos, items.length, true); pos += 4;

    // Write entries
    for (const { mapName, key, entry } of items) {
        buf[pos] = mapName === 'det' ? 0 : 1; pos += 1;
        buf.set(encodeKey(key), pos); pos += 9;
        view.setUint32(pos, (entry.ts / 1000) >>> 0, true); pos += 4;
        view.setUint16(pos, entry.peerId, true); pos += 2;

        if (mapName === 'det' && Array.isArray(entry.value)) {
            const dets = entry.value;
            view.setUint16(pos, dets.length, true); pos += 2;
            for (const det of dets) {
                const idx = urlToIdx.get(det.cog_b12 || '') ?? 0;
                buf.set(encodeDetection(det, idx), pos);
                pos += 44;
            }
        } else {
            // processed: store [lat, lng] packed as 2x i16 (×100, ~1.1 km precision)
            const [lat, lng] = Array.isArray(entry.value) ? entry.value : [0, 0];
            view.setInt16(pos, Math.round(lat * 100), true); pos += 2;
            view.setInt16(pos, Math.round(lng * 100), true); pos += 2;
        }
    }

    return buf;
}

export function decodeEntries(buf) {
    const u8 = new Uint8Array(buf.buffer || buf);
    const baseOffset = buf.byteOffset || 0;
    const view = new DataView(buf.buffer || buf, baseOffset);

    // Read string table
    const { strings, bytesRead: stBytes } = decodeStringTable(u8, baseOffset);
    let pos = stBytes;

    const count = view.getUint32(pos, true); pos += 4;
    const entries = [];

    for (let i = 0; i < count; i++) {
        const mapType = u8[baseOffset + pos]; pos += 1;
        const mapName = mapType === 0 ? 'det' : 'proc';
        const { key } = decodeKey(u8, baseOffset + pos); pos += 9;
        const ts = view.getUint32(pos, true) * 1000; pos += 4;
        const peerId = view.getUint16(pos, true); pos += 2;

        let value;
        if (mapName === 'det') {
            const detCount = view.getUint16(pos, true); pos += 2;
            value = [];
            for (let j = 0; j < detCount; j++) {
                value.push(decodeDetection(u8, baseOffset + pos, strings));
                pos += 44;
            }
        } else {
            const lat = view.getInt16(pos, true) / 100; pos += 2;
            const lng = view.getInt16(pos, true) / 100; pos += 2;
            value = [lat, lng];
        }

        entries.push({ mapName, key, value, ts, peerId });
    }

    return entries;
}

