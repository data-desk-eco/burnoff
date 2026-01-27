// Configuration
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const DATA_URL = isLocal ? 'data' : 'https://storage.googleapis.com/burnoff-data';

function parseHash() {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    const [coordsPart, date] = hash.split('/');
    if (!coordsPart || !date) return null;
    const [lat, lon] = coordsPart.split(',').map(parseFloat);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, date };
}

const initialHash = parseHash();

// Hide about modal if deep-linked
if (initialHash) {
    document.getElementById('about-modal').classList.add('hidden');
}

// Register PMTiles protocol
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Initialize map - start at deep-link location if present
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            }
        },
        layers: [{
            id: 'basemap',
            type: 'raster',
            source: 'satellite',
            paint: { 'raster-saturation': -1 }
        }]
    },
    center: initialHash ? [initialHash.lon, initialHash.lat] : [51.52, 25.92],
    zoom: initialHash ? 14 : 12,
    minZoom: 1.5,
    maxZoom: 18
});

map.on('style.load', () => map.setProjection({ type: 'globe' }));

let currentFeature = null;
let selectedDetection = null;
let terminals = [];

// Color scale for B12 intensity
const b12ColorScale = ['interpolate', ['linear'], ['coalesce', ['get', 'max_b12'], 0.9],
    0.9, '#b63679', 1.1, '#f8765c', 1.3, '#ffff00'];

function magmaColor(t) {
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

function b12Color(b12) {
    const t = Math.max(0.15, Math.min(1, (b12 - 0.9) / 0.4));
    const [r, g, b] = magmaColor(t);
    return `rgb(${r},${g},${b})`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}

function copernicusUrl(lat, lon, date) {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    return `https://browser.dataspace.copernicus.eu/?zoom=15&lat=${lat}&lng=${lon}&datasetId=S2_L2A_CDAS&fromTime=${encodeURIComponent(from)}&toTime=${encodeURIComponent(to)}&layerId=1_TRUE_COLOR&dateMode=SINGLE`;
}

function updateHash(coords, date) {
    if (coords && date) {
        const [lon, lat] = coords;
        history.replaceState(null, '', `#${lat.toFixed(6)},${lon.toFixed(6)}/${date}`);
    } else {
        history.replaceState(null, '', location.pathname);
    }
}

function setCirclesGreyed() {
    if (!map.getLayer('detection-circles')) return;
    map.setPaintProperty('detection-circles', 'circle-stroke-color', '#bbb');
    map.setPaintProperty('detection-circles', 'circle-stroke-opacity', 0.6);
}

function setCirclesDefault() {
    if (!map.getLayer('detection-circles')) return;
    map.setPaintProperty('detection-circles', 'circle-stroke-color', b12ColorScale);
    map.setPaintProperty('detection-circles', 'circle-stroke-opacity', 1);
}

function renderIntensityChart(detections, onSelectDate) {
    const container = document.getElementById('intensity-chart');
    if (!detections?.length) {
        container.innerHTML = '';
        return;
    }

    const sorted = [...detections].sort((a, b) => new Date(a.date) - new Date(b.date));
    const margin = { top: 8, right: 8, bottom: 16, left: 8 };
    const width = 268, height = 50;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const dates = sorted.map(d => new Date(d.date));
    const firstDate = new Date(Math.min(...dates));
    const minDate = new Date(firstDate.getFullYear(), 0, 1).getTime();
    const maxDate = Math.max(...dates);
    const dateRange = maxDate - minDate || 1;

    const b12Val = d => d.b12_corrected;
    const b12Values = sorted.map(b12Val).filter(v => v > 0);
    const dataMin = Math.min(...b12Values), dataMax = Math.max(...b12Values);
    const padding = (dataMax - dataMin) * 0.1 || 0.1;
    const minB12 = Math.max(0, dataMin - padding), maxB12 = dataMax + padding;
    const b12Range = maxB12 - minB12 || 0.1;

    let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`;

    sorted.forEach((det, i) => {
        const date = new Date(det.date);
        const x = margin.left + ((date - minDate) / dateRange) * innerW;
        const b12 = b12Val(det);
        const y = margin.top + innerH - ((b12 - minB12) / b12Range) * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="3.5" fill="${b12Color(b12)}" data-idx="${i}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>`;
    });

    if (dateRange > 30 * 24 * 60 * 60 * 1000) {
        const endMonth = new Date(maxDate).toLocaleString('en', { month: 'short' });
        svg += `<text x="${margin.left}" y="${height - 2}" fill="rgba(255,255,255,0.3)" font-size="8">Jan</text>`;
        svg += `<text x="${width - margin.right}" y="${height - 2}" fill="rgba(255,255,255,0.3)" font-size="8" text-anchor="end">${endMonth}</text>`;
    }

    svg += '</svg>';
    container.innerHTML = svg;

    container.querySelectorAll('.chart-dot').forEach(dot => {
        dot.addEventListener('click', e => {
            const idx = parseInt(e.target.dataset.idx);
            onSelectDate(sorted[idx]);
        });
    });
}

