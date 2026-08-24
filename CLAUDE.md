## Project
DiskWatch — a free, open-source desktop app for macOS and Windows. It answers
three questions about a disk: what's on it, is it protected, and what's safe to
remove. Plus a scam-link checker in v4.

## Stack
- Electron (not Tauri), CommonJS
- Vanilla HTML/CSS/JS in the renderer — no framework, no bundler
- d3-hierarchy for the treemap (added P6). No bundler and a sandboxed renderer
  means it loads as a plain script from `src/renderer/vendor/`, copied verbatim
  from node_modules — unminified so it stays readable. `npm run verify:vendor`
  checks the copy still matches; `npm run sync:vendor` refreshes it.
- `trash` npm package for all deletions, added later
- electron-builder for packaging
- Zero runtime dependencies beyond the above. Ask before adding any package.

## Architecture
- Main process (Node): lifecycle, IPC routing, filesystem, shell commands
- Preload: narrow contextBridge surface. Never expose ipcRenderer directly.
- Renderer (Chromium): UI only, no Node access
- Disk scanning runs in a worker thread, never on the main thread

## Non-negotiable
- webPreferences always: contextIsolation true, nodeIntegration false,
  sandbox true, webviewTag false. Never relax these.
- No fs.unlink / fs.rm / rmdir on user data anywhere in this codebase.
  Deletions go through the `trash` package only.
- ONE exception, and it is exhaustive: emptying the Trash (`macos-trash`) and
  the Recycle Bin (`windows-recycle-bin`). Those files have already been
  classified as discarded by the person who discarded them, and neither bin
  can be trashed a second time. No third id is ever added to this list.
  The exception carries conditions, all of them binding:
  - A separate function. It must NOT share a code path with trash-based
    cleanup — no shared "delete" entry point, no boolean parameter selecting
    permanence. Two call sites that cannot be confused for one another.
  - A separate confirmation, naming the item count and the total size, and
    using the word "permanently".
  - Off by default, and never selected by a select-all.
  This is the only irreversible operation in the app and it should read that
  way at every layer: data, function name, and copy.
- No network calls at all until v4, and then only to fetch blocklists.
  No telemetry, no analytics, no crash reporting, no remote fonts, no CDNs.
- System fonts only. Never load a webfont.
- Cleanup only touches paths listed in src/main/cleaner/targets.json.
- No security score, no threat counts, no urgency language in any UI copy.

## Safe by default, adjustable in Advanced Settings
Custom cleanup paths, select-all, scheduled cleaning, security score, and
opt-in telemetry may all be exposed as settings later. They must ship OFF.
Permanent deletion of scanned files and programmatic FileVault/BitLocker
enabling stay out entirely, regardless of settings.

## Build order
v1 scan + treemap (read-only) → v2 security audit (read-only) →
v3 cleanup (first writes) → v4 link checker
