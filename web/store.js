// ---------------------------------------------------------------------------
// IndexedDB Persistence for LWW-Map
// ---------------------------------------------------------------------------

const DB_NAME = 'burnoff-crdt';
const STORE_NAME = 'entries';
export class Store {
    constructor(dbName = DB_NAME) {
        this._dbName = dbName;
        this._db = null;
        this._dirty = new Map(); // key -> { prefix, value, ts, peerId }
    }

    async open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this._dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => {
                this._db = req.result;
                resolve();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async loadAll(detMap, procMap) {
        if (!this._db) return;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.openCursor();

            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(); return; }

                const idbKey = cursor.key;
                const { value, ts, peerId } = cursor.value;

                if (typeof idbKey === 'string' && idbKey.length > 2) {
                    const prefix = idbKey[0];
                    const mapKey = idbKey.substring(2);
                    if (prefix === 'd') {
                        detMap.merge(mapKey, value, ts, peerId);
                    } else if (prefix === 'p') {
                        procMap.merge(mapKey, value, ts, peerId);
                    }
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    put(mapName, key, value, ts, peerId) {
        const prefix = mapName === 'det' ? 'd' : 'p';
        const idbKey = `${prefix}:${key}`;
        this._dirty.set(idbKey, { value, ts, peerId });
        // Flush immediately — iOS WebKit kills pages too fast for batching
        this._flush();
    }

    flush() { this._flush(); }

    _flush() {
        if (!this._db || this._dirty.size === 0) return;
        const entries = Array.from(this._dirty.entries());
        this._dirty.clear();

        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const [idbKey, data] of entries) {
            store.put(data, idbKey);
        }
    }

    async clear() {
        if (!this._db) return;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
}
