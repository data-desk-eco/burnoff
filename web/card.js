// detection card (pdf:84) as cartograph detail hooks: cardTitle/cardHtml build
// the header + skeleton (metrics, intensity dot chart, per-date event rows,
// action buttons), onCardShow wires them (COG / heat-footprint imagery
// overlays, CSV export, keyboard nav) and onCardClose tears the imagery down.
// owns the current selection (properties + per-date detection).

import { openCOG } from './s2/cog.js';
import { wgs84ToUtm, utmToWgs84, utmParams } from './s2/geo.js';
import { rampRGB, scaleT, chartNorm, formatDate } from './render.js';
import { showDetail, closeDetail } from './vendor/cartograph/detail.js';
import { dimSatellite } from './vendor/cartograph/shell.js';
import { dateInQuarters } from './vendor/cartograph/util.js';
import { DEG_TO_RAD } from './clustering.js';
import { fetchVNFDetections } from './vnf.js';

// injected by initCard: the map, the active mode config, an isVnf() probe,
// whether this build serves the precomputed archive (no COGs in cluster rows)
// and the active quarter-keys getter
let map, modeConf, isVnf, hasArchive, quarterKeys;

let current = null;            // selected feature's properties
let selectedDetection = null;
let _skipAuto = false;         // suppress auto COG load on card re-render

export function initCard(deps) {
    ({ map, modeConf, isVnf, hasArchive, quarterKeys } = deps);

    // j/k / arrows step through the event rows (escape handled by cartograph)
    document.addEventListener('keydown', e => {
        if (!document.getElementById('detail').classList.contains('visible')) return;
        let dir = 0;
        if (e.key === 'ArrowDown' || e.key === 'j') dir = 1;
        else if (e.key === 'ArrowUp' || e.key === 'k') dir = -1;
        if (!dir) return;
        e.preventDefault();
        const sel = isVnf() ? '.event-item' : '.event-item:not(.l1c-only)';
        const items = Array.from(document.querySelectorAll(sel));
        if (items.length === 0) return;
        const activeIdx = items.findIndex(el => el.classList.contains('active'));
        const nextIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
        if (nextIdx === activeIdx) return;
        items[nextIdx].click();
        items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

const coords = p => [Number(p.lon), Number(p.lat)];
const featureOf = p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords(p) }, properties: p });

// detections arrive as objects from our builders or json strings via
// queryRenderedFeatures
function parseDets(p) {
    let d = p.detections || [];
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = []; } }
    return d;
}

function greyCircles(grey) {
    if (map.getLayer('detections'))
        map.setPaintProperty('detections', 'icon-opacity', grey ? 0.35 : 1);
}

function copernicusUrl(date) {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const { lat, lng } = map.getCenter();
    // maplibre renders 512px tiles, so its zoom is one level lower than the
    // 256px slippy zoom copernicus browser (leaflet) expects for the same scale
    const zoom = Math.round(map.getZoom()) + 1;
    return `https://browser.dataspace.copernicus.eu/?zoom=${zoom}&lat=${lat}&lng=${lng}&datasetId=S2_L2A_CDAS&fromTime=${encodeURIComponent(from)}&toTime=${encodeURIComponent(to)}&layerId=6-SWIR&upsampling=NEAREST&downsampling=NEAREST&dateMode=SINGLE`;
}

