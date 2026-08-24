'use strict';

// Renderer shell logic: tab switching and the live scan readout.
//
// Everything shown here is a count that actually happened. There is no
// progress percentage: a directory walk has no denominator until it finishes,
// so a percentage would have to be invented. What replaces it is the block
// field (a counter at a stated scale) plus ELAPSED and the path currently
// being read — between them, a slow scan is distinguishable from a hung one
// without anybody guessing at a total.

(function () {
  const api = window.api;

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

  // ---------- Elements ----------
  const elStatus = document.getElementById('scan-status');
  const elRoot = document.getElementById('scan-path');
  const elScale = document.getElementById('scan-scale');
  const elReading = document.getElementById('reading');
  const elCurrent = document.getElementById('scan-current');
  const elFiles = document.getElementById('stat-files');
  const elSize = document.getElementById('stat-size');
  const elElapsed = document.getElementById('stat-elapsed');
  const chooseBtn = document.getElementById('choose');
  const cancelBtn = document.getElementById('cancel');

  // ---------- Formatting ----------
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

  function formatSeconds(ms) {
    return Math.floor(ms / 1000) + 's';
  }

  // Home directory, once available, so paths read as ~/Library rather than
  // /Users/someone/Library. Resolved from main — the sandboxed renderer has no
  // `os` module of its own.
  let home = '';

  function shorten(p) {
    if (!p) return '';
    if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
    return p;
  }

  // Left truncation, measured rather than guessed. The tail of a path is the
  // informative half, so the head is what gets dropped. The readout is
  // monospaced, so one character's width describes them all.
  //
  // Measured with the layout engine rather than canvas measureText: canvas
  // wants a parsable font shorthand, and if it can't parse the stack it
  // silently falls back to 10px sans-serif — which would look like a working
  // measurement while quietly sizing against the wrong font.
  let charW = 0;

  function charWidth(el) {
    if (charW) return charW;
    const cs = getComputedStyle(el);
    const ruler = document.createElement('span');
    ruler.textContent = '0'.repeat(100);
    ruler.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;top:0;left:0;pointer-events:none';
    ruler.style.font = cs.font;
    ruler.style.fontFamily = cs.fontFamily;
    ruler.style.fontSize = cs.fontSize;
    ruler.style.fontWeight = cs.fontWeight;
    ruler.style.letterSpacing = cs.letterSpacing;
    ruler.style.fontVariantNumeric = cs.fontVariantNumeric;
    document.body.appendChild(ruler);
    const w = ruler.getBoundingClientRect().width / 100;
    ruler.remove();
    charW = w > 0 ? w : 7;
    return charW;
  }

  let currentFull = '';

  function paintCurrent() {
    const text = currentFull;
    const width = elCurrent.clientWidth;
    if (!width) {
      elCurrent.textContent = text;
      return;
    }
    const max = Math.max(8, Math.floor(width / charWidth(elCurrent)));
    elCurrent.textContent =
      text.length <= max ? text : '…' + text.slice(text.length - (max - 1));
    elCurrent.title = text;
  }

  function setCurrentPath(p) {
    currentFull = shorten(p);
    paintCurrent();
  }

  window.addEventListener('resize', paintCurrent);

  // ---------- Block field ----------
  function setScaleLabel(quantum, bump) {
    elScale.textContent = `1 block = ${quantum.toLocaleString()} ${
      quantum === 1 ? 'file' : 'files'
    }`;
    if (!bump) return;
    // The field halves at a rescale; the flash marks that as a change of scale
    // rather than lost ground.
    elScale.classList.add('field__scale--bump');
    clearTimeout(setScaleLabel.timer);
    setScaleLabel.timer = setTimeout(() => {
      elScale.classList.remove('field__scale--bump');
    }, 700);
  }

  const field = new window.BlockField(document.getElementById('blockfield'), {
    quantum: 25,
    onScaleChange: (q) => setScaleLabel(q, true),
  });

  // ---------- Elapsed clock ----------
  // Ticks on its own timer, not on scan progress. That is the point: when a
  // single directory stalls for ten seconds, progress messages stop but
  // ELAPSED keeps counting, and the scan reads as slow rather than dead.
  let clockTimer = 0;
  let startedAt = 0;

  function startClock() {
    stopClock();
    startedAt = Date.now();
    elElapsed.textContent = '0s';
    clockTimer = setInterval(() => {
      elElapsed.textContent = formatSeconds(Date.now() - startedAt);
    }, 200);
  }

  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = 0;
    if (startedAt) elElapsed.textContent = formatSeconds(Date.now() - startedAt);
  }

  // ---------- Scan ----------
  let scanning = false;
  let generation = 0; // guards against a superseded scan settling over a newer one
  let lastFiles = 0;
  let lastBytes = 0;

  function setBusy(busy) {
    scanning = busy;
    cancelBtn.hidden = !busy;
    cancelBtn.disabled = false;
    elReading.hidden = !busy;
    field.setActive(busy);
  }

  function showCounts(files, bytes) {
    elFiles.textContent = files.toLocaleString();
    elSize.textContent = formatBytes(bytes);
  }

  function showInvitation() {
    elStatus.textContent = 'Choose a folder to see what’s using space.';
    elRoot.textContent = '';
    setCurrentPath('');
    showCounts(0, 0);
    elElapsed.textContent = '0s';
    setScaleLabel(field.baseQuantum, false);
  }

  async function runScan(target) {
    const gen = ++generation;

    lastFiles = 0;
    lastBytes = 0;
    field.reset();
    setScaleLabel(field.quantum, false);
    showCounts(0, 0);
    setBusy(true);
    elStatus.textContent = 'Scanning';
    elRoot.textContent = shorten(target);
    setCurrentPath(target);
    startClock();

    let result = null;
    let error = null;
    try {
      result = await api.scan.start(target);
    } catch (err) {
      error = err;
    }

    // A newer scan already owns the readout — let it be.
    if (gen !== generation) return;

    stopClock();
    setBusy(false);

    if (error) {
      elStatus.textContent = 'Couldn’t read that folder';
      setCurrentPath('');
      return;
    }

    // Counts only ever move forward. The done payload is authoritative on a
    // completed scan; on a cancel that had to be forced it can come back
    // zeroed, and the last real progress numbers are the honest ones.
    const files = Math.max(lastFiles, result.filesSeen || 0);
    const bytes = Math.max(lastBytes, result.bytesSeen || 0);
    field.setFiles(files);
    showCounts(files, bytes);
    setCurrentPath('');
    elStatus.textContent = result.cancelled ? 'Scan stopped' : 'Done';
  }

  if (api && api.scan) {
    api.scan.onProgress((p) => {
      if (!scanning || !p) return;
      lastFiles = p.filesSeen;
      lastBytes = p.bytesSeen;
      field.setFiles(p.filesSeen);
      showCounts(p.filesSeen, p.bytesSeen);
      if (p.path) setCurrentPath(p.path);
    });
  }

  chooseBtn.addEventListener('click', async () => {
    const target = await api.chooseFolder();
    if (!target) return;
    runScan(target);
  });

  cancelBtn.addEventListener('click', async () => {
    if (!scanning) return;
    cancelBtn.disabled = true;
    elStatus.textContent = 'Stopping';
    await api.scan.cancel();
    // runScan's promise settles on its own once the worker unwinds.
  });

  // ---------- Start ----------
  if (!api) {
    chooseBtn.disabled = true;
    elStatus.textContent = 'Unavailable';
    return;
  }

  api.platform().then((info) => {
    home = info && info.home ? info.home : '';
  });

  showInvitation();
})();