function utmToWgs84(utmBounds, epsg) {
    if (!epsg) return null;
    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    const utmProj = `+proj=utm +zone=${zone} ${isNorth ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
    const [minX, minY, maxX, maxY] = utmBounds;
    const sw = proj4(utmProj, 'EPSG:4326', [minX, minY]);
    const ne = proj4(utmProj, 'EPSG:4326', [maxX, maxY]);
    return [sw[0], sw[1], ne[0], ne[1]];
}

async function loadTerminals() {
    try {
        const res = await fetch(`${DATA_URL}/terminals.json`);
        const data = await res.json();
        terminals = data.map(t => ({ name: t.name, coords: [t.lon, t.lat] }))
            .sort((a, b) => {
                const aR = a.name.toLowerCase().includes('ras laffan');
                const bR = b.name.toLowerCase().includes('ras laffan');
                if (aR && !bR) return -1;
                if (bR && !aR) return 1;
                return a.name.localeCompare(b.name);
            });

        const select = document.getElementById('terminal-select');
        select.innerHTML = terminals.map(t =>
            `<option value="${t.name}"${t.name.toLowerCase().includes('ras laffan') ? ' selected' : ''}>${t.name}</option>`
        ).join('');

        select.addEventListener('change', e => {
            const t = terminals.find(t => t.name === e.target.value);
            if (t) {
                closeInfo();
                map.flyTo({ center: t.coords, zoom: 13 });
            }
        });
    } catch (err) {
        console.error('Failed to load terminals:', err);
    }
}

function restoreFromHash(skipFly = false) {
    const params = parseHash();
    if (!params) return;

    if (!skipFly) {
        map.flyTo({ center: [params.lon, params.lat], zoom: 14, duration: 800 });
    }

    let attempts = 0;
    const maxAttempts = 10;

    const tryFindFeature = () => {
        const features = map.querySourceFeatures('detections', { sourceLayer: 'detections' });
        const match = features.find(f => {
            const [fLon, fLat] = f.geometry.coordinates;
            return fLat.toFixed(6) === params.lat.toFixed(6) && fLon.toFixed(6) === params.lon.toFixed(6);
        });

        if (match) {
            let detections = match.properties.detections || [];
            if (typeof detections === 'string') {
                try { detections = JSON.parse(detections); } catch (e) { detections = []; }
            }
            const det = detections.find(d => d.date === params.date);
            showInfo(match, { skipAutoSelect: !!det });
            if (det) {
                const item = document.querySelector(`.event-item[data-date="${params.date}"]`);
                if (item) selectDetection(det, item);
            }
        } else if (++attempts < maxAttempts) {
            // PMTiles may not have loaded yet, retry on next idle or after delay
            setTimeout(tryFindFeature, 300);
        }
    };

    const onIdle = () => {
        map.off('idle', onIdle);
        tryFindFeature();
    };
    map.on('idle', onIdle);
}

function updateTerminalSelector(feature) {
    const [fLon, fLat] = feature.geometry.coordinates;
    let closest = null, minDist = Infinity;
    for (const t of terminals) {
        const dist = Math.hypot(t.coords[0] - fLon, t.coords[1] - fLat);
        if (dist < minDist) { minDist = dist; closest = t; }
    }
    if (closest) {
        document.getElementById('terminal-select').value = closest.name;
    }
}

function showInfo(feature, { skipAutoSelect = false } = {}) {
    currentFeature = feature;
    selectedDetection = null;
    const props = feature.properties;

    setCirclesGreyed();
    updateTerminalSelector(feature);

    const selectionSource = map.getSource('selection-highlight');
    if (selectionSource) selectionSource.setData(feature);
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'visible');
    }

    document.getElementById('info').classList.add('visible');
    document.getElementById('info-name').textContent = props.name || 'Unknown facility';

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

    const list = document.getElementById('events-list');
    list.innerHTML = '';

    const sorted = [...detections].sort((a, b) => new Date(b.date) - new Date(a.date));
    const dateToItem = new Map();
    let firstItem = null;

    sorted.forEach(det => {
        const item = document.createElement('div');
        const url = det.cog_b12;
        const isL1C = !url || typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif');
        item.className = 'event-item' + (isL1C ? ' l1c-only' : '');
        item.dataset.date = det.date;
        item.innerHTML = `
            <span class="event-date">${formatDate(det.date)}</span>
            <span class="event-meta" style="text-align: right; width: 40px;">${det.max_b12?.toFixed(2) || '-'}</span>
            <span class="event-meta" style="text-align: right; width: 32px;">${det.pixels || '-'}</span>
        `;
        item.onclick = () => selectDetection(det, item);
        list.appendChild(item);

        dateToItem.set(det.date, { det, item, isL1C });
        if (!firstItem && !isL1C) firstItem = { det, item };
    });

    renderIntensityChart(detections, det => {
        const entry = dateToItem.get(det.date);
        if (entry) {
            selectDetection(entry.det, entry.item);
            entry.item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });

    if (firstItem && !skipAutoSelect) selectDetection(firstItem.det, firstItem.item);

    if (detections.length === 0) {
        document.getElementById('intensity-chart').innerHTML = '';
        list.innerHTML = '<div style="padding: 16px; color: rgba(255,255,255,0.4); text-align: center;">No detections</div>';
    }
}

function selectDetection(det, element) {
    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');
    selectedDetection = det;

    if (currentFeature) {
        updateHash(currentFeature.geometry.coordinates, det.date);
    }

    loadImageryForDetection(det);
}

function closeInfo() {
    document.getElementById('info').classList.remove('visible');
    closeImagery();
    currentFeature = null;
    updateHash(null, null);
    setCirclesDefault();
    if (map.getLayer('selection-highlight')) {
        map.setLayoutProperty('selection-highlight', 'visibility', 'none');
    }
}

async function loadImageryForDetection(det) {
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');

    if (!det?.cog_b12) return;

    const url = det.cog_b12;
    if (typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif')) {
        document.querySelector('.event-item.active')?.classList.add('l1c-only');
        return;
    }

    const [flareLon, flareLat] = currentFeature.geometry.coordinates;
    const epsg = det.epsg;
    const buffer = 50;

    const zone = epsg % 100;
    const isNorth = epsg < 32700;
    const utmProj = `+proj=utm +zone=${zone} ${isNorth ? '' : '+south '}+datum=WGS84 +units=m +no_defs`;
    const [flareUtmX, flareUtmY] = proj4('EPSG:4326', utmProj, [flareLon, flareLat]);
    const utmBounds = [flareUtmX - buffer, flareUtmY - buffer, flareUtmX + buffer, flareUtmY + buffer];

    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('loading'));
    document.querySelector('.event-item.active')?.classList.add('loading');

    try {
        const tiff = await GeoTIFF.fromUrl(det.cog_b12, { allowFullFile: false });
        const image = await tiff.getImage();

        const imgBbox = image.getBoundingBox();
        const width = image.getWidth(), height = image.getHeight();
        const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;
        const resX = (imgMaxX - imgMinX) / width;
        const resY = (imgMaxY - imgMinY) / height;

        const [minX, minY, maxX, maxY] = utmBounds;
        const x0 = Math.max(0, Math.floor((minX - imgMinX) / resX));
        const y0 = Math.max(0, Math.floor((imgMaxY - maxY) / resY));
        const x1 = Math.min(width, Math.ceil((maxX - imgMinX) / resX));
        const y1 = Math.min(height, Math.ceil((imgMaxY - minY) / resY));

        const windowWidth = x1 - x0, windowHeight = y1 - y0;
        if (windowWidth <= 0 || windowHeight <= 0) throw new Error('Outside image bounds');

        const actualUtmBounds = [imgMinX + x0 * resX, imgMaxY - y1 * resY, imgMinX + x1 * resX, imgMaxY - y0 * resY];
        const bounds = utmToWgs84(actualUtmBounds, epsg);
        if (!bounds) throw new Error('Could not convert bounds');

        const rasters = await image.readRasters({
            window: [x0, y0, x1, y1],
            width: Math.min(windowWidth, 256),
            height: Math.min(windowHeight, 256)
        });

        const data = rasters[0];
        const w = rasters.width, h = rasters.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(w, h);

        const scale = 0.0001, offset = -0.1, threshold = 0.6, ceiling = 1.5;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] * scale + offset;
            if (v <= threshold) {
                imgData.data[i * 4 + 3] = 0;
            } else {
                const t = Math.min(1, (v - threshold) / (ceiling - threshold));
                const [r, g, b] = magmaColor(t);
                imgData.data[i * 4] = r;
                imgData.data[i * 4 + 1] = g;
                imgData.data[i * 4 + 2] = b;
                imgData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
        if (map.getSource('cog-source')) map.removeSource('cog-source');

        map.addSource('cog-source', {
            type: 'image',
            url: canvas.toDataURL(),
            coordinates: [[bounds[0], bounds[3]], [bounds[2], bounds[3]], [bounds[2], bounds[1]], [bounds[0], bounds[1]]]
        });

        map.addLayer({
            id: 'cog-layer',
            type: 'raster',
            source: 'cog-source',
            paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' }
        }, 'detection-circles');

        setCirclesGreyed();
        document.querySelector('.event-item.active')?.classList.remove('loading');
        map.setPaintProperty('basemap', 'raster-brightness-max', 0.25);
    } catch (err) {
        console.error('Failed to load COG:', err);
        document.querySelector('.event-item.active')?.classList.remove('loading');
    }
}

function closeImagery() {
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-source')) map.removeSource('cog-source');
    map.setPaintProperty('basemap', 'raster-brightness-max', 1);
    if (currentFeature) setCirclesGreyed();
    else setCirclesDefault();
}

function downloadFlareCSV() {
    if (!currentFeature) return;
    const props = currentFeature.properties;
    const [lon, lat] = currentFeature.geometry.coordinates;

    let detections = props.detections || [];
    if (typeof detections === 'string') {
        try { detections = JSON.parse(detections); } catch (e) { detections = []; }
    }

    const rows = [['facility', 'lat', 'lon', 'date', 'max_b12', 'pixels']];
    for (const det of detections) {
        rows.push([
            `"${(props.name || '').replace(/"/g, '""')}"`,
            det.raw_lat?.toFixed(6) || lat.toFixed(6),
            det.raw_lon?.toFixed(6) || lon.toFixed(6),
            det.date,
            det.max_b12?.toFixed(4) || '',
            det.pixels || ''
        ]);
    }

    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(props.name || 'flare').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-detections.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// Map load handler
