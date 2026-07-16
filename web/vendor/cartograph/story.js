// scrollytelling: config.story is an array of steps whose dd cards scroll
// over the map; the step crossing the viewport's middle band drives the map
// through native camera moves — flyTo (or fitBounds when camera.bounds is
// set), exact visibility over the union of story-managed layers, an optional
// globe spin (deg/s) and onEnter/onExit hooks. #step= permalinks restore.

import { getHashParam, setHashParam } from './util.js';

export function initStory(ctx) {
    const { map, config } = ctx;
    const steps = config.story;
    const managed = [...new Set(steps.flatMap(s => s.layers || []))];
    let cur = -1, spinning = null;

    // continuous globe rotation: chained one-second linear easeTo hops
    const spin = dps => {
        const t = spinning = {};
        const loop = () => spinning === t && map
            .easeTo({ center: [map.getCenter().lng + dps, map.getCenter().lat], duration: 1000, easing: x => x })
            .once('moveend', loop);
        map.isMoving() ? map.once('moveend', loop) : loop();
    };

    const go = i => {
        if (i === cur) return;
        steps[cur]?.onExit?.(ctx);
        const s = steps[i], jump = cur < 0;   // first activation lands, no flight
        cur = i;
        spinning = null;
        for (const id of managed)
            map.setLayoutProperty(id, 'visibility', (s.layers || []).includes(id) ? 'visible' : 'none');
        const c = s.camera && (jump ? { ...s.camera, duration: 0 } : s.camera);
        if (c) c.bounds ? map.fitBounds(c.bounds, c) : map.flyTo(c);
        if (s.spin) spin(s.spin);
        history.replaceState(null, '', location.pathname + location.search
            + setHashParam(location.hash, 'step', i ? s.id ?? i : null));
        s.onEnter?.(ctx);
    };

    for (const id of managed) map.setLayoutProperty(id, 'visibility', 'none');
    const io = new IntersectionObserver(
        es => es.forEach(e => e.isIntersecting && go(+e.target.dataset.i)),
        { root: document.getElementById('story'), rootMargin: '-45% 0px -45% 0px' });
    const sections = document.querySelectorAll('.cg-step');
    sections.forEach(el => io.observe(el));

    const h = getHashParam(location.hash, 'step');
    const at = h == null ? 0 : steps.findIndex((s, i) => String(s.id ?? i) === h);
    if (at > 0) sections[at].scrollIntoView({ block: 'center', behavior: 'instant' });
}
