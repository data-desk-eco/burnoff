// Mode config + marking/colour/key builders — the single source of truth for how
// detections look in each mode. Colours come from the data desk cartography palette
// (vendor/dd); detections render as the 'flare' marking stepped through the
// red→orange→white intensity ramp (guidelines pdf:85 key). app.js holds currentMode
// and the slider state and feeds them in.

import { map as ddPalette } from './vendor/dd/palette.js';
import { markSVG } from './vendor/dd/markings.js';

export const DD = ddPalette.adjusted;
export const RAMP = [DD.red, DD.orange, DD.white]; // low → high intensity
export const RH_TO_MCM = 0.0315;

export const MODE = {
    s2: {
        subtitle: 'Sentinel-2 Flare Detection',
        label: 'B12 reflectance',
        prop: 'max_b12',
        col2: 'B12', col3: 'px',
        stops: [0.9, 1.15, 1.5],
        log: false,
        chartRange: [0.85, 1.6],
        filter: { min: 0, max: 1.5, step: 0.05, default: 0.85 },
        formatFilter: v => v === 0 ? 'Off' : v.toFixed(2),
        formatStop: v => String(v),
        yVal: d => d.b12_corrected,
        formatVal: d => d.max_b12?.toFixed(2) || '-',
        formatCount: d => String(d.pixels || '-'),
        sentinel: null,
    },
    vnf: {
        subtitle: 'VIIRS Nightfire Flares',
        label: 'Radiant heat (MW)',
        prop: 'max_rh',
        col2: 'RH', col3: 'MCM/d',
        stops: [1, 7, 20],
        log: true,
        chartRange: [0.5, 50],
        filter: { min: 0, max: 10, step: 0.5, default: 3 },
        formatFilter: v => v === 0 ? 'Off' : `${v} MW`,
        formatStop: v => String(v),
        yVal: d => d.rh_mw || 0,
        formatVal: d => d.rh_mw >= 999 ? '-' : (d.rh_mw?.toFixed(1) || '-'),
        formatCount: d => d.rh_mw >= 999 ? '-' : (d.rh_mw != null ? (d.rh_mw * RH_TO_MCM).toFixed(2) : '-'),
        sentinel: 999,
    }
};

// Normalize value to 0→1 on the mode's intensity scale (stops[0]→stops[2])
export function scaleT(cfg, val) {
    const [lo, , hi] = cfg.stops;
    const raw = cfg.log
        ? Math.log(Math.max(lo, val) / lo) / Math.log(hi / lo)
        : (val - lo) / (hi - lo);
    return Math.max(0, Math.min(1, raw));
}

// red→orange→white ramp, t in [0,1]
export function rampRGB(t) {
    t = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    const [a, b] = t < 0.5 ? [hex(RAMP[0]), hex(RAMP[1])] : [hex(RAMP[1]), hex(RAMP[2])];
    const f = (t < 0.5 ? t : t - 0.5) * 2;
    return a.map((v, i) => Math.round(v + f * (b[i] - v)));
}

// Normalize value to 0→1 on the chart y-axis (wider than colour stops)
export function chartNorm(cfg, val) {
    const [lo, hi] = cfg.chartRange;
    if (cfg.log) return (Math.log(Math.max(lo, val)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    return (val - lo) / (hi - lo);
}

// icon-image expression: flare marking stepped low→mid→high through the ramp
export function markIconExpr(cfg) {
    const prop = ['coalesce', ['get', cfg.prop], cfg.stops[0]];
    return ['step', cfg.log ? ['ln', ['+', prop, 1]] : prop,
        `flare-${RAMP[0]}`,
        cfg.log ? Math.log(cfg.stops[1] + 1) : cfg.stops[1], `flare-${RAMP[1]}`,
        cfg.log ? Math.log(cfg.stops[2] + 1) : cfg.stops[2], `flare-${RAMP[2]}`];
}

export const ICON_SIZE = ['interpolate', ['linear'], ['zoom'], 2, 0.55, 10, 0.8, 14, 1];

// --- key (legend) ---

// inline svg text per marking (dd markSVG), tinted via css color on the wrapper
const MARKS = {};
export function loadMarks(names = ['flare', 'triangle', 'square']) {
    return Promise.all(names.map(async n => MARKS[n] = await markSVG(n)));
}

const CHEV = open => `<span class="dd-chevron${open ? '' : ' dd-chevron-down'}"></span>`;
const mark = (name, color) => `<span style="color:${color};display:flex">${MARKS[name] || ''}</span>`;
const row = (icon, label, layer, on = true) =>
    `<div class="dd-key-row${on ? '' : ' dd-inactive'}${layer ? ' key-toggle' : ''}"${layer ? ` data-layer="${layer}"` : ''}>${icon}${label}</div>`;

// Build key HTML: intensity ramp section + infrastructure section (pdf:85).
// state: { open, ogim, pipes } — one chevron collapses the whole legend;
// both group labels toggle it too
export function buildKeyHTML(cfg, state) {
    const stops = [...cfg.stops].reverse();
    const ramp = stops.map((v, i) =>
        row(mark('flare', RAMP[2 - i]), i === 0 ? `${cfg.formatStop(v)}+` : cfg.formatStop(v))).join('');
    const line = `<svg width="13" height="13" viewBox="0 0 13 13"><line x1="0" y1="6.5" x2="13" y2="6.5" stroke="currentColor"/></svg>`;
    const infra =
        row(mark('triangle', DD.white), 'LNG') +
        row(mark('square', DD.white), 'OGIM infra.', 'ogim', state.ogim) +
        row(line, 'Pipelines', 'pipes', state.pipes);
    const section = (label, items, chev = '') =>
        `<div class="key-section"><div class="key-head">${chev}<span class="dd-secondary">${label}</span></div>` +
        (state.open ? `<div class="key-items">${items}</div>` : '') + '</div>';
    return section(cfg.label, ramp, CHEV(state.open)) + section('Infrastructure', infra);
}

export function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}