map.on('load', () => {
    map.addSource('detections', {
        type: 'vector',
        url: `pmtiles://${DATA_URL}/detections.pmtiles`
    });

    const circleRadius = ['interpolate', ['exponential', 1.5], ['zoom'],
        0, ['+', 4, ['*', ['coalesce', ['get', 'max_b12'], 0], 4]],
        6, ['+', 6, ['*', ['coalesce', ['get', 'max_b12'], 0], 6]],
        10, ['+', 10, ['*', ['coalesce', ['get', 'max_b12'], 0], 8]],
        14, ['+', 12, ['*', ['coalesce', ['get', 'max_b12'], 0], 10]]
    ];

    map.addLayer({
        id: 'detection-circles',
        type: 'circle',
        source: 'detections',
        'source-layer': 'detections',
        paint: {
            'circle-radius': circleRadius,
            'circle-color': 'transparent',
            'circle-opacity': 0,
            'circle-stroke-color': b12ColorScale,
            'circle-stroke-width': 2,
            'circle-stroke-opacity': 1
        }
    });

    map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'selection-highlight',
        type: 'circle',
        source: 'selection-highlight',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': circleRadius,
            'circle-color': 'transparent',
            'circle-opacity': 0,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-opacity': 1
        }
    });

    const MIN_INTERACTIVE_ZOOM = 10;

    map.on('mouseenter', 'detection-circles', () => {
        if (map.getZoom() >= MIN_INTERACTIVE_ZOOM) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'detection-circles', () => map.getCanvas().style.cursor = '');

    map.on('click', e => {
        const tolerance = 15;
        const bbox = [[e.point.x - tolerance, e.point.y - tolerance], [e.point.x + tolerance, e.point.y + tolerance]];
        const features = map.queryRenderedFeatures(bbox, { layers: ['detection-circles'] });

        if (features.length === 0) {
            closeInfo();
            return;
        }

        let closest = features[0], minDist = Infinity;
        for (const f of features) {
            const [lng, lat] = f.geometry.coordinates;
            const dist = Math.hypot(lng - e.lngLat.lng, lat - e.lngLat.lat);
            if (dist < minDist) { minDist = dist; closest = f; }
        }

        if (map.getZoom() < MIN_INTERACTIVE_ZOOM) {
            map.flyTo({ center: closest.geometry.coordinates, zoom: MIN_INTERACTIVE_ZOOM });
            return;
        }

        showInfo(closest);
        map.flyTo({ center: closest.geometry.coordinates, zoom: Math.max(map.getZoom(), 12) });
    });

    loadTerminals();

    // Wait for the detections source to load before restoring from hash
    const onSourceData = (e) => {
        if (e.sourceId === 'detections' && e.isSourceLoaded) {
            map.off('sourcedata', onSourceData);
            restoreFromHash(!!initialHash);
        }
    };
    map.on('sourcedata', onSourceData);
});

window.addEventListener('hashchange', restoreFromHash);

document.getElementById('about-modal').addEventListener('click', function(e) {
    if (e.target === this || !e.target.closest('a')) this.classList.add('hidden');
});

document.getElementById('download-btn').addEventListener('click', downloadFlareCSV);
document.getElementById('open-image-btn').addEventListener('click', () => {
    if (!currentFeature || !selectedDetection) return;
    const [lon, lat] = currentFeature.geometry.coordinates;
    window.open(copernicusUrl(lat, lon, selectedDetection.date), '_blank');
});
document.querySelector('.close-btn').addEventListener('click', closeInfo);
