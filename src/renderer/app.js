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
    check: document.getElementById('view-check'),
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
  const elAgeRamp = el('age-ramp');
  const elAgeNewest = el('age-newest');
  const elAgeMiddle = el('age-middle');
  const elAgeOldest = el('age-oldest');
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
  const charWidths = new WeakMap();

  function charWidth(target) {
    if (charWidths.has(target)) return charWidths.get(target);
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
    const cw = w > 0 ? w : 7;
    charWidths.set(target, cw);
    return cw;
  }

  // Full text per element, so a resize can re-truncate from the original
  // rather than from an already-shortened string.
  const fullText = new WeakMap();

  function paintTruncated(target) {
    const text = fullText.get(target) || '';
    target.title = text;
    const width = target.clientWidth;
    if (!width) {
      target.textContent = text;
      return;
    }
    let max = Math.max(8, Math.floor(width / charWidth(target)));
    if (text.length <= max) {
      target.textContent = text;
      return;
    }
    target.textContent = '…' + text.slice(text.length - (max - 1));
    // Measured backstop. The character-width estimate runs a character or two
    // optimistic (fractional advances, fallback faces), and when it does, CSS
    // clips the RIGHT edge — throwing away the filename, which is the half the
    // left-truncation existed to keep. Shrink until it genuinely fits.
    let guard = 0;
    while (target.scrollWidth > target.clientWidth && max > 9 && guard++ < 60) {
      max -= 1;
      target.textContent = '…' + text.slice(text.length - (max - 1));
    }
  }

  function setTruncated(target, text) {
    fullText.set(target, text || '');
    paintTruncated(target);
  }

  const setCurrentPath = (p) => setTruncated(elCurrent, shorten(p));

  window.addEventListener('resize', () => {
    paintTruncated(elCurrent);
    paintTruncated(elHoverPath);
  });

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
    onSelect: (data, value) => showSelected(data, value),
    onActivate: (data) => revealPath(data && data.path),
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

  // The key is painted from the same ramp function as the rectangles, so the
  // two can never disagree about what a colour means.
  function showAgeScale() {
    const age = treemap.age;
    // No range to draw: a gradient here would imply a spread of dates that
    // this folder does not have.
    if (!age || age.span <= 0) {
      elLegend.hidden = true;
      return;
    }
    elAgeRamp.style.background = treemap.rampCss(14);
    elAgeNewest.textContent = formatDate(age.newest);
    elAgeMiddle.textContent = formatDate(age.middle);
    elAgeOldest.textContent = formatDate(age.oldest);
    elLegend.hidden = false;
  }

  // ---------- Hover readout ----------
  // `hovered` outlives the pointer leaving the canvas on purpose: Reveal sits
  // outside the canvas, so clearing on exit would erase the subject on the way
  // to the verb.
  let hovered = null;

  // Two states, and the readout can only show one at a time. Selection wins:
  // clicking a file is a deliberate act that says "this is the one I mean",
  // and a readout that reverted to whatever the cursor drifted over would
  // undo it. Hover keeps its highlight on the canvas either way.
  let selected = null;

  function showSelected(data, value) {
    selected = data || null;
    if (data) {
      paintReadout(data, value);
    } else if (hovered) {
      paintReadout(hovered, hovered.size || 0);
    } else {
      clearHover();
    }
    // Reveal acts on the SELECTION, so it is available exactly when there is
    // one. Hovering no longer arms it.
    elHoverReveal.disabled = !(selected && selected.path);
  }

  function showHover(data, value) {
    if (!data) return;
    hovered = data;
    // A selection is showing, so hovering must not overwrite the readout.
    if (selected) return;
    paintReadout(data, value);
  }

  function paintReadout(data, value) {

    // Fill the fixed-width siblings FIRST. The path is a flex:1 item, so its
    // width is whatever they leave over — measuring it before they have their
    // content sizes it against a box wider than the one it ends up in, and the
    // tail gets clipped by exactly the amount they were about to take.
    elHoverSize.textContent = formatBytes(value || data.size || 0);
    if (data.synthetic) {
      elHoverDate.textContent = '';
    } else {
      elHoverDate.textContent = data.pruned
        ? `${count(data.childCount)} ${plural(data.childCount, 'item', 'items')} inside — click to open`
        : formatDate(data.mtime);
    }
    elHoverReveal.disabled = !(selected && selected.path);

    // Row is settled: now the path can be measured against its real width.
    if (data.synthetic) {
      const n = data.count || 0;
      setTruncated(
        elHoverPath,
        `${count(n)} smaller ${plural(n, 'item', 'items')} in ${shorten(data.path)}`,
      );
    } else {
      setTruncated(elHoverPath, shorten(data.path));
    }
  }

  function clearHover() {
    hovered = null;
    if (selected) return; // the readout belongs to the selection
    setTruncated(elHoverPath, 'Click an item to inspect it');
    elHoverPath.title = '';
    elHoverSize.textContent = '';
    elHoverDate.textContent = '';
    elHoverReveal.disabled = true;
  }

  function revealPath(target) {
    if (!target) return;
    api.reveal(target).catch(() => {
      elStatus.textContent = 'That item couldn’t be revealed — it may have moved';
    });
  }

  elHoverReveal.addEventListener('click', () => {
    revealPath(selected && selected.path);
  });

  // Escape clears the selection wherever focus happens to be. The treemap
  // handles it too, for when the canvas itself has focus; this covers the
  // case where the person tabbed to the Reveal button and changed their mind.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !selected) return;
    if (currentTab() !== 'scan') return;
    e.preventDefault();
    treemap.clearSelection();
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
    clearHover();

    setStage('scanning');
    // The canvas stops being a counter and becomes the map.
    showTreemap(r.tree);
    showAgeScale();
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

  // ---------- Clean ----------
  //
  // The renderer holds no paths. A row knows its target id, its figures and an
  // opaque list of tokens; removal sends tokens and nothing else. There is no
  // code path here that can name a place on disk, which is why there is no
  // validation here that would have to try.
  //
  // Rows arrive one target at a time. A full survey walks every cache
  // directory the allowlist points at and takes about 17 seconds, so waiting
  // for the whole thing before drawing anything would show an empty pane for
  // that entire time.
  const clean = (function () {
    const stages = {
      empty: el('clean-stage-empty'),
      list: el('clean-stage-list'),
      confirm: el('clean-stage-confirm'),
      result: el('clean-stage-result'),
      error: el('clean-stage-error'),
    };

    const buttons = {
      back: el('clean-back'),
      survey: el('clean-survey'),
      review: el('clean-review'),
      confirm: el('clean-confirm'),
      again: el('clean-again'),
    };

    const elStatus = el('clean-status');
    const elReassure = el('clean-reassure');
    const elList = el('clean-targets');
    const elNote = el('clean-note');
    const elSelected = el('clean-selected');
    const elSelCount = el('sel-count');
    const elSelSize = el('sel-size');

    // id -> { report, checkbox, sizeEl, countEl, row }. The single record of
    // what is on screen; nothing reads the DOM back to decide anything.
    const rows = new Map();
    let unsubscribe = null;
    let surveying = false;

    const items = (n) => `${count(n)} ${n === 1 ? 'item' : 'items'}`;

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

    // Where things went and how to get them back, in the words of whichever OS
    // this is. Restoring is one sentence, not a link to a help page.
    // Written for someone who has never deleted anything from a computer on
    // purpose. It names the destination and the way back, in that order.
    function setReassurance() {
      elReassure.textContent = isMac
        ? 'Nothing here is deleted. Anything you pick is moved to the Trash, and you can ' +
          'drag it back out whenever you want.'
        : 'Nothing here is deleted. Anything you pick is moved to the Recycle Bin, and you ' +
          'can put it back whenever you want.';
    }

    function trashLine(n) {
      const what = n === 1 ? 'It is' : 'They are';
      return isMac
        ? `${what} in the Trash. Open the Trash, right-click, and choose Put Back to restore ` +
          `${n === 1 ? 'it' : 'them'} to where ${n === 1 ? 'it was' : 'they were'}.`
        : `${what} in the Recycle Bin. Open it, right-click, and choose Restore to put ` +
          `${n === 1 ? 'it' : 'them'} back.`;
    }

    // ---------- Selection ----------

    function selection() {
      const chosen = [];
      rows.forEach((row) => {
        if (row.checkbox && row.checkbox.checked) chosen.push(row);
      });
      return chosen;
    }

    function refreshTotals() {
      const chosen = selection();
      const bytes = chosen.reduce((a, r) => a + r.report.bytes, 0);
      const n = chosen.reduce((a, r) => a + r.report.count, 0);

      elSelected.hidden = chosen.length === 0;
      elSelCount.textContent = items(n);
      elSelSize.textContent = formatBytes(bytes);

      if (buttons.review) {
        buttons.review.disabled = chosen.length === 0 || surveying;
        buttons.review.textContent =
          chosen.length === 0 ? 'Review selection' : `Review ${items(n)}`;
      }
    }

    // ---------- Rows ----------

    // A target whose items are the person's OWN files gets a gate: the checkbox
    // is disabled until they have opened the list and looked at it.
    //
    // Everything else in the allowlist is a cache — the app that made it makes
    // it again, so the cost of being wrong is a slower launch. Downloads are
    // not that. They are files the person went and got, nothing regenerates
    // them, and there are over a thousand of them behind one checkbox. Making
    // the list a thing you have to open is the smallest change that stops a
    // single click from meaning more than it looks like it means.
    //
    // The rule keys off the unit, not the id: a per-file target IS one whose
    // items are individual files rather than a rebuildable directory, so a new
    // target of that shape inherits the gate without anyone remembering to.
    const isGated = (report) => report.unit === 'file';

    function span(className, text) {
      const s = document.createElement('span');
      s.className = className;
      s.textContent = text;
      return s;
    }

    function makeRow(entry, kind) {
      const gated = kind === 'ready' && entry.gated === true;

      const row = document.createElement('div');
      row.className = `target target--${kind}`;

      const top = document.createElement('div');
      top.className = 'target__top';

      const main = document.createElement('label');
      main.className = 'target__main';

      let checkbox = null;
      if (kind === 'ready') {
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'target__check';
        // NEVER checked here, and there is no branch below that sets it.
        // Nothing is pre-selected: the loader rejects a defaultEnabled entry
        // outright, and the UI must not reintroduce one by the back door.
        checkbox.checked = false;
        // A gated row starts unusable and is opened by looking, not by asking.
        checkbox.disabled = gated;
        checkbox.addEventListener('change', refreshTotals);
        main.appendChild(checkbox);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'target__check';
        spacer.setAttribute('aria-hidden', 'true');
        main.appendChild(spacer);
      }

      const text = document.createElement('span');
      text.className = 'target__text';
      text.appendChild(span('target__label', entry.label));

      if (entry.description) text.appendChild(span('target__desc', entry.description));

      // Why this row cannot be chosen, in place, rather than an absence to
      // puzzle over.
      if (kind !== 'ready') text.appendChild(span('target__state', entry.stateText || ''));

      if (entry.requiresAppClosed && entry.requiresAppClosed.length > 0) {
        text.appendChild(
          span('target__needs', `Close ${entry.requiresAppClosed.join(' and ')} first.`),
        );
      }

      let gate = null;
      if (gated) {
        gate = span('target__gate', 'Look through the list before choosing this.');
        text.appendChild(gate);
      }

      main.appendChild(text);
      top.appendChild(main);

      const figures = document.createElement('span');
      figures.className = 'target__figures';
      const size = span('target__size mono', entry.sizeText || '');
      figures.appendChild(size);
      const countEl = span('target__count microlabel', entry.countText || '');
      figures.appendChild(countEl);
      if (entry.risk === 'caution') figures.appendChild(span('target__risk', 'Caution'));

      top.appendChild(figures);
      row.appendChild(top);

      // The disclosure lives outside the <label>: a button inside one would
      // toggle the checkbox on every click, which is precisely the accident
      // this gate exists to prevent.
      if (gated) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn btn--ghost target__disclose';
        toggle.textContent = 'Show what’s included';
        toggle.setAttribute('aria-expanded', 'false');

        const panel = document.createElement('div');
        panel.className = 'target__contents';
        panel.hidden = true;

        let loaded = false;
        toggle.addEventListener('click', async () => {
          if (!loaded) {
            toggle.disabled = true;
            toggle.textContent = 'Reading…';
            const data = await api.cleaner.contents(entry.id);
            toggle.disabled = false;
            loaded = true;
            renderContents(panel, data);
            // Looking is what unlocks it. Nothing else does.
            if (checkbox) checkbox.disabled = false;
            if (gate) gate.remove();
          }
          const open = panel.hidden;
          panel.hidden = !open;
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          toggle.textContent = open ? 'Hide the list' : 'Show what’s included';
        });

        row.appendChild(toggle);
        row.appendChild(panel);
      }

      return { row, checkbox, size, countEl };
    }

    function renderContents(panel, data) {
      panel.textContent = '';

      if (!data || !data.ok || data.items.length === 0) {
        panel.appendChild(span('target__state', 'That list could not be read.'));
        return;
      }

      const list = document.createElement('ul');
      list.className = 'filelist';

      // Names and dates only — the survey never sent a path and this does not
      // either. A filename is what you recognise your own file by.
      for (const item of data.items) {
        const li = document.createElement('li');
        li.className = 'filelist__row';
        li.appendChild(span('filelist__name', item.name));
        li.appendChild(span('filelist__date', formatDate(item.mtimeMs)));
        li.appendChild(span('filelist__size mono', formatBytes(item.bytes)));
        list.appendChild(li);
      }
      panel.appendChild(list);

      // Say what is not shown rather than quietly showing less.
      if (data.shown < data.total) {
        panel.appendChild(
          span(
            'target__state',
            `Showing the ${count(data.shown)} most recent of ${count(data.total)}. ` +
              'Choosing this row still covers all of them.',
          ),
        );
      }
    }

    function renderPending(pending) {
      elList.textContent = '';
      rows.clear();
      for (const t of pending) {
        const built = makeRow(
          { ...t, sizeText: '—', countText: 'measuring', stateText: '' },
          'pending',
        );
        elList.appendChild(built.row);
        rows.set(t.id, { report: { bytes: 0, count: 0, tokens: [] }, ...built, entry: t });
      }
    }

    // Replaces a measuring row in place with what was actually found. Three
    // outcomes, told apart deliberately: not on this machine, here but with
    // nothing to remove, and here with something to offer.
    function settleRow(report) {
      const existing = rows.get(report.id);
      if (!existing) return;

      let kind = 'ready';
      let stateText = '';
      let sizeText = formatBytes(report.bytes);
      let countText = items(report.count);

      if (!report.present) {
        kind = 'absent';
        stateText = 'Not present on this machine.';
        sizeText = '—';
        countText = '';
      } else if (report.count === 0) {
        kind = 'absent';
        stateText =
          report.refusedCount > 0
            ? 'Nothing to remove — everything here is on the protected list.'
            : 'Nothing to remove — it is already empty.';
        sizeText = '—';
        countText = '';
      }

      const built = makeRow(
        { ...existing.entry, ...report, sizeText, countText, stateText, gated: isGated(report) },
        kind,
      );
      elList.replaceChild(built.row, existing.row);
      rows.set(report.id, { report, ...built, entry: existing.entry });
      refreshTotals();
    }


    function renderUnavailable(list) {
      for (const u of list) {
        const built = makeRow(
          {
            ...u,
            sizeText: '—',
            countText: '',
            // The reason is the loader's own, shown rather than summarised:
            // an entry withheld by its expand contract is a deliberate
            // decision and the person is owed the actual grounds.
            stateText: `Not available: ${u.reason}`,
          },
          'unavailable',
        );
        elList.appendChild(built.row);
      }
    }

    // ---------- Survey ----------

    async function runSurvey() {
      surveying = true;
      setStage('list');
      setActions({ review: true });
      refreshTotals();
      elNote.hidden = true;
      elStatus.textContent = 'Looking…';
      elList.textContent = '';
      rows.clear();

      if (unsubscribe) unsubscribe();
      unsubscribe = api.cleaner.onProgress((p) => {
        if (!p) return;
        if (p.phase === 'start') {
          renderPending(p.pending);
          renderUnavailable(p.unavailable);
          elStatus.textContent = `Measuring ${p.total} places…`;
        } else if (p.phase === 'target') {
          settleRow(p.target);
          elStatus.textContent = `Measuring ${p.done} of ${p.total}…`;
        }
      });

      const result = await api.cleaner.survey();

      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      surveying = false;

      if (!result || !result.ok) {
        showError(result);
        return;
      }

      elStatus.textContent =
        result.totals.count === 0
          ? 'Nothing to remove'
          : `${items(result.totals.count)} in ${result.totals.present} ` +
            `place${result.totals.present === 1 ? '' : 's'}, ${formatBytes(result.totals.bytes)}`;

      if (result.totals.absent > 0) {
        elNote.hidden = false;
        elNote.textContent =
          `${result.totals.absent} of the ${result.targets.length} places DiskWatch knows about ` +
          'are not on this machine or have nothing in them. They stay listed so the list reads ' +
          'the same everywhere.';
      }

      setActions({ review: true, again: true });
      refreshTotals();
    }

    // ---------- Confirm ----------

    function showConfirm() {
      const chosen = selection();
      if (chosen.length === 0) return;

      const list = el('confirm-list');
      list.textContent = '';

      for (const row of chosen) {
        const li = document.createElement('li');
        li.className = 'confirm__row';

        const name = document.createElement('span');
        name.textContent = row.entry.label;
        li.appendChild(name);

        const figures = document.createElement('span');
        figures.className = 'confirm__figures';

        const size = document.createElement('span');
        size.className = 'confirm__size';
        size.textContent = formatBytes(row.report.bytes);
        figures.appendChild(size);

        const n = document.createElement('span');
        n.className = 'confirm__count';
        n.textContent = items(row.report.count);
        figures.appendChild(n);

        li.appendChild(figures);
        list.appendChild(li);
      }

      const bytes = chosen.reduce((a, r) => a + r.report.bytes, 0);
      const n = chosen.reduce((a, r) => a + r.report.count, 0);
      el('confirm-total').textContent =
        `${items(n)} from ${chosen.length} place${chosen.length === 1 ? '' : 's'}, ` +
        `freeing about ${formatBytes(bytes)}.`;

      setStage('confirm');
      setActions({ back: true, confirm: true });
    }

    // ---------- Remove ----------

    async function runRemove() {
      const chosen = selection();
      if (chosen.length === 0) return;

      // Tokens only. Nothing else crosses, and there is nothing else to send.
      const tokens = chosen.reduce((a, r) => a.concat(r.report.tokens), []);

      buttons.confirm.disabled = true;
      buttons.back.disabled = true;
      elStatus.textContent = 'Moving to the Trash…';

      const result = await api.cleaner.remove(tokens);
      showResult(result);
    }

    function showResult(result) {
      setStage('result');
      setActions({ again: true });
      elSelected.hidden = true;

      if (!result || !result.ok) {
        el('result-title').textContent = 'That could not be completed.';
        el('result-where').textContent =
          result && result.detail ? result.detail : 'The removal did not run.';
        el('result-skipped-wrap').hidden = true;
        elStatus.textContent = 'Not completed';
        return;
      }

      const moved = result.totals.trashedCount;
      const freed = formatBytes(result.totals.trashedBytes);

      // The button said "Move to Trash"; this says "Moved". Same word back, so
      // there is no doubt that the thing named is the thing that happened.
      el('result-title').textContent =
        moved === 0 ? 'Nothing was moved.' : `Moved ${items(moved)} to the Trash — ${freed}.`;
      el('result-where').textContent = moved === 0 ? '' : trashLine(moved);
      elStatus.textContent = moved === 0 ? 'Nothing moved' : `${items(moved)} moved, ${freed}`;

      const skipped = result.skipped || [];
      el('result-skipped-wrap').hidden = skipped.length === 0;

      if (skipped.length > 0) {
        // Deliberately not phrased as failure. An item held open by a running
        // program is the ordinary case, and it is still there afterwards.
        el('result-skipped-lead').textContent =
          `${count(skipped.length)} ${skipped.length === 1 ? 'item was' : 'items were'} left ` +
          'alone. Each is still where it was — nothing was half-removed.';

        const list = el('result-skipped');
        list.textContent = '';
        for (const s of skipped) {
          const li = document.createElement('li');
          li.className = 'skiplist__row';

          const reason = document.createElement('span');
          reason.className = 'skiplist__reason';
          reason.textContent = reasonText(s);
          li.appendChild(reason);

          // The path is displayed only, straight from the result, never held
          // and never sent back.
          if (s.path) {
            const pathEl = document.createElement('span');
            pathEl.className = 'skiplist__path mono';
            pathEl.textContent = s.path;
            li.appendChild(pathEl);
          }

          list.appendChild(li);
        }
      }
    }

    // One sentence per refusal reason, in the person's terms. The closed set in
    // remove.js is what makes this a lookup rather than prose-parsing.
    const REASON_TEXT = {
      'unknown-token': 'This was no longer part of the current list.',
      'token-already-used': 'This had already been removed.',
      'target-not-in-allowlist': 'This place is no longer on the cleanup list.',
      'not-in-live-survey': 'This changed since it was measured, so it was left alone.',
      'identity-changed': 'This changed on disk since it was measured, so it was left alone.',
      'is-symlink': 'This turned out to be a shortcut to somewhere else, so it was left alone.',
      'escapes-target-root': 'This pointed outside the folder it belongs to, so it was left alone.',
      'under-exclusion': 'This is on the protected list and is never removed.',
      'contains-exclusion': 'This holds something on the protected list, so it was left alone.',
      'app-running': 'The app that owns this is still open.',
      'app-check-failed': 'Whether the app that owns this is open could not be determined.',
      'trash-failed': 'This could not be moved to the Trash.',
      vanished: 'This was already gone.',
    };

    function reasonText(skip) {
      const base = REASON_TEXT[skip.reason] || 'This was left alone.';
      return skip.reason === 'app-running' && skip.detail ? `${base} ${skip.detail}.` : base;
    }

    function showError(result) {
      setStage('error');
      setActions({ again: true });
      elSelected.hidden = true;
      elStatus.textContent = 'Could not be read';
      el('clean-error-title').textContent = 'The cleanup list could not be read.';
      el('clean-error-body').textContent =
        (result && result.detail ? result.detail : 'The list of places to clean did not load.') +
        ' Nothing was touched.';
    }

    function showEmpty() {
      setReassurance();
      setStage('empty');
      setActions({ survey: true });
      elSelected.hidden = true;
      elStatus.textContent = 'Nothing surveyed yet';
    }

    // ---------- Wiring ----------

    if (buttons.survey) buttons.survey.addEventListener('click', runSurvey);
    if (buttons.again) buttons.again.addEventListener('click', runSurvey);
    if (buttons.review) buttons.review.addEventListener('click', showConfirm);
    if (buttons.confirm) buttons.confirm.addEventListener('click', runRemove);
    if (buttons.back) {
      buttons.back.addEventListener('click', () => {
        setStage('list');
        setActions({ review: true, again: true });
        refreshTotals();
      });
    }

    return { showEmpty, setReassurance };
  })();

  // ---------- Check ----------
  //
  // THE WORDING RULE, which outranks every other consideration in this view:
  // nothing here ever says a site is safe. Not "safe", not "clean", not "no
  // threats found". The result for a domain nothing was found about is a
  // statement about what was SEARCHED — "Not found in 3 blocklists, checked 2
  // hours ago" — because that is the only thing that was actually established.
  //
  // The asymmetry is the entire reason: a false "this might be a scam"
  // inconveniences someone for a minute. A false "this is safe" is how a
  // person hands over their savings. So the app is allowed to be wrong in the
  // first direction and structurally cannot be wrong in the second, because it
  // never makes the claim that could be wrong that way.
  //
  // Each check gets its own line saying what it found and when. They are never
  // summed, scored, or reduced to a verdict. The person reads the signals.
  const check = (function () {
    const elStatus = el('check-status');
    const elCache = el('check-cache');
    const elInput = el('check-input');
    const elResults = el('check-results');
    const btnRun = el('check-run');
    const btnRefresh = el('check-refresh');

    let cache = null;

    const node = (tag, className, text) => {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    };

    // "2 hours ago", "6 days ago". Vague on purpose past a point: the person
    // needs to know whether this is fresh or elderly, not the minute.
    function ago(hours) {
      if (hours === null || hours === undefined) return 'never';
      if (hours < 1) return 'less than an hour ago';
      if (hours < 24) return `${hours} ${plural(hours, 'hour', 'hours')} ago`;
      const days = Math.floor(hours / 24);
      return `${days} ${plural(days, 'day', 'days')} ago`;
    }

    function paintCache() {
      if (!cache || !cache.ready) {
        elStatus.textContent = 'No lists downloaded yet';
        elCache.textContent =
          'The blocklists have not been downloaded, so nothing can be checked against them yet. ' +
          'Choose Update lists to fetch them — about 18 MB, once a day.';
        return;
      }
      const n = cache.listCount;
      elStatus.textContent = `${n} ${plural(n, 'list', 'lists')} downloaded`;
      // The claim is only as current as its stalest list, so that is the number
      // shown. Reporting the newest would flatter it.
      elCache.textContent =
        `Checking against ${n} ${plural(n, 'blocklist', 'blocklists')}, last updated ` +
        `${ago(cache.oldestAgeHours)}. An older list knows about fewer sites.`;
    }

    // ---------- One line per check ----------

    function line(state, what, detail) {
      const li = node('li', `line line--${state}`);
      li.appendChild(node('span', 'line__mark', state === 'found' ? '!' : state === 'unknown' ? '?' : '·'));
      const body = node('span');
      body.appendChild(node('span', 'line__what', what));
      if (detail) body.appendChild(node('span', 'line__detail', detail));
      li.appendChild(body);
      return li;
    }

    function blocklistLine(r) {
      const listCount = cache && cache.listCount ? cache.listCount : r.blocklist.checkedSources;

      if (!r.blocklist.listed) {
        // THE SENTENCE THIS WHOLE VIEW EXISTS TO GET RIGHT. It describes the
        // search, not the site.
        return line(
          'none',
          `Not found in ${listCount} ${plural(listCount, 'blocklist', 'blocklists')}, ` +
            `checked ${ago(cache && cache.oldestAgeHours)}`,
          'That means it is not on the lists we have. It is not a statement about the site.',
        );
      }

      const names = r.blocklist.sources.map((s) => s.id).join(', ');
      const n = r.blocklist.sources.length;
      let detail = r.blocklist.matchedAs !== r.domain
        ? `Listed as ${r.blocklist.matchedAs}, which covers this address.`
        : '';

      // Independent filters, so the chance every one of them is wrong at once
      // is the product of their rates. Two lists agreeing is not twice as good
      // as one — it is thousands of times less likely to be a mistake.
      if (n > 1) {
        detail += `${detail ? ' ' : ''}${n} lists agree, which is far less likely to be a mistake than one.`;
      } else if (r.blocklist.falsePositiveRate > 0) {
        const oneIn = Math.round(1 / r.blocklist.falsePositiveRate);
        detail += `${detail ? ' ' : ''}One list. About 1 in ${count(oneIn)} entries is a mistaken match.`;
      }

      return line('found', `Listed by ${names}`, detail.trim());
    }

    function ageLine(signal) {
      if (!signal.known) {
        // Unknown is never rendered as reassurance.
        return line('unknown', 'Age could not be determined', 'The registry did not answer, so this tells us nothing either way.');
      }
      const d = signal.detail;
      const date = formatDate(Date.parse(d.registeredAt));
      const days = count(d.ageDays);
      if (signal.present) {
        return line('found', `Registered ${date} — ${days} days old`, 'Sites used for scams are usually registered shortly before they are used.');
      }
      return line('none', `Registered ${date} — ${days} days old`, null);
    }

    function scriptLine(signal) {
      const d = signal.detail;
      if (!signal.present) {
        return line('none', d.isIdn ? 'Written in one alphabet' : 'Ordinary Latin characters', null);
      }
      const li = line(
        'found',
        `Mixes ${d.scripts.join(' and ')} characters in one name`,
        d.confusables.length
          ? `${d.confusables.map((c) => `${c.char} (${c.codePoint}) looks like ${c.looksLike}`).join(', ')}.`
          : null,
      );
      // Both forms, side by side. This IS the attack: one of these is what the
      // person read, the other is where the link actually goes.
      const forms = node('div', 'forms');
      forms.appendChild(node('span', 'forms__key', 'you see'));
      forms.appendChild(node('span', 'forms__val', d.unicode));
      forms.appendChild(node('span', 'forms__key', 'it goes to'));
      forms.appendChild(node('span', 'forms__val', d.ascii));
      li.querySelector('span:last-child').appendChild(forms);
      return li;
    }

    function brandLine(signal) {
      if (!signal.present) return line('none', 'Not a near-miss of a commonly faked name', null);
      const d = signal.detail;
      return line(
        'found',
        `${d.distance} ${plural(d.distance, 'character', 'characters')} different from ${d.brand}`,
        `${d.label} is impersonated often. Legitimate names sit close to each other too, so this on its own is not conclusive.`,
      );
    }

    function findingFor(r) {
      const box = node('div', 'finding');

      const head = node('div', 'finding__domain');
      head.appendChild(node('span', 'finding__name', r.domain));
      if (r.raw && r.raw !== r.domain) head.appendChild(node('span', 'finding__raw', r.raw));
      box.appendChild(head);

      const lines = node('ul', 'lines');
      lines.appendChild(blocklistLine(r));
      for (const s of r.signals) {
        if (s.id === 'domain-age') lines.appendChild(ageLine(s));
        if (s.id === 'mixed-script') lines.appendChild(scriptLine(s));
        if (s.id === 'brand-similarity') lines.appendChild(brandLine(s));
      }
      box.appendChild(lines);

      // Attribution for any list that claimed this domain. CC BY-SA 4.0 makes
      // this a licence condition, not a courtesy.
      if (r.blocklist.listed && r.blocklist.sources.length > 0) {
        box.appendChild(
          node('p', 'credit', r.blocklist.sources.map((s) => s.attribution).join(' · ')),
        );
      }
      return box;
    }

    // ---------- Running a check ----------

    async function run() {
      const text = elInput.value.trim();
      elResults.textContent = '';
      if (text === '') return;

      btnRun.disabled = true;
      elStatus.textContent = 'Checking…';
      const result = await api.checker.check(text);
      btnRun.disabled = false;

      if (!result || !result.ok) {
        elResults.appendChild(node('p', 'note', (result && result.detail) || 'That could not be checked.'));
        paintCache();
        return;
      }

      cache = result.cache;
      paintCache();

      if (result.results.length === 0) {
        elResults.appendChild(
          node('p', 'note', 'No web address found in that text. Paste a link, or the message it arrived in.'),
        );
        return;
      }

      for (const r of result.results) elResults.appendChild(findingFor(r));
    }

    async function refresh() {
      btnRefresh.disabled = true;
      elStatus.textContent = 'Updating lists…';
      const result = await api.checker.refresh();
      btnRefresh.disabled = false;
      if (result && result.ok) cache = result.cache;
      paintCache();
    }

    async function load() {
      const status = await api.checker.status();
      if (status && status.ok) cache = status;
      paintCache();
    }

    btnRun.addEventListener('click', run);
    btnRefresh.addEventListener('click', refresh);
    elInput.addEventListener('keydown', (e) => {
      // Enter runs it; Shift+Enter is a newline, because a pasted message has
      // newlines in it.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        run();
      }
    });

    return { load };
  })();

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
    // Which window material the app actually got. 'solid' (or anything
    // unrecognised) leaves every surface opaque, which is the default in CSS —
    // the renderer never assumes translucency it wasn't granted.
    const surface = info && info.surface;
    if (surface === 'vibrancy' || surface === 'mica' || surface === 'acrylic') {
      document.documentElement.dataset.surface = surface;
    }
    // isMac is only known now, and the Clean header was drawn before this
    // resolved. Say Trash or Recycle Bin once the platform is actually known.
    clean.setReassurance();
  });

  showEmpty();
  clean.showEmpty();
  check.load();
})();
