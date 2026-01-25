/**
 * Burnoff Scanner
 *
 * Orchestrates client-side flare detection:
 * 1. Searches STAC API for Sentinel-2 scenes
 * 2. Spawns web workers for parallel detection
 * 3. Caches results locally (IndexedDB)
 * 4. Syncs with central cache API
 */

const STAC_API = 'https://earth-search.aws.element84.com/v1';
const CACHE_API_URL = null; // Set to your Cloudflare Worker URL when deployed

// Detection settings
const BUFFER_M = 6000; // Search radius around point
const MAX_CLOUD_COVER = 30;
const MAX_WORKERS = 4;
const SCAN_TRIGGER_ZOOM = 14;

/**
 * Scanner class - manages detection workflow
 */
class Scanner {
  constructor(options = {}) {
    this.cacheApiUrl = options.cacheApiUrl || CACHE_API_URL;
    this.maxWorkers = options.maxWorkers || MAX_WORKERS;
    this.bufferM = options.bufferM || BUFFER_M;
    this.maxCloudCover = options.maxCloudCover || MAX_CLOUD_COVER;

    this.workers = [];
    this.workerQueue = [];
    this.activeScans = new Map(); // tileId+date -> promise
    this.scanProgress = { total: 0, completed: 0, detections: 0 };
    this.isScanning = false;
    this.abortController = null;

    this.onProgress = null;
    this.onDetection = null;
    this.onComplete = null;
    this.onError = null;

    this._initWorkers();
    this._initCache();
  }

