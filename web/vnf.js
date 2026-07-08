// VNF (VIIRS Nightfire) data module — queries a Parquet file (local or remote)
// via vendored DuckDB-WASM. Zero npm dependencies.

import { openDuckDB } from './duckdb.js';

let conn = null;
let _initPromise = null;
let _ready = false;
let _parquetUrl = null;

export function isReady() { return _ready; }

/**
 * Initialize DuckDB-WASM and register the VNF parquet file.
 * @param {string} url - URL or local path to the parquet file
 */
export async function initVNF(url) {
    if (_initPromise) return _initPromise;
    _parquetUrl = url;
    _initPromise = _init(url);
    return _initPromise;
}

/** Reset state so initVNF can be called again with a different URL. */
export function resetVNF() {
    _initPromise = null;
    _ready = false;
    _parquetUrl = null;
    conn = null;
}

async function _init(url) {
    ({ conn } = await openDuckDB(url));
    _ready = true;
}

// Per-site aggregation shared by the viewport and single-flare queries: daily
// rows grouped to one row per flare with clear/detected counts and an ordered
// detection list.
const siteQuery = where => `
    SELECT
        flare_id,
        FIRST(lat) AS lat,
        FIRST(lon) AS lon,
        COUNT(*) AS total_dates,
        COUNT(*) FILTER (WHERE clear) AS clear_dates,
        COUNT(*) FILTER (WHERE detected) AS detection_dates,
        AVG(rh_mw) FILTER (WHERE detected) AS avg_rh,
        MAX(rh_mw) FILTER (WHERE detected) AS max_rh,
        FIRST(type) FILTER (WHERE type != '') AS type,
        FIRST(category) FILTER (WHERE category != '') AS category,
        FIRST(country) FILTER (WHERE country != '') AS country,
        FIRST(facility_type) FILTER (WHERE facility_type != '') AS facility_type,
        FIRST(facility_name) FILTER (WHERE facility_name != '') AS facility_name,
        LIST(struct_pack(
            date := CAST(date AS VARCHAR),
            rh_mw := rh_mw,
            temp_k := temp_k
        ) ORDER BY date) FILTER (WHERE detected) AS detections
    FROM '${_parquetUrl}'
    WHERE ${where}
    GROUP BY flare_id`;

// Map a duckdb result to GeoJSON features (arrow rows/lists → plain objects)
function rowFeatures(result) {
    const features = [];
    for (let i = 0; i < result.numRows; i++) {
        const row = result.get(i);

        const detections = [];
        const rawDets = row.detections;
        if (rawDets) {
            for (let j = 0; j < rawDets.length; j++) {
                const d = typeof rawDets.get === 'function' ? rawDets.get(j) : rawDets[j];
                if (!d) continue;
                const obj = typeof d.toJSON === 'function' ? d.toJSON() : d;
                detections.push({
                    date: formatDuckDate(obj.date),
                    rh_mw: Number(obj.rh_mw) || 0,
                    temp_k: Number(obj.temp_k) || 0
                });
            }
        }

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(row.lon), Number(row.lat)] },
            properties: {
                flare_id: Number(row.flare_id),
                type: String(row.type || ''),
                category: String(row.category || ''),
                country: String(row.country || ''),
                facility_type: String(row.facility_type || ''),
                facility_name: String(row.facility_name || ''),
                total_dates: Number(row.total_dates) || 0,
                clear_dates: Number(row.clear_dates) || 0,
                detection_dates: Number(row.detection_dates) || 0,
                avg_rh: Number(row.avg_rh),
                max_rh: Number(row.max_rh),
                detections
            }
        });
    }
    return { type: 'FeatureCollection', features };
}

/**
 * Query VNF sites within a bounding box and date range.
 * Returns a GeoJSON FeatureCollection with per-site aggregated data.
 */
export async function queryVNF(bbox, startDate, endDate) {
    if (!conn) throw new Error('VNF not initialized');
    const [west, south, east, north] = bbox;
    const result = await conn.query(siteQuery(`
            lat BETWEEN ${south} AND ${north}
        AND lon BETWEEN ${west} AND ${east}
        AND date BETWEEN '${startDate}' AND '${endDate}'`) + `
        HAVING COUNT(*) FILTER (WHERE detected) > 0
        ORDER BY max_rh DESC`);
    return rowFeatures(result);
}

/**
 * Query a single VNF flare by ID (for deep links).
 * Returns a GeoJSON FeatureCollection with 0 or 1 features.
 */
export async function queryVNFFlare(flareId, startDate, endDate) {
    if (!conn) throw new Error('VNF not initialized');
    const result = await conn.query(siteQuery(`
            flare_id = ${Number(flareId)}
        AND date BETWEEN '${startDate}' AND '${endDate}'`));
    return rowFeatures(result);
}

/** Set of `year_quarter` keys with any detection in the viewport over [start,end]. */
export async function availableQuartersVNF(bbox, startDate, endDate) {
    if (!conn) return new Set();
    const [west, south, east, north] = bbox;
    const result = await conn.query(`
        SELECT DISTINCT year(date) AS y, quarter(date) AS q
        FROM '${_parquetUrl}'
        WHERE detected
          AND lat BETWEEN ${south} AND ${north}
          AND lon BETWEEN ${west} AND ${east}
          AND date BETWEEN '${startDate}' AND '${endDate}'`);
    const qs = new Set();
    for (let i = 0; i < result.numRows; i++) {
        const r = result.get(i);
        qs.add(`${Number(r.y)}_${Number(r.q)}`);
    }
    return qs;
}

/** Format a DuckDB date value to YYYY-MM-DD string */
function formatDuckDate(d) {
    if (typeof d === 'string') return d.slice(0, 10);
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    if (typeof d === 'number' || typeof d === 'bigint') {
        return new Date(Number(d) * 86400000).toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
