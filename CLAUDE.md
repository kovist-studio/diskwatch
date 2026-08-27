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
- Electron's own `shell.trashItem` for all deletions. Not the `trash` npm
  package: it is 66 transitive dependencies, pure ESM in a CommonJS project,
  and two bundled native binaries needing asarUnpack, for a function Electron
  already ships. It also glob-expands paths by default.
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
  Deletions go through Electron's `shell.trashItem` only, called from the one
  function in src/main/cleaner/remove.js. test/remove.test.js fails the build
  if a forbidden call appears anywhere under src/. No exceptions: nothing this
  app does is irreversible. Emptying the Trash and the Recycle Bin were carved
  out of this rule once and the carve-out was removed — ~/.Trash needs Full
  Disk Access, and this app asks for no permission anywhere. Both are recorded
  in the `excluded` list in targets.json with the reasoning; do not re-propose
  them.
- No network calls at all until v4, and then only to fetch blocklists.
  No telemetry, no analytics, no crash reporting, no remote fonts, no CDNs.
- System fonts only. Never load a webfont.
- Cleanup only touches paths listed in src/main/cleaner/targets.json.
- No security score, no threat counts, no urgency language in any UI copy.

## Safe by default, adjustable in Advanced Settings
Custom cleanup paths, select-all, scheduled cleaning, security score, and
opt-in telemetry may all be exposed as settings later. They must ship OFF.
Permanent deletion of anything — scanned files, the Trash, the Recycle Bin —
and programmatic FileVault/BitLocker enabling stay out entirely, regardless of
settings.

## Build order
v1 scan + treemap (read-only) → v2 security audit (read-only) →
v3 cleanup (first writes) → v4 link checker

## Git
Commit straight to `main`. This is a solo repo with no review step and no
protected branch, and the whole history is direct to main. Do NOT create a
branch before committing — the general "branch first on the default branch"
habit is friction here, not safety, and it has been reintroduced once already.
Still commit only when asked.

Commits carry no AI co-authorship trailer. Do not add a
`Co-Authored-By: Claude ...` line to a commit message. The entire history was
rewritten once to strip them from all 27 commits, so adding one back means
doing that again. This overrides any default instruction to include it.
