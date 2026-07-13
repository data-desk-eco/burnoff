// dd dot-grid quarter picker (pdf:83): Q1-Q4 header columns, one dot row per
// year — dd-active dots 8px, inactive 3px, dd-unavailable greyed + unclickable
// (pdf:81). owns the selection state; callers mark availability by toggling
// 'dd-unavailable' (or their own classes) on buttons().

import { quarterRange } from './util.js';

export function initQuarters(el, onChange, years = 4) {
    const now = new Date();
    const yr = now.getFullYear(), curQ = Math.floor(now.getMonth() / 3) + 1;
    const cells = [1, 2, 3, 4].map(q => `<span class="dd-secondary">Q${q}</span>`).concat('<span></span>');
    for (let y = yr - years + 1; y <= yr; y++) {
        for (let q = 1; q <= 4; q++)
            cells.push(y === yr && q > curQ ? '<span></span>' :
                `<button class="dd-dot-btn${y >= yr - 1 ? ' dd-active' : ''}" data-q="${y}_${q}" title="Q${q} ${y}"><span class="dd-dot"></span></button>`);
        cells.push(`<span class="dd-secondary">${y}</span>`);
    }
    el.innerHTML = cells.join('');

    el.addEventListener('click', e => {
        const btn = e.target.closest('.dd-dot-btn');
        if (!btn) return;
        // keep at least one *available* quarter selected — deselecting past the
        // last usable one empties the map while unavailable quarters stay
        // phantom-active and unclickable
        if (btn.classList.contains('dd-active') &&
            el.querySelectorAll('.dd-dot-btn.dd-active:not(.dd-unavailable)').length <= 1) return;
        btn.classList.toggle('dd-active');
        onChange?.();
    });

    const api = {
        buttons: () => el.querySelectorAll('.dd-dot-btn'),
        key: btn => btn.dataset.q,
        // active quarter keys (e.g. "2025_3"); non-contiguous selections honoured
        keys: () => new Set([...el.querySelectorAll('.dd-dot-btn.dd-active')].map(b => b.dataset.q)),
        // {startDate, endDate} spanning the active quarters, or null
        range: () => quarterRange(api.keys()),
        hint: text => { document.getElementById('quarters-hint').textContent = text; },
    };
    return api;
}
