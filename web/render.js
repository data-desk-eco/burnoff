// Mode config + colour/radius/legend rendering — the single source of truth for
// how detections look in each mode. Pure given a mode config object; magma lives in
// map-style.js. app.js holds currentMode and the slider state and feeds them in.

import { magmaColor, magmaHex } from './map-style.js';

export const RH_TO_MCM = 0.0315;

export const MODE = {
    s2: {
        subtitle: 'Sentinel-2 flare detection',
        label: 'B12 reflectance',
        prop: 'max_b12',
        col2: 'B12', col3: 'px',
        stops: [0.9, 1.15, 1.5],
        log: false,
        chartRange: [0.85, 1.6],
        filter: { min: 0, max: 1.5, step: 0.05, default: 0.85 },
        formatFilter: v => v === 0 ? 'Off' : v.toFixed(2).replace(/^0\./, '.'),
        yVal: d => d.b12_corrected,
        formatVal: d => d.max_b12?.toFixed(2) || '-',
        formatCount: d => String(d.pixels || '-'),
        sentinel: null,
        // Radius: linear in value, zoom-dependent [base, multiplier]
        radiusZooms: [[0, 4, 4], [6, 6, 6], [10, 10, 8], [14, 12, 10]],
    },
    vnf: {
        subtitle: 'VIIRS Nightfire flares',
        label: 'Radiant heat (MW)',
        prop: 'max_rh',
        col2: 'RH', col3: 'MCM/d',
        stops: [1, 7, 20],
        log: true,
        chartRange: [0.5, 50],
        filter: { min: 0, max: 10, step: 0.5, default: 3 },
        formatFilter: v => v === 0 ? 'Off' : `${v} MW`,
        yVal: d => d.rh_mw || 0,
        formatVal: d => d.rh_mw >= 999 ? '-' : (d.rh_mw?.toFixed(1) || '-'),
        formatCount: d => d.rh_mw >= 999 ? '-' : (d.rh_mw != null ? (d.rh_mw * RH_TO_MCM).toFixed(2) : '-'),
        sentinel: 999,
        // Radius: log in value, zoom-dependent [base, multiplier, cap]
        radiusZooms: [[0, 4, 2, 8], [6, 6, 3, 12], [10, 8, 4, 14], [14, 10, 5, 16]],
    }
};

// Normalize value to 0→1 on the mode's color scale (stops[0]→stops[2])
export function scaleT(cfg, val) {
    const [lo, , hi] = cfg.stops;
    const raw = cfg.log
        ? Math.log(Math.max(lo, val) / lo) / Math.log(hi / lo)
        : (val - lo) / (hi - lo);
    // Map into [0.3, 1.0] of the magma ramp for visibility
    return 0.3 + Math.max(0, Math.min(1, raw)) * 0.7;
}

export function scaleColor(cfg, val) {
    const [r, g, b] = magmaColor(scaleT(cfg, val));
    return `rgb(${r},${g},${b})`;
}

// Normalize value to 0→1 on the chart y-axis (wider than color stops)
export function chartNorm(cfg, val) {
    const [lo, hi] = cfg.chartRange;
    if (cfg.log) return (Math.log(Math.max(lo, val)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    return (val - lo) / (hi - lo);
}

// Build MapLibre color interpolation expression from config
export function buildColorExpr(cfg) {
    const prop = ['coalesce', ['get', cfg.prop], cfg.stops[0]];
    const expr = cfg.log
        ? ['interpolate', ['linear'], ['ln', ['+', prop, 1]]]
        : ['interpolate', ['linear'], prop];
    for (const stop of cfg.stops) {
        if (cfg.log) expr.push(Math.log(stop + 1));
        else expr.push(stop);
        expr.push(magmaHex(scaleT(cfg, stop)));
    }
    return expr;
}

// Build MapLibre radius expression from config
export function buildRadiusExpr(cfg) {
    const prop = ['coalesce', ['get', cfg.prop], cfg.log ? 1 : 0];
    const scaled = cfg.log ? ['ln', ['+', prop, 1]] : prop;
    const expr = ['interpolate', ['exponential', 1.5], ['zoom']];
    for (const z of cfg.radiusZooms) {
        if (cfg.log) {
            const [zoom, base, mult, cap] = z;
            expr.push(zoom, ['+', base, ['min', cap, ['*', scaled, mult]]]);
        } else {
            const [zoom, base, mult] = z;
            expr.push(zoom, ['+', base, ['*', scaled, mult]]);
        }
    }
    return expr;
}

// Build legend HTML from config; ogimVisible toggles the OGIM sub-items.
export function buildLegendHTML(cfg, ogimVisible) {
    const stops = [...cfg.stops].reverse(); // high to low
    const items = stops.map((v, i) => {
        const label = i === 0 ? `${v}+` : String(v);
        return `<div class="legend-item"><div class="legend-circle" style="border-color: ${magmaHex(scaleT(cfg, v))}"></div>${label}</div>`;
    }).join('\n            ');
    return `
            <h4 class="label-sm">${cfg.label}</h4>
            ${items}
            <h4 class="label-sm legend-section">Infrastructure</h4>
            <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="1" y1="1" x2="9" y2="9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>LNG</div>
            <label class="legend-item ogim-toggle-row">
                <input type="checkbox" id="ogim-toggle"${ogimVisible ? ' checked' : ''}>
                <span>OGIM</span>
            </label>
            <div class="ogim-sub-items" id="ogim-legend-items" style="display:${ogimVisible ? '' : 'none'}">
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="0" y1="5" x2="10" y2="5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/></svg>Pipelines</div>
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><polygon points="5,1 9,5 5,9 1,5" fill="rgba(255,200,100,0.8)"/></svg>Facilities</div>
                <div class="legend-item"><svg width="10" height="10" style="margin-right: 10px; flex-shrink: 0"><line x1="2" y1="2" x2="8" y2="8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="2" x2="2" y2="8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>Wells</div>
            </div>
        `;
}

// Pre-built expressions (regenerated from config)
export const s2ColorExpr = buildColorExpr(MODE.s2);
export const vnfColorExpr = buildColorExpr(MODE.vnf);
export const s2RadiusExpr = buildRadiusExpr(MODE.s2);
export const vnfRadiusExpr = buildRadiusExpr(MODE.vnf);

export function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}
