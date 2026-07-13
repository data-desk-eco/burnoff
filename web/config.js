// burnoff on cartograph — this config plus the hook modules: render.js (mode
// look-up tables + ramp), card.js (detail card body), detect.js (local detect
// + p2p, lazy), s2archive.js / vnf.js (hyparquet parquet readers) and
// clustering.js (feature builders). two data modes share one detection layer:
// s2 (archive clusters, detect fallback) and vnf (viirs nightfire).

import { mount } from './vendor/cartograph/app.js';
import { showDetail, closeDetail } from './vendor/cartograph/detail.js';
import { viewportBbox, boxesWorldmap, ensureMark } from './vendor/cartograph/shell.js';
import { padBbox, featureBbox, getHashParam } from './vendor/cartograph/util.js';
import { MODE, RAMP, DD, markIconExpr, ICON_SIZE } from './render.js';
import { initVNF, resetVNF, queryVNF, queryVNFFlare, availableQuartersVNF, isReady as vnfReady } from './vnf.js';
import { initS2Archive, queryS2Archive, availableQuartersS2, isReady as s2ArchiveReady, isCovered, coverageTiles, whenCovered } from './s2archive.js';
import { initDetect, ensureDetect, isDetecting, updateDetectionSource, getDetectedQuarters, updateDetectButton, MIN_DETECT_ZOOM } from './detect.js';
import { initCard, cardTitle, cardHtml, onCardShow, onCardClose, refreshCard, reselectCurrentFeature } from './card.js';
import { setTerminals, archiveFeature, enrichVNFFeatures } from './clustering.js';

