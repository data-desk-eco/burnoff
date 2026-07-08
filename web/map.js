// generic data desk full-screen map shell — maplibre + the vendored dd design
// system, no burnoff specifics. reusable scaffolding for any remote-sensing map:
// dark basemap with globe projection and on-demand marking images, grayscale
// satellite underlay, mollweide worldmap widgets, hover popups, panel collapse
// and viewport bbox helpers.

import { addMarking } from './vendor/dd/markings.js';
import { drawWorldmap, setBoxes } from './vendor/dd/worldmap.js';

// dd dark basemap + globe. markings load on demand: styleimagemissing catches any
// `<name>-<#hex>` id referenced before its image arrives, so layers can be added
// without awaiting; ensureMark preloads ids referenced only in expressions.
const _marksLoading = new WeakMap();
export function createMap(opts = {}) {
    const map = new maplibregl.Map({ container: 'map', style: 'vendor/dd/style.dark.json', ...opts });
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
    addMarking(map, m[1], { color: m[2], base: new URL('vendor/dd/markings/', location.href) })
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

// expand a bbox to at least `min` degrees per axis (centered). availability tests
// on a razor-thin zoomed-in viewport otherwise flip the moment you sit between
// features; a ~3 km floor makes them reflect the surrounding area instead.
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
// label rule). html(properties) returns the popup body.
export function hoverPopup(map, layer, html) {
    const popup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, className: 'dd-popup',
        anchor: 'bottom-left', offset: 10
    });
    map.on('mousemove', layer, e => {
        map.getCanvas().style.cursor = 'pointer';
        popup.setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(map);
    });
    map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
    });
}

// chevron and heading text both toggle expand/contract (dd heading rule).
// pairs: [[toggleElementIds], panelId]
export function wireCollapse(pairs) {
    for (const [ids, panel] of pairs)
        for (const id of ids)
            document.getElementById(id).addEventListener('click', () =>
                document.getElementById(panel).classList.toggle('collapsed'));
}
