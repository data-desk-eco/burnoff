// generic data desk full-screen map shell — maplibre + the vendored dd design
// system (expected as a sibling vendor dir: ../dd/). dark basemap with globe
// projection and on-demand marking images, grayscale satellite underlay,
// mollweide worldmap widget, hover popups and panel collapse.

import { addMarking } from '../dd/markings.js';
import { drawWorldmap, setBoxes } from '../dd/worldmap.js';

const DD = new URL('../dd/', import.meta.url);

// dd dark basemap + globe. markings load on demand: styleimagemissing catches any
// `<name>-<#hex>` id referenced before its image arrives, so layers can be added
// without awaiting; ensureMark preloads ids referenced only in expressions.
const _marksLoading = new WeakMap();
export function createMap(opts = {}) {
    const map = new maplibregl.Map({ container: 'map', style: new URL('style.dark.json', DD).href, ...opts });
    map.on('style.load', () => map.setProjection({ type: 'globe' }));
    _marksLoading.set(map, new Set());
    map.on('styleimagemissing', e => ensureMark(map, e.id));
    return map;
}

export function ensureMark(map, id) {
    const m = id.match(/^([a-z]+)-(#[0-9A-Fa-f]{6})$/);
    const loading = _marksLoading.get(map);
    if (!m || !loading || loading.has(id)) return;
    loading.add(id);
    addMarking(map, m[1], { color: m[2], base: new URL('markings/', DD) })
        .catch(() => loading.delete(id));
}

// grayscale, underexposed satellite imagery fades in over the dark basemap on
// zoom (guidelines: gradient-map grayscale, approximated with full desaturation
// + a lowered brightness ceiling). call from map load.
export function addSatellite(map) {
    map.addSource('satellite', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256
    });
    map.addLayer({
        id: 'satellite', type: 'raster', source: 'satellite', minzoom: 7,
        paint: {
            'raster-saturation': -1,
            'raster-brightness-max': 0.75,
            'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 9, 1]
        }
    });
}

// drop the brightness ceiling further while an image overlay is up
export const dimSatellite = (map, dim) =>
    map.setPaintProperty('satellite', 'raster-brightness-max', dim ? 0.25 : 0.75);

export function viewportBbox(map) {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// mollweide worldmap widget showing the live viewport as a box (pdf:83)
export function wireWorldmap(map, el) {
    const update = () => setBoxes(el, [viewportBbox(map)]);
    drawWorldmap(el).then(update);
    map.on('move', update);
}

// mollweide worldmap widget with static boxes, e.g. coverage areas (pdf:86).
// getBoxes resolves to an array of bboxes (or null to leave the map bare).
export function boxesWorldmap(el, getBoxes, minSize) {
    drawWorldmap(el).then(async () => {
        const boxes = await getBoxes();
        if (boxes) setBoxes(el, boxes, minSize);
    });
}

// dd popup on hover: labels attach up-and-right of the marking (dd cartography
// label rule). html(properties) returns the popup body; also shown on click
// (touch). pass {click: false} to keep it hover-only. hover layers register
// per map so coincident features across layers show one popup (topmost wins).
const hoverLayers = new WeakMap();
export function hoverPopup(map, layer, html, { click = true } = {}) {
    const layers = hoverLayers.get(map) || hoverLayers.set(map, []).get(map);
    layers.push(layer);
    const popup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, className: 'dd-popup',
        anchor: 'bottom-left', offset: 10
    });
    const show = e => {
        const top = map.queryRenderedFeatures(e.point, { layers })[0];
        if (top?.layer.id !== layer) return popup.remove();
        popup.setLngLat(e.lngLat).setHTML(html(top.properties)).addTo(map);
    };
    map.on('mousemove', layer, e => { map.getCanvas().style.cursor = 'pointer'; show(e); });
    if (click) map.on('click', layer, show);
    map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
    });
    return popup;
}

// chevron and heading text both toggle expand/contract (dd heading rule).
// pairs: [[toggleElementIds], panelId]
export function wireCollapse(pairs) {
    for (const [ids, panel] of pairs)
        for (const id of ids)
            document.getElementById(id)?.addEventListener('click', () =>
                document.getElementById(panel).classList.toggle('collapsed'));
}
