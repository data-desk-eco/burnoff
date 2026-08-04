// detail panel: click-to-select with overlap nav, #<key>=<id> permalinks,
// highlight marking on the selected feature, config-rendered body.
//
// config.detail: {
//   layers: [pickable layer ids],
//   hashKey: 'plume',          permalink param (default 'id')
//   idProp: 'id',
//   flyZoom: 15,               zoom floor on select
//   title: p => ({text, href?}),
//   html: p => body html,      sync skeleton below the generic header
//   onShow: (p, el) => {},     async enrich hook
//   onClose: () => {},
// }

import { escapeHtml, fmtCoords, getHashParam, setHashParam } from './util.js';
import { ensureMark } from './shell.js';

let map, cfg, allFeatures;
let overlapping = [], overlapIndex = 0;

const panel = () => document.getElementById('detail');

// properties are exact where present; geometry gets quantized by the tile grid
// at low zoom, but is the fallback for features without lat/lon properties
const coordsOf = f => f.properties.lon != null
    ? [Number(f.properties.lon), Number(f.properties.lat)] : f.geometry.coordinates;

function setHash(id) {
    const target = setHashParam(location.hash, cfg.hashKey || 'id', id);
    if (location.hash !== target)
        history.replaceState(null, '', target || location.pathname + location.search);
}

// rendered features within 10px of a screen point, nearest first — shared by
// map clicks and permalink restore so both get the same overlap grouping
function featuresAt(point, lngLat) {
    const t = 10;
    const bbox = [[point.x - t, point.y - t], [point.x + t, point.y + t]];
    const layers = cfg.layers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
    return map.queryRenderedFeatures(bbox, { layers }).sort((a, b) => {
        const [aLng, aLat] = a.geometry.coordinates;
        const [bLng, bLat] = b.geometry.coordinates;
        return Math.hypot(aLng - lngLat.lng, aLat - lngLat.lat)
             - Math.hypot(bLng - lngLat.lng, bLat - lngLat.lat);
    });
}

function setHighlight(features) {
    map.getSource('cg-highlight')?.setData({ type: 'FeatureCollection', features });
}

// the same feature reaches us from a source (real values) and from a click
// (queryRenderedFeatures serialises nested values to json and drops null ones),
// so compare in a form both agree on: nested to json, nothing to ''
const norm = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const sameProps = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .every(k => norm(a[k]) === norm(b[k]));

let shown = null;   // {feature, n, i} — the card on screen and its overlap position

// apps re-set their sources as the viewport, filters or sliders move, and hand
// the current feature back here each time. a resize does it too: maplibre's
// resize fires moveend, so viewport queries re-run for a camera that never
// moved. re-rendering an unchanged card would throw away whatever the reader
// had selected inside it, so an identical feature is a no-op.
export function showDetail(feature, fromPermalink) {
    if (shown && shown.n === overlapping.length && shown.i === overlapIndex
        && sameProps(shown.feature.properties, feature.properties)) return;
    render(feature, fromPermalink);
}

// re-render in place, for a body that reads state outside the feature (a date
// window, a unit toggle) and so must rebuild even when the properties hold
export function refreshDetail() {
    if (shown) render(shown.feature, true);
}

function render(feature, fromPermalink) {
    const p = feature.properties;
    const id = p[cfg.idProp || 'id'];
    if (!fromPermalink && id != null) setHash(id);
    const [lon, lat] = coordsOf(feature);
    setHighlight([{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }]);

    const t = cfg.title?.(p) || { text: id };
    const n = overlapping.length;
    const el = panel();
    el.innerHTML = `
        <div class="dd-head">
            <button class="dd-chevron-btn" id="detail-collapse" title="Contract"><span class="dd-chevron"></span></button>
            <div class="dd-head-text">
                <div class="dd-heading">${t.href
                    ? `<a class="cg-detail-id" href="${escapeHtml(t.href)}" target="_blank" rel="noopener">${escapeHtml(t.text)}</a>`
                    : `<span class="cg-detail-id">${escapeHtml(t.text)}</span>`}
                    <button class="cg-close" data-close title="Close">×</button></div>
                <div class="dd-subtitle">${fmtCoords(lat, lon)}${n > 1
                    ? ` <span class="cg-overlap"><button class="cg-nav" data-nav="-1">‹</button> ${overlapIndex + 1} / ${n} <button class="cg-nav" data-nav="1">›</button></span>` : ''}</div>
            </div>
        </div>
        ${cfg.html?.(p) || ''}`;
    el.classList.add('visible');
    shown = { feature, n, i: overlapIndex };
    cfg.onShow?.(p, el);
}