// quarter-aware card metrics. detections filter exactly to the selected
// quarters (numerator); the cloud-free observation count has no per-date
// breakdown — the archive carries only a cluster total — so the denominator is
// scaled by the share of the cluster's active-quarter span the selection
// covers. left as the published totals when every quarter, or none, is selected.
function quarterMetrics(props, dets, qKeys) {
    const detection_count = dets.filter(d => dateInQuarters(d.date, qKeys)).length;
    let { observations, persistence } = props;
    if (observations != null && dets.length) {
        const qi = d => +d.date.slice(0, 4) * 4 + Math.floor((+d.date.slice(5, 7) - 1) / 3);
        const idx = dets.map(qi), lo = Math.min(...idx), hi = Math.max(...idx);
        let span = 0, sel = 0;
        for (let i = lo; i <= hi; i++, span++)
            if (!qKeys.size || qKeys.has(`${Math.floor(i / 4)}_${i % 4 + 1}`)) sel++;
        if (sel < span) {
            observations = Math.round(observations * sel / span);
            persistence = observations > 0 ? Math.min(1, detection_count / observations) : 0;
        }
    }
    return { detection_count, observations, persistence };
}

// ── detail hooks ──

export function cardTitle(p) {
    const t = p.terminal
        ? `Near ${String(p.name).replace(/\s*Terminal\b/gi, '').trim()}`
        : p.name;
    return { text: t || (isVnf() ? `Flare #${p.flare_id}` : 'Unknown facility') };
}

export function cardHtml(p) {
    const cfg = modeConf();
    const vnf = isVnf();
    // vnf features carry range-scoped aggregates from the quarterly rollup
    // (detections load lazily); s2 derives metrics from the embedded list
    const m = vnf
        ? { detection_count: p.detection_count, observations: p.observations, persistence: p.persistence }
        : quarterMetrics(p, parseDets(p), quarterKeys());
    const cfLabel = p.passes && m.observations != null
        ? `Cloud-free (${Math.round(m.observations / p.passes * 100)}%)` : 'Cloud-free obs.';
    // vnf: the count is the nights we could see the site and it was lit — fewer
    // than the dates listed below, which include cloudy ones — over nights a
    // satellite flew and we read the sky. the four read as one chain.
    const stats = [
        [vnf ? 'Detections (clear)' : 'Detections', m.detection_count],
        ['Persistence', m.persistence != null ? `${Math.round(m.persistence * 100)}%` : '—'],
        [vnf ? 'Nights read' : 'Passes', p.passes ?? '—'],
        [cfLabel, m.observations ?? '—'],
    ].map(([k, v]) => `<div><span class="dd-secondary">${k}</span><span>${v}</span></div>`).join('');
    return `
        <div class="info-stats">${stats}</div>
        <div class="intensity-chart" id="intensity-chart"></div>
        <div class="events">
            <div class="events-header dd-secondary">
                <span>Date</span>
                <span class="col-right col-val">${cfg.col2}</span>
                <span class="col-right col-count">${cfg.col3}</span>
            </div>
            <div class="events-list custom-scroll" id="events-list"></div>
        </div>
        ${isVnf() ? '' : `
        <div class="dd-btn-pair panel-actions">
            <button class="dd-btn" id="open-image-btn">Open Image</button>
            <button class="dd-btn" id="download-btn">Download CSV</button>
        </div>`}`;
}

export function onCardShow(p, el) {
    current = p;
    selectedDetection = null;
    greyCircles(true);

    // card shows only detections in the selected quarter window. vnf features
    // carry no embedded list — daily history is fetched per flare, here, so
    // the big daily parquet (and its footer) loads lazily behind the card
    const qKeys = quarterKeys();
    if (isVnf()) {
        el.querySelector('#events-list').innerHTML = '<div class="events-empty">Loading…</div>';
        fetchVNFDetections(p.flare_id).then(dets => {
            if (current === p) renderEvents(el, dets.filter(d => dateInQuarters(d.date, qKeys)));
        });
    } else {
        renderEvents(el, parseDets(p).filter(d => dateInQuarters(d.date, qKeys)));
    }

    el.querySelector('#download-btn')?.addEventListener('click', downloadFlareCSV);
    el.querySelector('#open-image-btn')?.addEventListener('click', () => {
        if (!current || !selectedDetection) return;
        window.open(copernicusUrl(selectedDetection.date), '_blank');
    });
    document.activeElement?.blur();
}