// legacy deep links: #vnf/123 -> #vnf=123 (cartograph hash params)
if (/^#vnf\/\d+$/.test(location.hash))
    history.replaceState(null, '', location.hash.replace('/', '='));

// ---------------------------------------------------------------------------
// build config (index.html meta tags) + mode state ('s2' or 'vnf')
// ---------------------------------------------------------------------------

// vnf parquet lives in the shared s2-flares CloudFerro archive at a stable key
// (vnf/data.parquet) — public-read, hyparquet range-reads it remotely. set via
// <meta name="vnf-url">; localhost (or an unset url) falls back to a local build.
const VNF_URL = document.querySelector('meta[name="vnf-url"]')?.content || '';
const vnfUrl = () => (location.hostname === 'localhost' || !VNF_URL) ? 'vnf.parquet' : VNF_URL;

// s2 mode reads the precomputed cluster view straight from the CloudFerro parquet
// archive (s2-flares `box.sh publish`); the in-browser COG worker ("Detect")
// stays as the fallback for areas not yet archived. warm the archive
// cache at page parse, overlapping maplibre init.
const S2_ARCHIVE = document.querySelector('meta[name="s2-archive"]')?.content || '';
if (S2_ARCHIVE) initS2Archive(S2_ARCHIVE);

const MIN_ARCHIVE_ZOOM = 4;   // displaying precomputed archive clusters (cheap, in-memory)
const MIN_VNF_ZOOM = 6;

// date span the quarter grid covers (last 4 calendar years) — bounds the vnf
// availability query so it stays cheap
const GRID_START = `${new Date().getFullYear() - 3}-01-01`;
const GRID_END = `${new Date().getFullYear()}-12-31`;

let mode = null;
const modeConf = () => MODE[mode] || MODE.s2;
const isVnf = () => mode === 'vnf';

// slider state. the avg-B12 / avg-RH intensity gate is the active quality gate;
// the persistence gate is display-only (a layer filter, no re-cluster)
const GATE = { s2: MODE.s2.filter.default, vnf: MODE.vnf.filter.default };
let PERSISTENCE_MIN = 0.25;

let CTX;                                    // cartograph ctx (set in sources)
let readyResolve;
const whenReady = new Promise(r => readyResolve = r);

const persistenceFilter = v => ['>=', ['coalesce', ['get', 'persistence'], 0], v];
const setDetections = features =>
    CTX.map.getSource('detections')?.setData({ type: 'FeatureCollection', features });

// programmatic mode switch routed through the toggle so the ui stays in sync
const setMode = m => document.querySelector(`.cg-filter[data-key="mode"] [data-value="${m}"]`)?.click();

// ---------------------------------------------------------------------------
// vnf mode
// ---------------------------------------------------------------------------

let _vnfInitStarted = false, _vnfRaw = null, _vnfTimer = null;

async function refreshVNF() {
    if (!isVnf() || !vnfReady()) return;
    if (CTX.map.getZoom() < MIN_VNF_ZOOM) { _vnfRaw = null; setDetections([]); return; }
    const range = CTX.quarters.range();
    if (!range) return;
    try {
        const fc = await queryVNF(viewportBbox(CTX.map), range.startDate, range.endDate);
        _vnfRaw = fc.features;
        if (isVnf()) updateVNFSource();
    } catch (err) { console.error('VNF query error:', err); }
}

const scheduleVNFRefresh = () => { clearTimeout(_vnfTimer); _vnfTimer = setTimeout(refreshVNF, 200); };
const updateVNFSource = () => { if (_vnfRaw) setDetections(enrichVNFFeatures(_vnfRaw, GATE.vnf)); };

// ---------------------------------------------------------------------------
// s2 archive mode — read precomputed detections for the viewport, falling back
// to whatever is already in the CRDT (local-worker / synced detections)
// ---------------------------------------------------------------------------

let _s2Timer = null;

// archive builds serve precomputed clusters, so the local-worker detect path —
// and the p2p mesh that shares its workload — only make sense where the archive
// has no coverage: reveal Detect / peer status there, hide them where the
// archive serves. no-op in pure detect builds, which always expose the controls.
function updateS2Controls() {
    if (!S2_ARCHIVE) return;
    const show = mode === 's2' && s2ArchiveReady() &&
        CTX.map.getZoom() >= MIN_DETECT_ZOOM && !isCovered(viewportBbox(CTX.map)) && !isDetecting();
    if (show) ensureDetect();   // outside coverage the detect/p2p path is live
    for (const sel of ['#peer-status', '#detect-area'])
        document.querySelector(sel)?.style.setProperty('display', show ? '' : 'none');
}

async function refreshS2Archive() {
    updateS2Controls();
    if (mode !== 's2' || !S2_ARCHIVE || isDetecting()) return;
    if (!s2ArchiveReady() || CTX.map.getZoom() < MIN_ARCHIVE_ZOOM) { updateDetectionSource(); return; }
    const range = CTX.quarters.range();
    if (!range) { updateDetectionSource(); return; }
    try {
        const clusters = await queryS2Archive(viewportBbox(CTX.map), range.startDate, range.endDate);
        if (mode !== 's2' || isDetecting()) return;
        const features = clusters.filter(c => c.avg_b12 >= GATE.s2).map(archiveFeature);
        if (!features.length) { updateDetectionSource(); return; }
        setDetections(features);
    } catch (err) {
        console.error('S2 archive query error:', err);
        updateDetectionSource();
    }
}

function scheduleS2Refresh() {
    if (!S2_ARCHIVE) return;
    clearTimeout(_s2Timer);
    _s2Timer = setTimeout(refreshS2Archive, 200);
}

// refresh the whole s2 view. in archive builds the archive overlay owns the
// detections source, so a plain updateDetectionSource() (CRDT only) would wipe
// it — route through the archive path, which falls back to the CRDT where the
// archive is empty. used by the sync-debounce and slider callers.
const refreshS2View = () => S2_ARCHIVE ? refreshS2Archive() : updateDetectionSource();

// detect.js render callback: re-draw the s2 view after CRDT/worker updates
const renderDetections = () => { if (mode === 's2') refreshS2View(); };

// kick the archive when entering s2 mode; initS2Archive memoizes, so this only
// awaits the warm-up fired at page parse before refreshing the viewport
function ensureS2Archive() {
    if (!S2_ARCHIVE) return;
    initS2Archive(S2_ARCHIVE)
        .then(() => { if (mode === 's2') { refreshS2Archive(); updateQuarterIndicators(); } })
        .catch(err => console.error('S2 archive init error:', err));
}

// ---------------------------------------------------------------------------
// quarter availability indicators
// ---------------------------------------------------------------------------

// mark each quarter dot: 'detected' (local-worker s2, already processed) or
// 'dd-unavailable' (archive/vnf, no data in this viewport). a null `avail`
// means the data source isn't ready / zoomed-out — leave everything enabled.
// uncovered s2 viewports fall through to the detect branch (same coverage test
// that reveals the Detect button) so quarters stay selectable for the fallback.
async function updateQuarterIndicators() {
    const q = CTX.quarters, btns = [...q.buttons()];

    if (isVnf() || (S2_ARCHIVE && isCovered(viewportBbox(CTX.map)))) {
        btns.forEach(b => b.classList.remove('detected'));
        const ready = isVnf() ? vnfReady() : s2ArchiveReady();
        const zoomOk = CTX.map.getZoom() >= (isVnf() ? MIN_VNF_ZOOM : MIN_DETECT_ZOOM);
        let avail = null;
        if (ready && zoomOk) {
            try {
                avail = isVnf()
                    ? await availableQuartersVNF(padBbox(viewportBbox(CTX.map)), GRID_START, GRID_END)
                    : await availableQuartersS2(padBbox(viewportBbox(CTX.map)));
            } catch (err) { console.error('quarter availability error:', err); }
        }
        btns.forEach(b => b.classList.toggle('dd-unavailable', !!avail && !avail.has(q.key(b))));
        // every selected quarter is unavailable here -> the map is blank; say why
        const blank = !!avail && !btns.some(b => b.classList.contains('dd-active') && avail.has(q.key(b)));
        q.hint(blank ? `No ${isVnf() ? 'VNF' : 'archive'} data for the selected quarters here` : '');
        return;
    }

    q.hint('');
    btns.forEach(b => b.classList.remove('dd-unavailable'));
    const done = getDetectedQuarters();
    btns.forEach(b => b.classList.toggle('detected', done.has(q.key(b))));
    updateDetectButton(done);
}

// ---------------------------------------------------------------------------
// mode switching
// ---------------------------------------------------------------------------

const keySections = cfg => [
    {
        label: cfg.label,
        rows: [...cfg.stops].reverse().map((v, i) => ({
            swatch: { mark: 'flare', color: RAMP[2 - i] }, label: i === 0 ? `${v}+` : String(v) })),
    },
    {
        label: 'Infrastructure',
        rows: [{ swatch: { mark: 'triangle', color: DD.white }, label: 'LNG',
                 toggle: ['lng-terminal-dots', 'lng-terminal-hitarea'] }],
    },
];

function switchMode(m) {
    if (m === mode) return;
    mode = m;
    const cfg = MODE[m];

    document.querySelector('#main-panel .dd-subtitle').textContent = cfg.subtitle;
    document.getElementById('main-panel').classList.toggle('mode-s2', m === 's2');
    closeDetail();
    CTX.setKey(keySections(cfg));

    // retune the intensity slider for the mode
    const { min, max, step } = cfg.filter;
    CTX.sliders.intensity.set({ min, max, step, value: GATE[m], format: cfg.formatFilter });

    updateQuarterIndicators();

    if (m === 'vnf') {
        setDetections([]);   // clear s2 features so they don't linger during load
        if (!_vnfInitStarted) {
            _vnfInitStarted = true;
            initVNF(vnfUrl()).then(() => {
                if (isVnf()) { refreshVNF(); updateQuarterIndicators(); }
            }).catch(err => {
                console.error('VNF init error:', err);
                _vnfInitStarted = false;
                resetVNF();
                setMode('s2');
            });
        } else if (vnfReady()) refreshVNF();
    } else {
        updateDetectionSource();
        ensureS2Archive();
    }

    updateS2Controls();
    CTX.map.setLayoutProperty('detections', 'icon-image', markIconExpr(cfg));
}

// ---------------------------------------------------------------------------
// sliders + deep links
// ---------------------------------------------------------------------------

let _sliderTimer;
function debouncedRecluster() {
    clearTimeout(_sliderTimer);
    _sliderTimer = setTimeout(() => {
        if (isVnf()) updateVNFSource(); else refreshS2View();
        reselectCurrentFeature();
    }, 80);
}

// #vnf=<id> permalink over a dynamic source: switch to vnf mode, wait for the
// parquet, query the single flare
async function resolveFlare(id) {
    await whenReady;
    setMode('vnf');
    const deadline = Date.now() + 15000;
    while (!vnfReady() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const range = CTX.quarters.range();
    if (!vnfReady() || !range) return null;
    const fc = await queryVNFFlare(id, range.startDate, range.endDate);
    return enrichVNFFeatures(fc.features.slice(0, 1), GATE.vnf)[0] ?? null;
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

mount({
    title: 'Burnoff',
    subtitle: MODE.s2.subtitle,
    map: { center: [51.52, 25.92], zoom: 12, minZoom: 1.5, maxZoom: 18 },
    about: `
        <div class="region-row">
            <div><div class="dd-secondary">Regions covered:</div><div>Data Desk archive</div></div>
            <svg id="modal-worldmap"></svg>
        </div>
        <p>Burnoff is an experiment in distributed detection and analysis of gas flaring using Sentinel-2 satellite data, hosted by <a href="https://datadesk.eco">Data Desk</a>. It aims to be a useful tool for researchers, journalists and others monitoring the activities of the fossil fuel industry.</p>
        <p>Detections from the Data Desk archive are shown automatically. For areas we haven't covered yet, click <em>Detect</em> to download and process Sentinel-2 satellite data for the current view, sharing the workload &mdash; and syncing the results &mdash; with connected peers via <a href="https://en.wikipedia.org/wiki/WebRTC">WebRTC</a>.</p>
        <p>Click any detection to view the underlying data and flare analysis, and compare to <a href="https://eogdata.mines.edu/products/vnf/global_gas_flare.html" target="_blank">VIIRS Nightfire</a> data using <em>VNF</em> mode.</p>
        <div class="methods">
            <div class="methods-head" id="methods-toggle"><span class="dd-chevron dd-chevron-down"></span><span class="dd-secondary">Methods &amp; data</span></div>
            <div class="methods-list dd-secondary hidden" id="methods-list">
                <p>Faruolo et al. (2024) <a href="https://doi.org/10.1088/1748-9326/ad82fb" target="_blank">The DAFI v2 algorithm for gas flare detection</a></p>
                <p>Elvidge et al. (2013) <a href="https://doi.org/10.3390/rs5094423" target="_blank">VIIRS Nightfire: Satellite pyrometry at night</a></p>
                <p>Global Energy Monitor <a href="https://globalenergymonitor.org/projects/global-gas-infrastructure-tracker/" target="_blank">Global Gas Infrastructure Tracker</a></p>
                <p>Design by <a href="https://mikaeldahlen.com/" target="_blank">Mikael Dahlén</a></p>
            </div>
        </div>`,

    // the detections source is dynamic (mode/viewport handlers own its data);
    // terminals are static geojson
    sources: async ctx => {
        CTX = ctx;
        const terminals = await (await fetch('terminals.geojson')).json();
        terminals.features = terminals.features.filter(f => f.properties.type === 'export');
        setTerminals(terminals.features);
        return {
            detections: { type: 'FeatureCollection', features: [] },
            'lng-terminals': terminals,
        };
    },

    layers: [
        {
            // flare markings stepped through the intensity ramp; the persistence
            // slider gates display-only via this layer filter
            id: 'detections', type: 'symbol', source: 'detections',
            filter: persistenceFilter(0.25),
            layout: {
                'icon-image': markIconExpr(MODE.s2),
                'icon-size': ICON_SIZE,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
            },
        },
        {
            // lng terminal triangles with a generous hit area
            id: 'lng-terminal-hitarea', type: 'circle', source: 'lng-terminals',
            hover: p => `<span class="dd-title">${p.name}</span><br>${p.country} · ${p.type}<br>`
                + (p.capacity_mtpa ? `${p.capacity_mtpa} mtpa` : '—'),
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 6, 16, 12, 22],
                'circle-color': 'transparent',
                'circle-opacity': 0,
            },
        },
        {
            id: 'lng-terminal-dots', type: 'symbol', source: 'lng-terminals',
            layout: {
                'icon-image': 'triangle-#FFFFFF',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.65, 12, 0.9],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
            },
        },
    ],

    filters: [{
        key: 'mode', value: 's2',
        options: [{ value: 's2', label: 'S2' }, { value: 'vnf', label: 'VNF' }],
        onChange: switchMode,
    }],

    quarters: {
        onChange: () => {
            if (isVnf()) scheduleVNFRefresh();
            else { updateDetectButton(); scheduleS2Refresh(); }
            // re-filter the open card to the new window (the async re-query reconciles the map)
            refreshCard();
        },
    },

    sliders: [
        {
            key: 'intensity', label: 'Minimum intensity',
            min: MODE.s2.filter.min, max: MODE.s2.filter.max, step: MODE.s2.filter.step,
            value: MODE.s2.filter.default, format: MODE.s2.formatFilter,
            onInput: v => { GATE[isVnf() ? 'vnf' : 's2'] = v; debouncedRecluster(); },
        },
        {
            key: 'persistence', label: 'Minimum persistence',
            min: 0, max: 1, step: 0.05, value: 0.25, format: v => `${Math.round(v * 100)}%`,
            onInput: v => { PERSISTENCE_MIN = v; CTX.map.setFilter('detections', persistenceFilter(v)); },
        },
    ],

    key: () => keySections(MODE.s2),

    detail: {
        layers: ['detections'],
        hashKey: 'vnf', idProp: 'flare_id',
        flyZoom: 15, minZoom: 10,
        title: cardTitle,
        html: cardHtml,
        onShow: onCardShow,
        onClose: onCardClose,
        resolve: resolveFlare,
    },

    ready: ctx => {
        // s2-only controls: peers indicator beside the mode toggle, detect
        // button + progress at the panel foot
        document.querySelector('.cg-filter[data-key="mode"]').insertAdjacentHTML('beforeend',
            '<div id="peer-status"><span class="dd-secondary">Peers Connected:</span> <span id="peer-count">0</span></div>');
        document.getElementById('main-panel').insertAdjacentHTML('beforeend', `
            <div class="detect-area s2-only" id="detect-area">
                <button id="detect-btn" class="dd-btn">Detect</button>
                <div id="detect-progress" class="detect-progress hidden">
                    <span id="detect-text">Searching...</span>
                    <div class="detect-bar" id="detect-bar"></div>
                </div>
            </div>`);

        initDetect({
            map: ctx.map, quarters: ctx.quarters,
            render: renderDetections,
            updateQuarters: updateQuarterIndicators,
            minAvgB12: () => GATE.s2,
        });
        initCard({ map: ctx.map, modeConf, isVnf, hasArchive: !!S2_ARCHIVE,
                   quarterKeys: () => ctx.quarters.keys() });

        // marking images referenced only in expressions preload up front
        [...RAMP.map(c => `flare-${c}`), 'triangle-#FFFFFF'].forEach(id => ensureMark(ctx.map, id));

        // intro modal extras: archive coverage worldmap (pdf:86) + methods reveal
        boxesWorldmap(document.getElementById('modal-worldmap'), async () => {
            if (!S2_ARCHIVE) return null;
            await whenCovered();
            return coverageTiles()?.features.map(featureBbox);
        }, 0.06);
        document.getElementById('methods-toggle').addEventListener('click', function () {
            this.querySelector('.dd-chevron').classList.toggle('dd-chevron-down');
            document.getElementById('methods-list').classList.toggle('hidden');
        });

        let _quarterTimer;
        ctx.map.on('moveend', () => {
            clearTimeout(_quarterTimer);
            _quarterTimer = setTimeout(updateQuarterIndicators, 300);
            if (isVnf()) scheduleVNFRefresh();
            else { updateDetectButton(); scheduleS2Refresh(); }
        });

        // archive builds start with the detect/p2p controls hidden until the
        // viewport leaves coverage; pure-detect builds load the CRDT up front
        if (S2_ARCHIVE) updateS2Controls(); else ensureDetect();
        // start in s2 mode unless a #vnf= deep link is resolving
        if (!getHashParam(location.hash, 'vnf')) setMode('s2');
        readyResolve();
    },
});
