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

  const elResSize = el('res-size');
  const elResFiles = el('res-files');
  const elResFolders = el('res-folders');
  const elResSkipped = el('res-skipped');
  const elResNote = el('res-note');
  const elResItems = el('res-items');

  const elErrorTitle = el('error-title');
  const elErrorBody = el('error-body');

  const stages = {
    empty: el('stage-empty'),
    scanning: el('stage-scanning'),
    results: el('stage-results'),
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

  const field = new window.BlockField(el('blockfield'), {
    quantum: 25,
    onScaleChange: (q) => setScaleLabel(q, true),
  });

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
    elFiles.textContent = '0';
    elSize.textContent = '0 B';
    elElapsed.textContent = '0s';
    elSkipped.textContent = '0';
    setScaleLabel(field.baseQuantum, false);
    setStage('empty');
    setActions({ choose: true });
  }

  function showError(code, detail) {
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
    elScanNote.textContent =
      'You stopped this scan. The counts above are what it had reached — they’re real, but partial.';
    elScanNote.hidden = false;
    setStage('scanning');
    setActions({ again: true });
  }

  function showResults(r) {
    const folders = Math.max(0, (r.dirsSeen || 0) - 1); // the scanned root isn't "inside" itself
    elStatus.textContent = 'Done';
    elResSize.textContent = formatBytes(r.bytesSeen);
    elResFiles.textContent = count(r.filesSeen);
    elResFolders.textContent = count(folders);
    elResSkipped.textContent = count(r.dirsSkipped);

    const note = skippedNote(r.dirsSkipped);
    elResNote.textContent = note;
    elResNote.hidden = !note;

    renderItems(r.tree);
    setStage('results');
    setActions({ again: true });
  }

  // Largest items = the biggest immediate children of the scanned folder. Not
  // the biggest nodes anywhere in the tree: those would double-count, listing a
  // folder and the file inside it as two separate findings.
  function renderItems(tree) {
    elResItems.replaceChildren();
    const kids = tree && tree.children ? tree.children : [];
    const top = kids
      .filter((c) => !c.synthetic) // "(smaller items)" is a rollup, not an item
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);

    if (top.length === 0) {
      const li = document.createElement('li');
      li.className = 'items__none';
      li.textContent = 'This folder is empty.';
      elResItems.appendChild(li);
      return;
    }

    top.forEach((node) => {
      const li = document.createElement('li');
      li.className = 'item';

      const name = document.createElement('span');
      name.className = 'item__name';
      // textContent, never innerHTML: these are filenames off the user's disk
      // and are treated as hostile input, exactly as the IPC boundary is.
      name.textContent = node.name;
      name.title = node.name;

      const size = document.createElement('span');
      size.className = 'item__size mono';
      size.textContent = formatBytes(node.size);

      const reveal = document.createElement('button');
      reveal.className = 'btn btn--ghost item__reveal';
      reveal.textContent = 'Reveal';
      reveal.setAttribute('aria-label', `Reveal ${node.name}`);
      reveal.addEventListener('click', () => {
        api.reveal(node.path).catch(() => {
          elStatus.textContent = 'That item couldn’t be revealed — it may have moved';
        });
      });

      li.append(name, size, reveal);
      elResItems.appendChild(li);
    });
  }

  // ---------- Running a scan ----------
  async function runScan(target) {
    const gen = ++generation;

    detachProgress(); // a previous listener must never outlive its scan
    lastTarget = target;
    last = { files: 0, bytes: 0, skipped: 0 };

    field.reset();
    setScaleLabel(field.quantum, false);
    elFiles.textContent = '0';
    elSize.textContent = '0 B';
    elSkipped.textContent = '0';
    elScanNote.hidden = true;
    elReading.hidden = false;
    elStatus.textContent = 'Scanning';
    elRoot.textContent = shorten(target);
    setStage('scanning');
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

    field.setActive(false);

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