function renderEvents(el, detections) {
    const cfg = modeConf();
    const vnf = isVnf();
    const list = el.querySelector('#events-list');
    list.innerHTML = '';
    const sorted = [...detections].sort((a, b) => new Date(b.date) - new Date(a.date));
    const dateToItem = new Map();
    let firstItem = null;

    for (const det of sorted) {
        const item = document.createElement('div');
        let isL1C = false;
        // archive detections have no COG (cluster view only) but still carry a
        // date + raw point — clickable for the intensity halo and "Open image"
        if (!vnf && !hasArchive) {
            const url = det.cog_b12;
            isL1C = !url || typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif');
        }
        item.className = 'dd-row event-item' + (isL1C ? ' l1c-only' : '');
        item.dataset.date = det.date;
        item.innerHTML = `
            <span class="event-date">${formatDate(det.date)}</span>
            <span class="event-meta event-meta-val">${cfg.formatVal(det)}</span>
            <span class="event-meta event-meta-count">${cfg.formatCount(det)}</span>`;
        item.onclick = () => selectDetection(det, item);
        list.appendChild(item);
        dateToItem.set(det.date, { det, item });
        if (!firstItem && !isL1C) firstItem = { det, item };
    }

    renderIntensityChart(el, detections, det => {
        const entry = dateToItem.get(det.date);
        if (entry) {
            selectDetection(entry.det, entry.item);
            entry.item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });

    const MAX_VISIBLE_ROWS = window.innerWidth <= 768 ? 4 : 10;
    const items = list.querySelectorAll('.event-item');
    if (items.length > 0) {
        const rowH = items[0].offsetHeight;
        list.style.maxHeight = (rowH * Math.min(items.length, MAX_VISIBLE_ROWS)) + 'px';
    } else {
        el.querySelector('#intensity-chart').innerHTML = '';
        list.innerHTML = '<div class="events-empty">No detections</div>';
    }

    // vnf: auto-select highlights only (no COG); s2: auto-select loads the COG
    if (firstItem && !_skipAuto) selectDetection(firstItem.det, firstItem.item);
}

export function onCardClose() {
    current = null;
    clearCogLayers();
    dimSatellite(map, false);
    greyCircles(false);
}

// ── selection maintenance across re-renders ──

// re-filter the open card to the current quarter window (map reconciles async)
export function refreshCard() {
    if (current) reopen(current);
}

// re-open the card on the feature at the previous selection's coordinates
// after a re-cluster (geojson sources keep the last data set on `_data`),
// or close it
export function reselectCurrentFeature() {
    if (!current) return;
    const features = map.getSource('detections')?._data?.features || [];
    const [lon, lat] = coords(current);
    const match = features.find(f =>
        Math.abs(f.geometry.coordinates[0] - lon) < 1e-4 && Math.abs(f.geometry.coordinates[1] - lat) < 1e-4);
    if (!match) closeDetail();
    // only rebuild when the numbers moved. a window resize resizes the map,
    // which fires moveend, which re-runs the viewport query — and the aggregates
    // come back identical, so rebuilding would drop the reader's selected date
    // and re-fetch the daily history for nothing
    else if (sig(match.properties) !== sig(current)) reopen(match.properties);
}

// queryRenderedFeatures serialises nested props, so normalise before comparing
const sig = p => JSON.stringify({ ...p, detections: parseDets(p) });

function reopen(p) {
    _skipAuto = true;
    showDetail(featureOf(p), true);
    _skipAuto = false;
}

// ── intensity chart ──

function renderIntensityChart(el, detections, onSelectDate) {
    const container = el.querySelector('#intensity-chart');
    if (!detections?.length) { container.innerHTML = ''; return; }

    const sorted = [...detections].sort((a, b) => new Date(a.date) - new Date(b.date));
    const margin = { top: 8, right: 8, bottom: 16, left: 8 };
    const width = 268, height = 50;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const dates = sorted.map(d => new Date(d.date));
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const dateRange = maxDate - minDate || 1;

    const cfg = modeConf();

    let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#808080" stroke-width="1"/>`;

    const firstYear = new Date(minDate).getFullYear();
    const lastYear = new Date(maxDate).getFullYear();
    for (let y = firstYear + 1; y <= lastYear; y++) {
        const jan1 = new Date(y, 0, 1).getTime();
        const x = margin.left + ((jan1 - minDate) / dateRange) * innerW;
        svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#4D4D4D" stroke-width="0.5"/>`;
        svg += `<text x="${x}" y="${height - 2}" fill="#808080" font-size="8" text-anchor="middle">${y}</text>`;
    }

    sorted.forEach((det, i) => {
        const date = new Date(det.date);
        const x = margin.left + ((date - minDate) / dateRange) * innerW;
        const val = cfg.yVal(det);
        if (cfg.sentinel && val >= cfg.sentinel) return;
        const t = Math.max(0, Math.min(1, chartNorm(cfg, val)));
        const y = margin.top + innerH - t * innerH;
        svg += `<circle class="chart-dot" cx="${x}" cy="${y}" r="2.5" fill="#FFFFFF" data-idx="${i}"/>`;
    });

    svg += '</svg>';
    container.innerHTML = svg;

    container.querySelectorAll('.chart-dot').forEach(dot => {
        dot.addEventListener('click', e => onSelectDate(sorted[parseInt(e.target.dataset.idx)]));
    });
}

// ── per-date imagery overlays ──

function selectDetection(det, element) {
    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');
    selectedDetection = det;
    if (isVnf()) showHeatFootprint(det);
    else loadImageryForDetection(det);
}

// tear down the COG / heat-footprint image overlay (idempotent)
function clearCogLayers() {
    if (map.getLayer('cog-border')) map.removeLayer('cog-border');
    if (map.getLayer('cog-layer')) map.removeLayer('cog-layer');
    if (map.getSource('cog-border')) map.removeSource('cog-border');
    if (map.getSource('cog-source')) map.removeSource('cog-source');
}

// magma radial-gradient footprint at a detection's point, sized by intensity,
// used where there is no COG to render: vnf (sized on radiant heat) and s2
// archive rows (sized on B12, located at the per-date raw point)
function showHeatFootprint(det) {
    clearCogLayers();
    if (!det || !current) return;
    const vnf = isVnf();
    const [cLon, cLat] = coords(current);
    const lon = vnf ? cLon : (det.raw_lon ?? cLon);
    const lat = vnf ? cLat : (det.raw_lat ?? cLat);
    const val = vnf ? (det.rh_mw || 0) : (det.max_b12 || det.b12_corrected || 0);
    if (val <= 0) return;

    const radiusM = vnf ? 50 * Math.sqrt(Math.max(val, 0.5)) : 45 * Math.sqrt(val);
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * DEG_TO_RAD));

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const [r, g, b] = rampRGB(scaleT(modeConf(), val));
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
    grad.addColorStop(0.3, `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(0.7, `rgba(${r},${g},${b},0.15)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const corners = [
        [lon - dLon, lat + dLat], [lon + dLon, lat + dLat],
        [lon + dLon, lat - dLat], [lon - dLon, lat - dLat]
    ];
    map.addSource('cog-source', { type: 'image', url: canvas.toDataURL(), coordinates: corners });
    map.addLayer({ id: 'cog-layer', type: 'raster', source: 'cog-source',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' } }, 'detections');

    greyCircles(true);
    dimSatellite(map, true);
}

async function loadImageryForDetection(det) {
    clearCogLayers();

    if (!det?.cog_b12 || !det.epsg) return void showHeatFootprint(det);

    const url = det.cog_b12;
    if (typeof url !== 'string' || !url.startsWith('http') || url.includes('.jp2') || !url.includes('.tif')) {
        document.querySelector('.event-item.active')?.classList.add('l1c-only');
        return;
    }

    const [flareLon, flareLat] = coords(current);
    const { zone, isNorth } = utmParams(det.epsg);
    const buffer = 250;
    const [flareUtmX, flareUtmY] = wgs84ToUtm(flareLon, flareLat, zone, isNorth);
    const [minX, minY, maxX, maxY] =
        [flareUtmX - buffer, flareUtmY - buffer, flareUtmX + buffer, flareUtmY + buffer];

    document.querySelectorAll('.event-item').forEach(el => el.classList.remove('loading'));
    document.querySelector('.event-item.active')?.classList.add('loading');

    try {
        // windowed read via the s2e COG glue — same I/O path as the detector
        const { image, bbox: imgBbox, width, height, resX, resY } = await openCOG(url);
        const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;

        const x0 = Math.max(0, Math.floor((minX - imgMinX) / resX));
        const y0 = Math.max(0, Math.floor((imgMaxY - maxY) / resY));
        const x1 = Math.min(width, Math.ceil((maxX - imgMinX) / resX));
        const y1 = Math.min(height, Math.ceil((imgMaxY - minY) / resY));

        const windowWidth = x1 - x0, windowHeight = y1 - y0;
        if (windowWidth <= 0 || windowHeight <= 0) throw new Error('Outside image bounds');

        const sw = utmToWgs84(imgMinX + x0 * resX, imgMaxY - y1 * resY, zone, isNorth);
        const ne = utmToWgs84(imgMinX + x1 * resX, imgMaxY - y0 * resY, zone, isNorth);
        const bounds = [sw[0], sw[1], ne[0], ne[1]];

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
                const [r, g, b] = rampRGB(t);
                imgData.data[i * 4] = r;
                imgData.data[i * 4 + 1] = g;
                imgData.data[i * 4 + 2] = b;
                imgData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        clearCogLayers();

        const corners = [[bounds[0], bounds[3]], [bounds[2], bounds[3]], [bounds[2], bounds[1]], [bounds[0], bounds[1]]];

        map.addSource('cog-source', { type: 'image', url: canvas.toDataURL(), coordinates: corners });
        map.addSource('cog-border', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] } }
        });
        map.addLayer({ id: 'cog-layer', type: 'raster', source: 'cog-source',
            paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' } }, 'detections');
        map.addLayer({ id: 'cog-border', type: 'line', source: 'cog-border',
            paint: { 'line-color': '#ffffff', 'line-width': 1 } }, 'detections');

        greyCircles(true);
        document.querySelector('.event-item.active')?.classList.remove('loading');
        dimSatellite(map, true);
    } catch (err) {
        console.error('Failed to load COG:', err);
        document.querySelector('.event-item.active')?.classList.remove('loading');
    }
}

// ── csv export ──

function downloadFlareCSV() {
    if (!current || isVnf()) return;
    const props = current;
    const [lon, lat] = coords(current);
    const detections = parseDets(props);

    const rows = [['facility', 'terminal', 'lat', 'lon', 'date', 'max_b12', 'pixels', 'persistence', 'passes', 'observations']];
    const persistStr = props.persistence != null ? Number(props.persistence).toFixed(4) : '';
    const passStr = props.passes != null ? String(props.passes) : '';
    const obsStr = props.observations != null ? String(props.observations) : '';
    for (const det of detections) {
        rows.push([
            `"${(props.name || '').replace(/"/g, '""')}"`,
            `"${(props.terminal || '').replace(/"/g, '""')}"`,
            det.raw_lat?.toFixed(6) || lat.toFixed(6),
            det.raw_lon?.toFixed(6) || lon.toFixed(6),
            det.date,
            det.max_b12?.toFixed(4) || '',
            det.pixels || '',
            persistStr,
            passStr,
            obsStr
        ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(props.name || 'flare').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-detections.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
