'use strict';

// Renderer shell logic: tab switching and the scan lifecycle.
//
// The scan view is a small state machine — empty -> scanning -> results, with
// error and cancelled as terminal states that both offer a way back. Exactly
// one stage is visible at a time and `setStage` is the only thing that decides
// which, so no two stages can ever be half-shown.
//
// Everything displayed is a count that actually happened. There is no progress
// percentage: a directory walk has no denominator until it finishes, so a
// percentage would have to be invented. See DECISIONS.md, P5.

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
  const el = (id) => document.getElementById(id);

  const elStatus = el('scan-status');
  const elRoot = el('scan-path');
  const elScale = el('scan-scale');
  const elReading = el('reading');
  const elCurrent = el('scan-current');
  const elScanNote = el('scan-note');
  const elFiles = el('stat-files');
  const elSize = el('stat-size');
  const elElapsed = el('stat-elapsed');
  const elSkipped = el('stat-skipped');

  const elCrumbs = el('crumbs');
  const elHoverbar = el('hoverbar');
  const elHoverPath = el('hover-path');
  const elHoverSize = el('hover-size');
  const elHoverDate = el('hover-date');
  const elHoverReveal = el('hover-reveal');
  const elLegend = el('legend');
  const elLiveStats = el('live-stats');
  const elResultStats = el('result-stats');

  const elResSize = el('res-size');
  const elResFiles = el('res-files');
  const elResFolders = el('res-folders');
  const elResSkipped = el('res-skipped');
  const elResNote = el('res-note');

  const elErrorTitle = el('error-title');
  const elErrorBody = el('error-body');

  // Scanning and results are the same stage now: the canvas hands over from
  // the block field to the treemap without the view changing underneath it.
  const stages = {
    empty: el('stage-empty'),
    scanning: el('stage-scanning'),
    error: el('stage-error'),
  };

  const buttons = {
    cancel: el('cancel'),
    retry: el('retry'),
    choose: el('choose'),
    again: el('again'),
  };

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

  const formatSeconds = (ms) => Math.floor(ms / 1000) + 's';

  function formatDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  const count = (n) => (n || 0).toLocaleString();
  const plural = (n, one, many) => (n === 1 ? one : many);

  // Environment, resolved from main — the sandboxed renderer has no `os`.
  let home = '';
  let isMac = true;

  function shorten(p) {
    if (!p) return '';
    if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
    return p;
  }

  // ---------- Left-truncated live path ----------
  // The tail of a path is the informative half, so the head is what gets
  // dropped. Measured with the layout engine rather than canvas measureText:
  // canvas wants a parsable font shorthand and silently falls back to 10px
  // sans-serif if it can't parse the stack — which would look like a working
  // measurement while sizing against the wrong font.
  let charW = 0;

  function charWidth(target) {
    if (charW) return charW;
    const cs = getComputedStyle(target);
    const ruler = document.createElement('span');
    ruler.textContent = '0'.repeat(100);
    ruler.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;top:0;left:0;pointer-events:none';
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
    elCurrent.textContent = text.length <= max ? text : '…' + text.slice(text.length - (max - 1));
    elCurrent.title = text;
  }

  function setCurrentPath(p) {
    currentFull = shorten(p);
    paintCurrent();
  }

  window.addEventListener('resize', paintCurrent);

  // ---------- Block field ----------
  function setScaleLabel(quantum, bump) {
    elScale.textContent = `1 block = ${count(quantum)} ${plural(quantum, 'file', 'files')}`;
    if (!bump) return;
    // The field halves at a rescale; the flash marks that as a change of scale
    // rather than lost ground.
    elScale.classList.add('field__scale--bump');
    clearTimeout(setScaleLabel.timer);
    setScaleLabel.timer = setTimeout(() => {
      elScale.classList.remove('field__scale--bump');
    }, 700);
  }

  // One canvas, two renderers taking turns on it. Only one is ever active, so
  // they can't fight over the same pixels.
  const canvas = el('blockfield');

  const field = new window.BlockField(canvas, {
    quantum: 25,
    onScaleChange: (q) => setScaleLabel(q, true),
  });

  const treemap = new window.Treemap(canvas, {
    onHover: (data, value) => showHover(data, value),
    onZoom: (data) => zoomInto(data),
  });

  function showField() {
    treemap.deactivate();
    field.activate();
  }

  function showTreemap(tree) {
    field.deactivate();
    treemap.activate();
    treemap.setTree(tree);
  }

  // ---------- Hover readout ----------
  // `hovered` outlives the pointer leaving the canvas on purpose: Reveal sits
  // outside the canvas, so clearing on exit would erase the subject on the way
  // to the verb.
  let hovered = null;

  function showHover(data, value) {
    if (!data) return;
    hovered = data;
    if (data.synthetic) {
      const n = data.count || 0;
      elHoverPath.textContent = `${count(n)} smaller ${plural(n, 'item', 'items')} in ${shorten(data.path)}`;
      elHoverPath.title = data.path;
      elHoverDate.textContent = '';
    } else {
      elHoverPath.textContent = shorten(data.path);
      elHoverPath.title = data.path;
      elHoverDate.textContent = data.pruned
        ? `${count(data.childCount)} ${plural(data.childCount, 'item', 'items')} inside — click to open`
        : formatDate(data.mtime);
    }
    elHoverSize.textContent = formatBytes(value || data.size || 0);
    elHoverReveal.disabled = false;
  }

  function clearHover() {
    hovered = null;
    elHoverPath.textContent = 'Point at the map to inspect an item';
    elHoverPath.title = '';
    elHoverSize.textContent = '';
    elHoverDate.textContent = '';
    elHoverReveal.disabled = true;
  }

  elHoverReveal.addEventListener('click', () => {
    if (!hovered || !hovered.path) return;
    api.reveal(hovered.path).catch(() => {
      elStatus.textContent = 'That item couldn’t be revealed — it may have moved';
    });
  });

  // ---------- Breadcrumbs ----------
  // Zooming is a re-scan of a subdirectory (DECISIONS.md, P3), so nothing in
  // the data records how we arrived. The trail is that record.
  let trail = [];

  function renderCrumbs() {
    elCrumbs.replaceChildren();
    elCrumbs.hidden = trail.length === 0;
    trail.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumbs__sep';
        sep.textContent = '/';
        elCrumbs.appendChild(sep);
      }
      const last = i === trail.length - 1;
      const btn = document.createElement('button');
      btn.className = 'crumb' + (last ? ' crumb--current' : '');
      // textContent, never innerHTML: folder names come off the user's disk.
      btn.textContent = crumb.name;
      btn.title = crumb.path;
      if (last) {
        btn.setAttribute('aria-current', 'true');
      } else {
        btn.addEventListener('click', () => {
          trail = trail.slice(0, i + 1);
          runScan(crumb.path, { keepTrail: true });
        });
      }
      elCrumbs.appendChild(btn);
    });
  }

  function zoomInto(data) {
    trail.push({ name: data.name, path: data.path });
    runScan(data.path, { keepTrail: true });
  }

  // ---------- Elapsed clock ----------
  // Ticks on its own timer, deliberately NOT on scan progress. When a single
  // directory stalls, progress messages stop arriving — and a progress-driven
  // clock would freeze at exactly the moment it most needs to keep moving. A
  // wall clock still counting beside a live path that has stopped is what
  // tells a slow scan from a hung one. See DECISIONS.md, P5.
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

  // ---------- Stage + action visibility ----------
  function setStage(name) {
    Object.keys(stages).forEach((k) => {
      if (stages[k]) stages[k].hidden = k !== name;
    });
  }

  function setActions(visible) {
    Object.keys(buttons).forEach((k) => {
      const btn = buttons[k];
      if (!btn) return;
      btn.hidden = !visible[k];
      btn.disabled = false;
    });
  }

  // ---------- Skipped-folder copy ----------
  // Skipped folders are normal, not a failure: the OS keeps some folders
  // private, and it says so in the same breath as the number.
  function skippedNote(n) {
    if (!n) return '';
    const head = `${count(n)} ${plural(n, 'folder', 'folders')} couldn’t be opened, so nothing inside ${plural(n, 'it', 'them')} is counted above.`;
    const why = isMac
      ? 'That’s expected: macOS keeps some folders private until an app has Full Disk Access. You can grant it in System Settings › Privacy & Security › Full Disk Access.'
      : 'That’s expected: Windows keeps some folders private to the system and to other user accounts.';
    return `${head} ${why}`;
  }

  // ---------- Error copy ----------
  // Every state names what happened and what to do next. No apologies.
  function errorCopy(code, detail) {
    switch (code) {
      case 'EACCES':
      case 'EPERM':
        return {
          status: 'Folder not readable',
          title: 'This folder is closed to DiskWatch.',
          body: isMac
            ? 'macOS keeps some folders private until an app has Full Disk Access. Grant it in System Settings › Privacy & Security › Full Disk Access, then try again — or choose a different folder.'
            : 'Windows is holding this folder back from DiskWatch. Run DiskWatch as an administrator to read it, or choose a different folder.',
        };
      case 'ENOENT':
        return {
          status: 'Folder not found',
          title: 'That folder isn’t there any more.',
          body: 'It was moved or removed between being chosen and being read. Choose it again in its new place, or pick a different folder.',
        };
      case 'ENOTDIR':
        return {
          status: 'Not a folder',
          title: 'That’s a file, not a folder.',
          body: 'DiskWatch scans folders. Choose the folder that contains it and the file will show up in the results.',
        };
      case 'EWORKER':
        return {
          status: 'Scan stopped',
          title: 'The scan stopped before it finished.',
          body: 'The scanner shut down partway through, so these totals are incomplete. Nothing on your disk was changed — DiskWatch only reads. Try that folder again, or scan a folder inside it instead.',
        };
      default:
        return {
          status: 'Scan failed',
          title: 'That folder couldn’t be read.',
          // The system's own words beat a paraphrase — it's the detail that
          // makes the difference between a report and a shrug.
          body: `The system reported: ${detail || code}. Try a different folder.`,
        };
    }
  }

  // ---------- Scan state ----------
  let scanning = false;
  let generation = 0; // guards a superseded scan from settling over a newer one
  let unsubscribe = null;
  let lastTarget = '';
  let last = { files: 0, bytes: 0, skipped: 0 };

  // The progress listener lives exactly as long as the scan does. P2's
  // onProgress returns a real unsubscribe function for this reason; calling it
  // on every ending — done, cancelled or failed — is what keeps repeated scans
  // from stacking up listeners.
  function detachProgress() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function onProgress(p) {
    if (!scanning || !p) return;
    last = { files: p.filesSeen, bytes: p.bytesSeen, skipped: p.dirsSkipped || 0 };
    field.setFiles(p.filesSeen);
    elFiles.textContent = count(p.filesSeen);
    elSize.textContent = formatBytes(p.bytesSeen);
    elSkipped.textContent = count(p.dirsSkipped);
    if (p.path) setCurrentPath(p.path);
  }

  // ---------- Stages ----------
  function showEmpty() {
    detachProgress();
    stopClock();
    scanning = false;
    startedAt = 0;
    lastTarget = '';
    last = { files: 0, bytes: 0, skipped: 0 };
    elStatus.textContent = 'Nothing scanned yet';
    elRoot.textContent = '';
    setCurrentPath('');
    elScanNote.hidden = true;
    trail = [];
    renderCrumbs();
    clearHover();
    treemap.deactivate();
    field.deactivate();
    elFiles.textContent = '0';
    elSize.textContent = '0 B';
    elElapsed.textContent = '0s';
    elSkipped.textContent = '0';
    setScaleLabel(field.baseQuantum, false);
    setStage('empty');
    setActions({ choose: true });
  }

  function showError(code, detail) {
    // Nothing on the canvas survives into an error view.
    treemap.deactivate();
    field.deactivate();
    elHoverbar.hidden = true;
    elLegend.hidden = true;
    clearHover();

    const copy = errorCopy(code, detail);
    elStatus.textContent = copy.status;
    elErrorTitle.textContent = copy.title;
    elErrorBody.textContent = copy.body;
    setStage('error');
    // Retry is only offered where trying again could plausibly differ: after a
    // crash, or once permission has been granted.
    const retryable = code === 'EWORKER' || code === 'EACCES' || code === 'EPERM';
    setActions({ retry: retryable && !!lastTarget, choose: true });
  }

  // Cancelling is a neutral outcome, not an error: the field and the counts
  // stay exactly where they stopped, because those numbers are real.
  function showCancelled() {
    elStatus.textContent = 'Scan stopped';
    elReading.hidden = true;
    // A cancelled scan returns tree: null — there is nothing to map, so the
    // block field stays exactly where it stopped.
    elScanNote.textContent =
      'You stopped this scan. The counts above are what it had reached — they’re real, but partial.';
    elScanNote.hidden = false;
    setStage('scanning');
    setActions({ again: true });
  }

  function showResults(r) {
    const folders = Math.max(0, (r.dirsSeen || 0) - 1); // the scanned root isn't inside itself
    elStatus.textContent = 'Done';
    elResSize.textContent = formatBytes(r.bytesSeen);
    elResFiles.textContent = count(r.filesSeen);
    elResFolders.textContent = count(folders);
    elResSkipped.textContent = count(r.dirsSkipped);

    const note = skippedNote(r.dirsSkipped);
    elResNote.textContent = note;
    elResNote.hidden = !note;

    elReading.hidden = true;
    elScanNote.hidden = true;
    elLiveStats.hidden = true;
    elResultStats.hidden = false;
    elScale.hidden = true;
    elHoverbar.hidden = false;
    elLegend.hidden = false;
    clearHover();

    setStage('scanning');
    // The canvas stops being a counter and becomes the map.
    showTreemap(r.tree);
    setActions({ again: true });
  }

  // ---------- Running a scan ----------
  async function runScan(target, options) {
    const gen = ++generation;
    const opts = options || {};

    detachProgress(); // a previous listener must never outlive its scan
    lastTarget = target;

    if (!opts.keepTrail) trail = [{ name: baseName(target), path: target }];
    renderCrumbs();
    last = { files: 0, bytes: 0, skipped: 0 };

    // Back to counting: the block field takes the canvas again.
    elLiveStats.hidden = false;
    elResultStats.hidden = true;
    elResNote.hidden = true;
    elHoverbar.hidden = true;
    elLegend.hidden = true;
    elScale.hidden = false;
    elScanNote.hidden = true;
    elReading.hidden = false;
    elStatus.textContent = 'Scanning';
    elRoot.textContent = shorten(target);
    clearHover();

    // The stage has to be on screen before a renderer measures the canvas —
    // a hidden canvas reports zero size, and the renderer would lay out
    // against nothing.
    setStage('scanning');
    showField();

    field.reset();
    setScaleLabel(field.quantum, false);
    elFiles.textContent = '0';
    elSize.textContent = '0 B';
    elSkipped.textContent = '0';
    setActions({ cancel: true, choose: true });
    scanning = true;
    setCurrentPath(target);
    startClock();

    unsubscribe = api.scan.onProgress(onProgress);

    let result = null;
    try {
      result = await api.scan.start(target);
    } catch (err) {
      result = { ok: false, code: 'ESCANFAILED', detail: err && err.message ? err.message : '' };
    } finally {
      // Every exit from a scan detaches, including the ones nobody plans for.
      if (gen === generation) {
        detachProgress();
        scanning = false;
        stopClock();
      }
    }

    // A newer scan already owns the readout — let it be.
    if (gen !== generation) return;

    field.setCounting(false);

    if (!result.ok) {
      showError(result.code, result.detail);
      return;
    }

    // Counts only ever move forward. The done payload is authoritative on a
    // completed scan; on a cancel that had to be forced it comes back zeroed,
    // and the last real progress numbers are the honest ones.
    const files = Math.max(last.files, result.filesSeen || 0);
    const bytes = Math.max(last.bytes, result.bytesSeen || 0);
    const skipped = Math.max(last.skipped, result.dirsSkipped || 0);
    field.setFiles(files);
    elFiles.textContent = count(files);
    elSize.textContent = formatBytes(bytes);
    elSkipped.textContent = count(skipped);
    setCurrentPath('');

    if (result.cancelled) {
      showCancelled();
    } else {
      showResults(result);
    }
  }

  // ---------- Actions ----------
  async function chooseAndScan() {
    const target = await api.chooseFolder();
    if (!target) {
      // Not an error — the picker was dismissed. Say so and stay put.
      elStatus.textContent = 'No folder selected — choose one to start a scan';
      return;
    }
    runScan(target);
  }

  function baseName(p) {
    const parts = String(p).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  buttons.choose.addEventListener('click', chooseAndScan);

  buttons.again.addEventListener('click', showEmpty);

  buttons.retry.addEventListener('click', () => {
    if (lastTarget) runScan(lastTarget);
  });

  buttons.cancel.addEventListener('click', async () => {
    if (!scanning) return;
    buttons.cancel.disabled = true;
    elStatus.textContent = 'Stopping';
    await api.scan.cancel();
    // runScan settles on its own once the worker unwinds.
  });

  // ---------- Start ----------
  if (!api) {
    setStage('empty');
    setActions({});
    elStatus.textContent = 'Unavailable';
    return;
  }

  api.platform().then((info) => {
    home = info && info.home ? info.home : '';
    isMac = !info || info.platform === 'darwin';
  });

  showEmpty();
})();
