// mount(config): assemble the whole app — dom, map, data, layers, filters,
// key, quarters, sliders, detail, search — from a declarative config. see
// README for the schema; firedamp is the reference implementation. a config
// may also be pure data (or a url to a json manifest): compile() gives the
// common fields declarative forms so simple maps ship no js at all.

import { createMap, addSatellite, wireWorldmap, wireCollapse, hoverPopup } from './shell.js';
import { initData, read, meta, fc } from './data.js';
import { buildShell, initKey, wireSliders } from './ui.js';
import { initQuarters } from './quarters.js';
import { initDetail } from './detail.js';
import { initTable } from './table.js';
import { compileConfig } from './util.js';

// location search: "lat, lon" zooms directly, anything else geocodes via nominatim
function wireSearch(map) {
    const box = document.getElementById('search');
    box.addEventListener('input', () => box.classList.remove('miss'));
    box.addEventListener('keydown', async e => {
        if (e.key !== 'Enter' || !box.value.trim()) return;
        const q = box.value.trim();
        const m = q.match(/^(-?\d+(?:\.\d+)?)[,\s]\s*(-?\d+(?:\.\d+)?)$/);
        if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180)
            return map.flyTo({ center: [+m[2], +m[1]], zoom: 12 });
        const hit = (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)
            .then(r => r.json()).catch(() => []))[0];
        if (!hit) return box.classList.add('miss');
        const [s, n, w, east] = hit.boundingbox.map(Number);
        map.fitBounds([[w, s], [east, n]], { padding: 40, maxZoom: 14 });
    });
}

// filter button groups: each config.filters entry contributes pred(value) —
// a feature-properties predicate, or null for no-op; `extra` supplies more
// (the key's multi-select rows). active preds AND together and every geojson
// source is re-set to the matching subset, so clustered sources re-cluster
// to exactly the visible features. entries may carry onChange(value, ctx)
// instead of (or besides) pred — e.g. a mode toggle. returns apply for re-runs.
function wireFilters(map, config, sources, extra, ctx) {
    const state = Object.fromEntries((config.filters || []).map(f => [f.key, f.value ?? 'all']));
    const apply = () => {
        const preds = [...(config.filters || []).map(f => f.pred?.(state[f.key])), ...extra()].filter(Boolean);
        for (const [id, fc] of Object.entries(sources))
            map.getSource(id)?.setData(preds.length
                ? { ...fc, features: fc.features.filter(f => preds.every(p => p(f.properties))) } : fc);
    };
    for (const group of document.querySelectorAll('.cg-filter')) {
        group.addEventListener('click', e => {
            const btn = e.target.closest('.cg-opt');
            if (!btn) return;
            group.querySelectorAll('.cg-opt').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state[group.dataset.key] = btn.dataset.value;
            apply();
            (config.filters || []).find(f => f.key === group.dataset.key)?.onChange?.(btn.dataset.value, ctx);
        });
    }
    apply();
    return apply;
}

export async function mount(config) {
    if (typeof config === 'string') config = await (await fetch(config)).json();
    config = compileConfig(config);
    buildShell(config);
    const map = createMap({ hash: 'map', ...config.map });
    wireWorldmap(map, document.getElementById('worldmap'));
    wireCollapse([[['main-collapse', 'main-title'], 'main-panel']]);
    if (config.search) wireSearch(map);
    if (config.data) initData(config.data);

    const ctx = { map, config, read, meta, fc, sources: {} };
    if (config.quarters) ctx.quarters = initQuarters(document.getElementById('quarters'),
        () => config.quarters.onChange?.(ctx), config.quarters.years);
    wireSliders(config, ctx);

    await new Promise(r => (map.loaded() ? r() : map.on('load', r)));
    if (config.map?.satellite !== false) addSatellite(map);

    // a sources entry is a FeatureCollection or {data, ...geojson source
    // opts} (cluster etc.); consumers always see the plain fc
    ctx.sources = await config.sources(ctx);
    for (const [id, s] of Object.entries(ctx.sources)) {
        map.addSource(id, { type: 'geojson', ...(s.type ? { data: s } : s) });
        ctx.sources[id] = s.data ?? s;
    }
    for (const { hover, ...spec } of config.layers || []) {
        map.addLayer(spec);
        if (hover) hoverPopup(map, spec.id, hover, { click: !config.detail?.layers.includes(spec.id) });
    }
    let applyFilters;
    const key = initKey(map, () => applyFilters());
    applyFilters = wireFilters(map, config, ctx.sources, key.preds, ctx);
    ctx.setKey = key.set;
    if (config.key) await key.set(config.key(ctx));

    initDetail(map, config, () =>
        Object.values(ctx.sources).flatMap(s => s.features));
    if (config.table) initTable(ctx);

    await config.ready?.(ctx);
    window.cartograph = ctx;   // console + test handle
    return ctx;
}
