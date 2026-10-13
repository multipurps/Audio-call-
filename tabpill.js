/* Liquid pill for the bottom tab bar. Two edges chase the active tab with different speeds, so the pill stretches
   toward the tab it is moving to and then settles. It follows the tab's real position every frame, including while
   the tab opens up to show its title. Reduced-motion users get an instant move. */
(() => {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  let pill = bar.querySelector('.tabPill');
  if (!pill) { pill = document.createElement('span'); pill.className = 'tabPill'; pill.setAttribute('aria-hidden', 'true'); bar.prepend(pill); }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let L = null, R = null, raf = 0, until = 0, last = 0, cur = -1, movingRight = true;

  const target = () => {
    const a = bar.querySelector('.tabBtn.active');
    if (!a || a.offsetWidth === 0) return null;
    const tabs = [...bar.querySelectorAll('.tabBtn')].filter((b) => b.offsetWidth > 0);
    return { l: a.offsetLeft, r: a.offsetLeft + a.offsetWidth, idx: tabs.indexOf(a) };
  };
  const draw = (w) => {
    const stretch = Math.max(0, (R - L) - w);
    pill.style.width = (R - L).toFixed(2) + 'px';
    pill.style.transform = `translate3d(${L.toFixed(2)}px,0,0) scale(1,${(1 - Math.min(0.14, stretch / 520)).toFixed(3)})`;
    pill.style.opacity = '1';
  };
  const step = (now) => {
    const t = target();
    if (!t) { raf = 0; return; }
    const dt = Math.min(48, now - (last || now)); last = now;
    if (L === null || reduce.matches) { L = t.l; R = t.r; draw(t.r - t.l); raf = 0; return; }
    if (t.idx !== cur) { movingRight = t.idx >= cur; cur = t.idx; }
    const k = (base) => 1 - Math.pow(1 - base, dt / 16.7);
    const lead = k(0.30), trail = k(0.13);
    L += (t.l - L) * (movingRight ? trail : lead);
    R += (t.r - R) * (movingRight ? lead : trail);
    draw(t.r - t.l);
    if (Math.abs(t.l - L) < 0.4 && Math.abs(t.r - R) < 0.4 && now > until) { L = t.l; R = t.r; draw(t.r - t.l); raf = 0; last = 0; return; }
    raf = requestAnimationFrame(step);
  };
  const go = () => { until = performance.now() + 750; if (!raf) raf = requestAnimationFrame(step); };

  new MutationObserver(go).observe(bar, { subtree: true, attributes: true, attributeFilter: ['class'] });
  if ('ResizeObserver' in window) new ResizeObserver(go).observe(bar);
  addEventListener('resize', go);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { L = null; go(); });
  go();
})();
