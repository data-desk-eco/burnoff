// MapLibre base style (satellite + OpenFreeMap labels) and the magma colour ramp.
// Pure config/helpers — no app state. app.js feeds MAP_STYLE to the Map constructor;
// render.js builds the detection colour/radius expressions off magmaColor.

export const MAP_STYLE = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
        satellite: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256
        },
        labels: {
            type: 'vector',
            url: 'https://tiles.openfreemap.org/planet',
            attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
        }
    },
    layers: [{
        id: 'basemap',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.85 }
    }, {
        id: 'country-borders',
        type: 'line',
        source: 'labels',
        'source-layer': 'boundary',
        filter: ['==', ['get', 'admin_level'], 2],
        paint: {
            'line-color': 'rgba(255, 255, 255, 0.25)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.5]
        }
    }, {
        id: 'country-labels',
        type: 'symbol',
        source: 'labels',
        'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'country'],
        minzoom: 2,
        layout: {
            'symbol-sort-key': ['get', 'rank'],
            'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
            'text-transform': 'uppercase',
            'text-letter-spacing': 0.15,
            'text-max-width': 8
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.85)',
            'text-halo-color': 'rgba(0, 0, 0, 0.6)',
            'text-halo-width': 1.5
        }
    }, {
        id: 'state-labels',
        type: 'symbol',
        source: 'labels',
        'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'state'],
        minzoom: 4,
        layout: {
            'symbol-sort-key': ['get', 'rank'],
            'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 12],
            'text-letter-spacing': 0.1,
            'text-max-width': 8
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.6)',
            'text-halo-color': 'rgba(0, 0, 0, 0.5)',
            'text-halo-width': 1
        }
    }, {
        id: 'city-labels',
        type: 'symbol',
        source: 'labels',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        minzoom: 4,
        layout: {
            'symbol-sort-key': ['get', 'rank'],
            'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14, 14, 18],
            'text-max-width': 8
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.9)',
            'text-halo-color': 'rgba(0, 0, 0, 0.6)',
            'text-halo-width': 1.5
        }
    }, {
        id: 'village-labels',
        type: 'symbol',
        source: 'labels',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'neighbourhood']]],
        minzoom: 10,
        layout: {
            'symbol-sort-key': ['get', 'rank'],
            'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 14],
            'text-max-width': 8
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.7)',
            'text-halo-color': 'rgba(0, 0, 0, 0.5)',
            'text-halo-width': 1
        }
    }]
};

// magma color ramp (8-stop), t in [0,1]
export function magmaColor(t) {
    t = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    const colors = [
        [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99],
        [212, 72, 66], [245, 125, 21], [250, 193, 39], [255, 255, 0]
    ];
    const idx = Math.min(Math.floor(t * (colors.length - 1)), colors.length - 2);
    const f = t * (colors.length - 1) - idx;
    const c1 = colors[idx], c2 = colors[idx + 1];
    return [
        Math.round(c1[0] + f * (c2[0] - c1[0])),
        Math.round(c1[1] + f * (c2[1] - c1[1])),
        Math.round(c1[2] + f * (c2[2] - c1[2]))
    ];
}

export function magmaHex(t) {
    const [r, g, b] = magmaColor(t);
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}
