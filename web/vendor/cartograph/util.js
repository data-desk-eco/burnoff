// shared helpers: formatting, geometry, and the pure logic behind filters and
// permalinks (kept dom-free so node can test them)

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const haversineM = (...a) => haversineKm(...a) * 1000;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function fmtMetres(m) {
    if (m == null) return '?';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function fmtCoords(lat, lon) {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, `
         + `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

// the data table's row math: viewport filter (bounds = [w, s, e, n]; rows
// without a lat pass), substring search over cols, null-last sort, cap
export function tableRows(all, { cols, bounds, q, sortCol, sortDir = 1, cap = 500, lat = 'lat', lon = 'lon' }) {
    const rows = all.filter(r =>
        (!bounds || r[lat] == null ||
            (r[lat] >= bounds[1] && r[lat] <= bounds[3] && r[lon] >= bounds[0] && r[lon] <= bounds[2]))
        && (!q || cols.some(c => String(r[c] ?? '').toLowerCase().includes(q))));
    if (sortCol) rows.sort((a, b) => {
        const x = a[sortCol], y = b[sortCol];
        return x == null ? 1 : y == null ? -1 : (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    return { rows: rows.slice(0, cap), total: rows.length };
}

// expand a bbox to at least `min` degrees per axis (centered). availability
// tests on a razor-thin zoomed-in viewport otherwise flip the moment you sit
// between features; a ~3 km floor makes them reflect the surrounding area
export function padBbox([w, s, e, n], min = 0.03) {
    const dw = Math.max(0, (min - (e - w)) / 2), dh = Math.max(0, (min - (n - s)) / 2);
    return [w - dw, s - dh, e + dw, n + dh];
}

// [w, s, e, n] of a polygon / multipolygon feature
export function featureBbox(f) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const [x, y] of f.geometry.coordinates.flat(f.geometry.type === 'MultiPolygon' ? 2 : 1)) {
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
    return [w, s, e, n];
}

// the quarter picker's date math: keys are "2025_3" strings

// {startDate, endDate} spanning the given quarter keys, or null when empty
export function quarterRange(keys) {
    let start = null, end = null;
    for (const k of keys) {
        const [y, q] = String(k).split('_').map(Number);
        const s = `${y}-${String(q * 3 - 2).padStart(2, '0')}-01`;
        const e = `${y}-${String(q * 3).padStart(2, '0')}-${new Date(y, q * 3, 0).getDate()}`;
        if (!start || s < start) start = s;
        if (!end || e > end) end = e;
    }
    return start ? { startDate: start, endDate: end } : null;
}

export const quarterOf = dateStr =>
    `${dateStr.slice(0, 4)}_${Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1}`;

// true when the date falls in one of the quarter keys (empty set = no window)
export const dateInQuarters = (dateStr, keys) => !keys.size || keys.has(quarterOf(dateStr));

// ── declarative config tier ──
// a config may be pure data (a json manifest): compileConfig gives the common
// fields their function equivalents so simple maps ship no js at all.

// {prop} string templates: values interpolate escaped (esc) or raw for
// plain-text slots that are escaped downstream
export const tpl = (t, esc = escapeHtml) => p => t.replace(/\{(\w+)\}/g, (_, k) => esc(p[k] ?? '—'));

// string hover/detail templates, `prop` shorthands for filter/key equality
// predicates, sources defaulted from the data files (SELECT *), table rows
// named by source id
export function compileConfig(config) {
    for (const l of config.layers || [])
        if (typeof l.hover === 'string') l.hover = tpl(l.hover);
    for (const f of config.filters || [])
        if (!f.pred && f.prop) f.pred = v => v === (f.value ?? 'all') ? null : p => String(p[f.prop]) === v;
    const d = config.detail;
    if (typeof d?.title === 'string') { const t = tpl(d.title, String); d.title = p => ({ text: t(p) }); }
    if (typeof d?.html === 'string') d.html = tpl(d.html);
    if (config.key && typeof config.key !== 'function') {
        for (const s of config.key) for (const r of s.rows)
            if (!r.pred && r.prop) r.pred = p => String(p[r.prop]) === String(r.value ?? r.label);
        const sections = config.key;
        config.key = () => sections;
    }
    for (const t of config.table || [])
        if (typeof t.rows === 'string') { const id = t.rows; t.rows = ctx => ctx.sources[id].features.map(f => f.properties); }
    config.sources ??= async ({ query, need, fc }) => {
        const names = Object.keys(config.data?.files || {});
        await need(...names);
        const out = {};
        for (const n of names) out[n] = fc(await query(`SELECT * FROM '${n}.parquet'`));
        return out;
    };
    return config;
}

// #<key>=<id> permalinks, coexisting with maplibre's #map= hash
export function getHashParam(hash, key) {
    const m = hash.match(new RegExp(`${key}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : null;
}

export function setHashParam(hash, key, id) {
    const rest = hash.replace(/^#/, '').split('&').filter(p => p && !p.startsWith(`${key}=`));
    if (id != null) rest.push(`${key}=${encodeURIComponent(id)}`);
    return rest.length ? '#' + rest.join('&') : '';
}