export function closeDetail() {
    if (!panel().classList.contains('visible')) return;
    shown = null;
    overlapping = [];
    overlapIndex = 0;
    setHash(null);
    setHighlight([]);
    panel().classList.remove('visible');
    cfg.onClose?.();
}

// restore #<key>=<id> after data load, then regroup overlapping features once
// the camera settles so the prev/next nav appears just as for a map click.
// dynamic-source apps supply cfg.resolve(id) -> feature for ids not yet loaded
// exported so mount() can restore after config.ready — apps often wire map
// handles (overlays, extra layers) in ready, and onShow may depend on them
export async function restorePermalink() {
    if (!cfg) return;
    const id = getHashParam(location.hash, cfg.hashKey || 'id');
    if (!id) return;
    const idOf = f => String(f.properties[cfg.idProp || 'id']);
    const match = allFeatures().find(f => idOf(f) === id) ?? await cfg.resolve?.(id);
    if (!match) return;
    showDetail(match, true);
    const [lon, lat] = coordsOf(match);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), cfg.flyZoom ?? 15) });
    map.once('moveend', () => {
        const features = featuresAt(map.project([lon, lat]), { lng: lon, lat });
        // the feature resolve() found, not the link's spelling of it: a link
        // older than a rename resolves to an id it does not itself carry
        const idx = features.findIndex(f => idOf(f) === idOf(match));
        if (features.length < 2 || idx < 0) return;
        overlapping = [features[idx], ...features.filter((_, i) => i !== idx)];
        overlapIndex = 0;
        showDetail(overlapping[0], true);
    });
}

export function initDetail(m, config, getFeatures) {
    map = m;
    cfg = config.detail;
    allFeatures = getFeatures;
    if (!cfg) return;

    // heavy-stroke empty highlight box marking around the selection (dd rule)
    ensureMark(map, 'highlight-#FFFFFF');
    map.addSource('cg-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'cg-highlight', type: 'symbol', source: 'cg-highlight',
        layout: {
            'icon-image': 'highlight-#FFFFFF', 'icon-size': 1.2,
            'icon-allow-overlap': true, 'icon-ignore-placement': true
        }
    });

    map.on('click', e => {
        const features = featuresAt(e.point, e.lngLat);
        if (!features.length) return closeDetail();
        const center = coordsOf(features[0]);
        // below minZoom features are too dense to pick meaningfully — zoom in instead
        if (cfg.minZoom && map.getZoom() < cfg.minZoom)
            return map.flyTo({ center, zoom: cfg.minZoom });
        overlapping = features;
        overlapIndex = 0;
        showDetail(features[0]);
        map.flyTo({ center, zoom: Math.max(map.getZoom(), cfg.flyZoom ?? 15) });
    });

    for (const layer of cfg.layers) {
        map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
    }

    panel().addEventListener('click', e => {
        if (e.target.closest('[data-close]')) return closeDetail();
        const nav = e.target.closest('[data-nav]');
        if (nav && overlapping.length > 1) {
            overlapIndex = (overlapIndex + Number(nav.dataset.nav) + overlapping.length) % overlapping.length;
            showDetail(overlapping[overlapIndex]);
        }
        if (e.target.closest('#detail-collapse')) panel().classList.toggle('collapsed');
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });

    // deep links into an already-open tab: internal selection writes the hash
    // via replaceState (no event), so hashchange only fires for external
    // navigation — re-resolve the id or close if it was removed
    addEventListener('hashchange', () => {
        const id = getHashParam(location.hash, cfg.hashKey || 'id');
        id ? restorePermalink() : closeDetail();
    });
}
