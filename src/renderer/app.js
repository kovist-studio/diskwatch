'use strict';

// Renderer shell logic: tab switching and a fake-timer demo of the block field.
// No scan is wired yet — this drives BlockField the way real scan:progress
// events will later, so the swap is a drop-in.

(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Tabs ----------
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const views = {
    scan: document.getElementById('view-scan'),
    security: document.getElementById('view-security'),
    clean: document.getElementById('view-clean'),
  };

  function currentTab() {
    const active = tabs.find((t) => t.classList.contains('tab--active'));
    return active ? active.dataset.tab : 'scan';
  }

  function selectTab(name, focus) {
    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('tab--active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.tabIndex = active ? 0 : -1;
      if (active && focus) t.focus();
    });
    Object.keys(views).forEach((k) => {
      if (views[k]) views[k].hidden = k !== name;
    });
  }

  tabs.forEach((t) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab, false));
  });

  // Roving arrow-key navigation for the vertical tablist.
  const tablist = document.querySelector('.rail__tabs');
  if (tablist) {
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.dataset.tab === currentTab());
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = (idx + dir + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.tab, true);
    });
  }

  // ---------- Block field + fake scan ----------
  const field = new window.BlockField(document.getElementById('blockfield'));

  const elFiles = document.getElementById('stat-files');
  const elSize = document.getElementById('stat-size');
  const elPct = document.getElementById('stat-pct');
  const elStatus = document.getElementById('scan-status');
  const elPath = document.getElementById('scan-path');
  const chooseBtn = document.getElementById('choose');

  const FAKE_FILES = 34286;
  const FAKE_BYTES = 723290140;
  const FAKE_PATH = '~/Downloads';

  function formatBytes(n) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const decimals = v < 10 && i > 0 ? 1 : 0;
    return v.toFixed(decimals) + ' ' + units[i];
  }

  function paint(p) {
    field.setProgress(p);
    elFiles.textContent = Math.round(p * FAKE_FILES).toLocaleString();
    elSize.textContent = formatBytes(Math.round(p * FAKE_BYTES));
    elPct.textContent = Math.round(p * 100) + '%';
  }

  function showInvitation() {
    elStatus.textContent = 'Choose a folder to see what’s using space.';
    elPath.textContent = '';
    paint(0);
  }

  let rafId = 0;
  let loopTimer = 0;

  function stopFake() {
    if (rafId) cancelAnimationFrame(rafId);
    if (loopTimer) clearTimeout(loopTimer);
    rafId = 0;
    loopTimer = 0;
  }

  function runFakeScan() {
    stopFake();
    elStatus.textContent = 'Scanning';
    elPath.textContent = FAKE_PATH;

    // Reduced motion: fill instantly to a representative state, no animation.
    if (reduceMotion) {
      paint(0.66);
      return;
    }

    const FILL_MS = 4500;
    const HOLD_MS = 1100;
    const start = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - start) / FILL_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      paint(eased);
      if (t < 1) {
        rafId = requestAnimationFrame(frame);
      } else {
        elStatus.textContent = 'Done';
        loopTimer = setTimeout(() => {
          paint(0);
          runFakeScan();
        }, HOLD_MS);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  chooseBtn.addEventListener('click', runFakeScan);

  // Start on the invitation, then kick off the demo so the field is visibly
  // animating. (Clicking "Choose a folder" restarts it.)
  showInvitation();
  if (reduceMotion) {
    runFakeScan();
  } else {
    setTimeout(runFakeScan, 500);
  }
})();
