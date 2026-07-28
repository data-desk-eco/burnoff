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
//
// esri's world imagery cache runs out somewhere between z17 and z19 depending on
// where you stand — measured over 700 real plume and flare sites, 26% have
// nothing at z18 and 53% nothing at z19 — and past its edge it answers 200 with
// an opaque "map data not yet available" jpeg rather than 404ing. maplibre can't
// tell that from imagery, so it paints the grey sheet instead of overzooming
// what it already has. so: swap that placeholder for a transparent tile as it
// arrives, and stack the source at each of the three depths its cache tends to
// stop at. every tier is blank wherever esri stopped short, and the sharpest one
// that did resolve shows through.
const ESRI = 'esri://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const GAP = 2521;   // byte length of the placeholder jpeg
const BLANK = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='), c => c.charCodeAt(0)).buffer;
const SAT = [['satellite', 7, 17], ['satellite-mid', 17, 18], ['satellite-deep', 18, 19]];

maplibregl.addProtocol('esri', async ({ url }, abort) => {
    const data = await (await fetch(url.replace('esri:', 'https:'), { signal: abort.signal })).arrayBuffer();
    return { data: data.byteLength === GAP ? BLANK : data };
});

export function addSatellite(map) {
    for (const [id, minzoom, maxzoom] of SAT) {
        map.addSource(id, { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom });
        map.addLayer({
            id, type: 'raster', source: id, minzoom,
            paint: {
                'raster-saturation': -1,
                'raster-brightness-max': 0.75,
                'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 9, 1]
            }
        });
    }
}

// drop the brightness ceiling further while an image overlay is up
export const dimSatellite = (map, dim) =>
    SAT.forEach(([id]) => map.setPaintProperty(id, 'raster-brightness-max', dim ? 0.25 : 0.75));

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