  _initWorkers() {
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker('detect-worker.js');
      worker.onmessage = (e) => this._handleWorkerMessage(e, worker);
      worker.onerror = (e) => this._handleWorkerError(e, worker);
      worker.busy = false;
      this.workers.push(worker);
    }
  }

  async _initCache() {
    // Initialize IndexedDB for local caching
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('burnoff-cache', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Scanned tiles store
        if (!db.objectStoreNames.contains('scanned')) {
          const store = db.createObjectStore('scanned', { keyPath: 'key' });
          store.createIndex('tileId', 'tileId');
          store.createIndex('date', 'date');
        }

        // Detections store
        if (!db.objectStoreNames.contains('detections')) {
          const store = db.createObjectStore('detections', { keyPath: 'id', autoIncrement: true });
          store.createIndex('tileId', 'tileId');
          store.createIndex('date', 'date');
          store.createIndex('coords', ['lon', 'lat']);
        }
      };
    });
  }

  /**
   * Search STAC API for Sentinel-2 L2A images.
   */
  async searchSTAC(lat, lon, startDate, endDate) {
    const bufferDeg = 0.05;
    const bbox = [lon - bufferDeg, lat - bufferDeg, lon + bufferDeg, lat + bufferDeg];

    const payload = {
      collections: ['sentinel-2-l2a'], // Use L2A COGs (browser-friendly)
      bbox,
      datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
      limit: 100,
      query: { 'eo:cloud_cover': { lt: this.maxCloudCover } },
    };

    const items = [];
    let url = `${STAC_API}/search`;

    while (url) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.abortController?.signal,
      });

      if (!response.ok) throw new Error(`STAC search failed: ${response.status}`);

      const data = await response.json();
      items.push(...(data.features || []));

      // Handle pagination
      const nextLink = data.links?.find(l => l.rel === 'next');
      if (nextLink?.body) {
        url = nextLink.href;
        Object.assign(payload, nextLink.body);
      } else {
        url = null;
      }
    }

    return items;
  }

  /**
   * Check if a tile+date has been scanned locally.
   */
  async isScanned(tileId, date) {
    if (!this.db) await this._initCache();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('scanned', 'readonly');
      const store = tx.objectStore('scanned');
      const request = store.get(`${tileId}_${date}`);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mark a tile+date as scanned.
   */
  async markScanned(tileId, date, imageHash, detectionsCount) {
    if (!this.db) await this._initCache();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('scanned', 'readwrite');
      const store = tx.objectStore('scanned');
      store.put({
        key: `${tileId}_${date}`,
        tileId,
        date,
        imageHash,
        detectionsCount,
        scannedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Store a detection locally.
   */
  async storeDetection(detection) {
    if (!this.db) await this._initCache();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('detections', 'readwrite');
      const store = tx.objectStore('detections');
      store.add(detection);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get cached detections for a location.
   */
  async getCachedDetections(tileId) {
    if (!this.db) await this._initCache();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('detections', 'readonly');
      const store = tx.objectStore('detections');
      const index = store.index('tileId');
      const request = index.getAll(tileId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Submit scan results to central cache.
   */
  async submitToCache(tileId, date, imageHash, detections, cogUrl, epsg) {
    if (!this.cacheApiUrl) return;

    try {
      const response = await fetch(`${this.cacheApiUrl}/scan-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tile_id: tileId,
          date,
          image_hash: imageHash,
          detections,
          cog_url: cogUrl,
          epsg,
        }),
      });

      if (!response.ok) {
        console.warn('Cache submission failed:', response.status);
      }
    } catch (err) {
      console.warn('Cache submission error:', err);
    }
  }

  /**
   * Get an available worker or queue the task.
   */
  _getWorker() {
    const worker = this.workers.find(w => !w.busy);
    return worker || null;
  }

  _handleWorkerMessage(e, worker) {
    worker.busy = false;
    const { type, detections, imageHash, tileId, date, cogUrl, epsg, message } = e.data;

    if (type === 'result') {
      this.scanProgress.completed++;

      // Store locally
      this.markScanned(tileId, date, imageHash, detections.length);

      for (const det of detections) {
        this.scanProgress.detections++;
        const detection = {
          tileId,
          date,
          ...det,
          cogUrl,
          epsg,
          source: 'client',
        };
        this.storeDetection(detection);
        if (this.onDetection) this.onDetection(detection);
      }

      // Submit to central cache
      this.submitToCache(tileId, date, imageHash, detections, cogUrl, epsg);

      if (this.onProgress) {
        this.onProgress({ ...this.scanProgress });
      }

      // Resolve pending promise
      const key = `${tileId}_${date}`;
      if (this.activeScans.has(key)) {
        this.activeScans.get(key).resolve({ detections, imageHash });
        this.activeScans.delete(key);
      }

      // Process next in queue
      this._processQueue();
    } else if (type === 'error') {
      console.error('Worker error:', message);
      this.scanProgress.completed++;

      const key = `${tileId}_${date}`;
      if (this.activeScans.has(key)) {
        this.activeScans.get(key).reject(new Error(message));
        this.activeScans.delete(key);
      }

      if (this.onProgress) {
        this.onProgress({ ...this.scanProgress });
      }

      this._processQueue();
    }

    // Check if scan is complete
    if (this.scanProgress.completed >= this.scanProgress.total && this.isScanning) {
      this.isScanning = false;
      if (this.onComplete) this.onComplete({ ...this.scanProgress });
    }
  }

  _handleWorkerError(e, worker) {
    console.error('Worker fatal error:', e);
    worker.busy = false;
    this._processQueue();
  }

  _processQueue() {
    if (this.workerQueue.length === 0) return;

    const worker = this._getWorker();
    if (!worker) return;

    const task = this.workerQueue.shift();
    worker.busy = true;
    worker.postMessage(task);
  }

  /**
   * Queue a detection task.
   */
  _queueDetection(cogUrl, bounds, epsg, tileId, date) {
    const key = `${tileId}_${date}`;

    // Already processing?
    if (this.activeScans.has(key)) {
      return this.activeScans.get(key).promise;
    }

    // Create promise for this scan
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.activeScans.set(key, { promise, resolve, reject });

    const task = { type: 'detect', cogUrl, bounds, epsg, tileId, date };

    const worker = this._getWorker();
    if (worker) {
      worker.busy = true;
      worker.postMessage(task);
    } else {
      this.workerQueue.push(task);
    }

    return promise;
  }

  /**
   * Compute UTM bounds for a lat/lon point.
   */
  _computeUtmBounds(lat, lon, epsg) {
    // Simple approximation: 1 degree ≈ 111km at equator
    // For UTM, we need to project to the zone
    const zone = epsg % 100;
    const isNorth = epsg < 32700;

    // Central meridian
    const lon0 = (zone - 1) * 6 - 180 + 3;

    // Approximate UTM coordinates using simplified formulas
    const k0 = 0.9996;
    const a = 6378137;

    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    const lon0Rad = lon0 * Math.PI / 180;

    const N = a / Math.sqrt(1 - 0.00669438 * Math.sin(latRad) * Math.sin(latRad));
    const T = Math.tan(latRad) * Math.tan(latRad);
    const C = 0.00669438 / (1 - 0.00669438) * Math.cos(latRad) * Math.cos(latRad);
    const A = Math.cos(latRad) * (lonRad - lon0Rad);

    const x = k0 * N * (A + (1-T+C)*A*A*A/6) + 500000;

    const M = a * ((1 - 0.00669438/4 - 3*0.00669438*0.00669438/64) * latRad
              - (3*0.00669438/8 + 3*0.00669438*0.00669438/32) * Math.sin(2*latRad)
              + (15*0.00669438*0.00669438/256) * Math.sin(4*latRad));
    const y = k0 * (M + N * Math.tan(latRad) * (A*A/2)) + (isNorth ? 0 : 10000000);

    return [
      x - this.bufferM,
      y - this.bufferM,
      x + this.bufferM,
      y + this.bufferM,
    ];
  }

  /**
   * Start scanning for a location.
   * Fetches scenes from STAC and queues detection tasks.
   */
  async scan(lat, lon, options = {}) {
    const {
      startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      endDate = new Date().toISOString().slice(0, 10),
      onProgress,
      onDetection,
      onComplete,
      onError,
    } = options;

    this.onProgress = onProgress;
    this.onDetection = onDetection;
    this.onComplete = onComplete;
    this.onError = onError;

    this.isScanning = true;
    this.abortController = new AbortController();
    this.scanProgress = { total: 0, completed: 0, detections: 0 };

    try {
      // Search for scenes
      const items = await this.searchSTAC(lat, lon, startDate, endDate);

      // Sort by date descending (newest first)
      items.sort((a, b) => b.properties.datetime.localeCompare(a.properties.datetime));

      // Filter to scenes we haven't scanned yet
      const toScan = [];
      for (const item of items) {
        const tileId = item.properties['s2:mgrs_tile'] || 'unknown';
        const date = item.properties.datetime.slice(0, 10);

        // Check local cache
        const alreadyScanned = await this.isScanned(tileId, date);
        if (!alreadyScanned) {
          toScan.push({ item, tileId, date });
        }
      }

      this.scanProgress.total = toScan.length;

      if (toScan.length === 0) {
        this.isScanning = false;
        if (onComplete) onComplete({ ...this.scanProgress, cached: true });
        return;
      }

      if (onProgress) onProgress({ ...this.scanProgress });

      // Queue detection tasks
      for (const { item, tileId, date } of toScan) {
        const epsg = item.properties['proj:epsg'];
        const cogUrl = item.assets?.swir22?.href || item.assets?.B12?.href;

        if (!cogUrl || !epsg) {
          this.scanProgress.completed++;
          continue;
        }

        const bounds = this._computeUtmBounds(lat, lon, epsg);

        // Don't await - let them run in parallel
        this._queueDetection(cogUrl, bounds, epsg, tileId, date).catch(err => {
          if (onError) onError(err);
        });
      }
    } catch (err) {
      this.isScanning = false;
      if (onError) onError(err);
      throw err;
    }
  }

  /**
   * Stop scanning.
   */
  abort() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isScanning = false;
    this.workerQueue = [];
    this.workers.forEach(w => w.busy = false);
  }

  /**
   * Clean up workers.
   */
  destroy() {
    this.abort();
    this.workers.forEach(w => w.terminate());
    this.workers = [];
  }
}

// Export for use in app.js
window.Scanner = Scanner;
window.SCAN_TRIGGER_ZOOM = SCAN_TRIGGER_ZOOM;
