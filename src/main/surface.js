'use strict';

// Window translucency, and the rules about where it is allowed to apply.
//
// The rule that matters: translucency is for the CHROME — the left rail and
// the title bar strip — and never for the content. The treemap's colour ramp
// encodes file age across a calibrated lightness range, and compositing it
// over an unknown wallpaper destroys exactly the separation that ramp exists
// to provide. Finder draws the same line: vibrant sidebar, opaque file list.
// The renderer enforces its half in styles.css; this module decides only
// whether the window is translucent at all.

const os = require('node:os');

// Required lazily and defensively: the detection logic below is unit-tested in
// plain Node, where `electron` resolves to a path string rather than the API.
function electronAPI() {
  try {
    return require('electron') || {};
  } catch {
    return {};
  }
}

const SOLID_BACKGROUND = '#12161F'; // --ink
const TRANSPARENT = '#00000000';

// Windows 11 22H2. backgroundMaterial does nothing at all below this, so
// asking for it there would leave a window that is neither translucent nor
// explicitly solid.
const WIN11_22H2_BUILD = 22621;

let active = 'solid';

// macOS accessibility: "Reduce transparency". Ignoring it is an accessibility
// failure, not a cosmetic one — it is set by people for whom translucent text
// backgrounds are genuinely hard to read.
//
// Absence of the key means the setting has never been changed, and for THIS
// preference the documented default is off — unlike the automatic-updates
// case, where absence carried no such guarantee. Read defensively anyway.
function prefersReducedTransparency() {
  if (process.platform !== 'darwin') return false;
  try {
    const { systemPreferences } = electronAPI();
    return systemPreferences.getUserDefault('AppleReduceTransparency', 'boolean') === true;
  } catch {
    return false; // unreadable: fall back to the documented default
  }
}

// os.release() on Windows reports the NT version, e.g. "10.0.22631".
function windowsBuild(release) {
  const match = /^10\.0\.(\d+)/.exec(release || os.release());
  return match ? Number(match[1]) : 0;
}

// Detect rather than assume. Every branch that cannot prove support returns
// 'solid', because a window that asked for a material it did not get renders
// with no background at all.
function chooseSurface(platform, release) {
  const plat = platform || process.platform;
  if (plat === 'darwin') {
    return prefersReducedTransparency() ? 'solid' : 'vibrancy';
  }
  if (plat === 'win32') {
    return windowsBuild(release) >= WIN11_22H2_BUILD ? 'mica' : 'solid';
  }
  return 'solid';
}

function windowOptions(mode) {
  switch (mode) {
    case 'vibrancy':
      // No `transparent: true` here — it turns vibrancy off on macOS rather
      // than adding to it.
      return { vibrancy: 'under-window', backgroundColor: TRANSPARENT };
    case 'mica':
    case 'acrylic':
      return { backgroundMaterial: mode, backgroundColor: TRANSPARENT };
    default:
      return { backgroundColor: SOLID_BACKGROUND };
  }
}

// Re-applies the material after creation so an API that refuses at runtime is
// caught, and steps down rather than leaving a window with no background:
// mica -> acrylic -> solid.
function confirm(win, requested) {
  let mode = requested;
  try {
    if (mode === 'vibrancy') {
      win.setVibrancy('under-window');
    } else if (mode === 'mica') {
      try {
        win.setBackgroundMaterial('mica');
      } catch {
        win.setBackgroundMaterial('acrylic');
        mode = 'acrylic';
      }
    }
  } catch {
    mode = 'solid';
  }
  if (mode === 'solid') {
    try {
      win.setBackgroundColor(SOLID_BACKGROUND);
    } catch {
      /* nothing further to fall back to */
    }
  }
  active = mode;
  return mode;
}

const getSurface = () => active;

module.exports = {
  SOLID_BACKGROUND,
  chooseSurface,
  windowOptions,
  confirm,
  getSurface,
  windowsBuild,
  prefersReducedTransparency,
};
