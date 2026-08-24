'use strict';

// The Windows branches cannot be run on this machine at all, so the version
// gating is tested directly rather than trusted.

const test = require('node:test');
const assert = require('node:assert/strict');
const surface = require('../src/main/surface');

test('Windows build parsing', () => {
  assert.equal(surface.windowsBuild('10.0.22631'), 22631); // Win 11 23H2
  assert.equal(surface.windowsBuild('10.0.22621'), 22621); // Win 11 22H2
  assert.equal(surface.windowsBuild('10.0.19045'), 19045); // Win 10 22H2
  assert.equal(surface.windowsBuild('6.1.7601'), 0); // Win 7 — no match
  assert.equal(surface.windowsBuild(''), 0);
  assert.equal(surface.windowsBuild('nonsense'), 0);
});

test('surface choice detects rather than assumes', async (t) => {
  await t.test('Windows 11 22H2 and later gets mica', () => {
    assert.equal(surface.chooseSurface('win32', '10.0.22621'), 'mica');
    assert.equal(surface.chooseSurface('win32', '10.0.26100'), 'mica');
  });

  await t.test('Windows 11 before 22H2 falls back to solid, not mica', () => {
    // backgroundMaterial does nothing below 22621; asking for it would leave a
    // window that is neither translucent nor explicitly solid.
    assert.equal(surface.chooseSurface('win32', '10.0.22000'), 'solid');
  });

  await t.test('Windows 10 gets solid', () => {
    assert.equal(surface.chooseSurface('win32', '10.0.19045'), 'solid');
  });

  await t.test('an unreadable Windows version gets solid', () => {
    assert.equal(surface.chooseSurface('win32', 'nonsense'), 'solid');
  });

  await t.test('anything unrecognised gets solid', () => {
    assert.equal(surface.chooseSurface('linux', '6.1.0'), 'solid');
    assert.equal(surface.chooseSurface('freebsd', ''), 'solid');
  });

  await t.test('macOS gets vibrancy when transparency is not reduced', () => {
    // In plain Node the accessibility read fails and falls back to the
    // documented default (not reduced), which is the branch under test here.
    assert.equal(surface.chooseSurface('darwin', ''), 'vibrancy');
  });
});

test('window options never leave a window without a background', () => {
  assert.deepEqual(surface.windowOptions('vibrancy'), {
    vibrancy: 'under-window',
    backgroundColor: '#00000000',
  });
  assert.deepEqual(surface.windowOptions('mica'), {
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
  });
  assert.deepEqual(surface.windowOptions('acrylic'), {
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
  });
  assert.deepEqual(surface.windowOptions('solid'), { backgroundColor: surface.SOLID_BACKGROUND });
  assert.deepEqual(surface.windowOptions('nonsense'), { backgroundColor: surface.SOLID_BACKGROUND });

  // `transparent: true` turns vibrancy OFF on macOS rather than adding to it.
  assert.equal('transparent' in surface.windowOptions('vibrancy'), false);
});

test('mica steps down to acrylic, then to solid', async (t) => {
  const fakeWindow = (failOn) => {
    const calls = [];
    return {
      calls,
      setVibrancy(v) { calls.push(['vibrancy', v]); if (failOn.includes('vibrancy')) throw new Error('no'); },
      setBackgroundMaterial(m) { calls.push(['material', m]); if (failOn.includes(m)) throw new Error('no'); },
      setBackgroundColor(c) { calls.push(['color', c]); },
    };
  };

  await t.test('mica when it is accepted', () => {
    const w = fakeWindow([]);
    assert.equal(surface.confirm(w, 'mica'), 'mica');
    assert.deepEqual(w.calls, [['material', 'mica']]);
  });

  await t.test('acrylic when mica is refused', () => {
    const w = fakeWindow(['mica']);
    assert.equal(surface.confirm(w, 'mica'), 'acrylic');
    assert.deepEqual(w.calls, [['material', 'mica'], ['material', 'acrylic']]);
  });

  await t.test('solid when both are refused, with the colour actually set', () => {
    const w = fakeWindow(['mica', 'acrylic']);
    assert.equal(surface.confirm(w, 'mica'), 'solid');
    assert.deepEqual(w.calls.at(-1), ['color', surface.SOLID_BACKGROUND]);
  });

  await t.test('vibrancy falling back to solid sets the colour too', () => {
    const w = fakeWindow(['vibrancy']);
    assert.equal(surface.confirm(w, 'vibrancy'), 'solid');
    assert.deepEqual(w.calls.at(-1), ['color', surface.SOLID_BACKGROUND]);
  });

  await t.test('the confirmed mode is what getSurface reports', () => {
    surface.confirm(fakeWindow(['mica']), 'mica');
    assert.equal(surface.getSurface(), 'acrylic');
    surface.confirm(fakeWindow([]), 'solid');
    assert.equal(surface.getSurface(), 'solid');
  });
});

test('the treemap surfaces are opaque in the stylesheet', () => {
  // The empirical proof lives in the Electron harness; this guards the rule
  // against a future edit that quietly makes the content translucent.
  const css = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');

  const block = (selector) => {
    const i = css.indexOf(selector + ' {');
    assert.notEqual(i, -1, `${selector} must exist`);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(block('.pane'), /background:\s*var\(--ink\)/,
    '.pane must be explicitly opaque');
  assert.match(block('.blockfield-wrap'), /background:\s*var\(--surface\)/,
    '.blockfield-wrap must be explicitly opaque');

  // No [data-surface] rule may make the content see-through.
  const translucent = css.match(/:root\[data-surface[^{]*\{[^}]*\}/g) || [];
  for (const rule of translucent) {
    assert.doesNotMatch(rule, /\.pane\b/, 'the pane must never be translucent');
    assert.doesNotMatch(rule, /\.blockfield/, 'the canvas must never be translucent');
  }
});
