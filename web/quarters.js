// dd dot-grid quarter picker (pdf:83): Q1-Q4 header columns, one dot row per
// year — active dots 8px, inactive 3px, unavailable/detected greyed (pdf:81).
// generic widget: owns the selection state and date-window helpers; callers
// mark availability by toggling 'unavailable'/'detected' on quarterButtons().

let _onChange = () => {};

export const quarterButtons = () => document.querySelectorAll('.quarter-btn');
export const quarterKey = btn => `${btn.dataset.year}_${btn.dataset.quarter}`;

export function initQuarterPicker(onChange) {
    _onChange = onChange;
    const container = document.getElementById('quarter-picker');
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
    container.innerHTML = '';

    const span = (cls, text) => {
        const el = document.createElement('span');
        el.className = cls;
        if (text) el.textContent = text;
        container.appendChild(el);
    };
    for (let q = 1; q <= 4; q++) span('dd-secondary', `Q${q}`);
    span('');

    for (const year of [currentYear - 3, currentYear - 2, currentYear - 1, currentYear]) {
        const maxQ = (year === currentYear) ? currentQuarter : 4;
        for (let q = 1; q <= 4; q++) {
            if (q > maxQ) { span(''); continue; }
            const btn = document.createElement('button');
            btn.className = 'dd-dot-btn quarter-btn';
            btn.innerHTML = '<span class="dd-dot"></span>';
            btn.title = `Q${q} ${year}`;
            btn.dataset.year = year;
            btn.dataset.quarter = q;
            if (year >= currentYear - 1) btn.classList.add('active');
            btn.addEventListener('click', () => toggleQuarter(btn));
            container.appendChild(btn);
        }
        span('dd-secondary', year);
    }
}

function toggleQuarter(btn) {
    const wasActive = btn.classList.contains('active');
    // count only quarters that have data here — keep at least one *available* one
    // selected, else deselecting past the last usable quarter empties the map while
    // unavailable (no-data) quarters stay phantom-active and unclickable.
    const activeCount = document.querySelectorAll('.quarter-btn.active:not(.unavailable)').length;
    if (wasActive && activeCount <= 1) return;
    btn.classList.toggle('active');
    _onChange();
}

export function setQuarterHint(text) {
    const el = document.getElementById('quarter-hint');
    if (el) el.textContent = text;
}

/** [startDate, endDate] spanning the active quarters, or null if none selected. */
export function getSelectedDateRange() {
    const activeBtns = document.querySelectorAll('.quarter-btn.active');
    if (activeBtns.length === 0) return null;

    const quarterStart = (year, q) => `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    const quarterEnd = (year, q) => {
        const endMonth = q * 3;
        const d = new Date(year, endMonth, 0);
        return `${year}-${String(endMonth).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    let minDate = null, maxDate = null;
    for (const btn of activeBtns) {
        const y = parseInt(btn.dataset.year);
        const q = parseInt(btn.dataset.quarter);
        const start = quarterStart(y, q);
        const end = quarterEnd(y, q);
        if (!minDate || start < minDate) minDate = start;
        if (!maxDate || end > maxDate) maxDate = end;
    }
    return { startDate: minDate, endDate: maxDate };
}

// Active quarter keys (e.g. "2025_3"). Non-contiguous selections are honoured
// exactly — used to filter a cluster card's per-date detections to the window.
export function activeQuarterKeys() {
    const keys = new Set();
    document.querySelectorAll('.quarter-btn.active').forEach(b => keys.add(quarterKey(b)));
    return keys;
}

export function dateInActiveQuarters(dateStr, keys) {
    if (!keys.size) return true;
    const q = Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1;
    return keys.has(`${dateStr.slice(0, 4)}_${q}`);
}
