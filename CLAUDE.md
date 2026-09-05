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
- No network calls at all except ONE: src/main/checker/fetch.js, fetching the
  blocklist URLs written in src/main/checker/sources.json and nothing else. A
  URL from any other origin is a hard error, not a request. HTTPS only, never
  a redirect to http. No telemetry, no analytics, no crash reporting, no
  remote fonts, no CDNs, and no network access from the renderer at all.
- Never ship a Bloom filter or any other structure derived from the
  blocklists. Two sources are copyleft (GPL-3.0, CC BY-SA 4.0), so a
  distributed derivative would have to carry both. Each install fetches and
  builds its own. See DECISIONS.md before "optimising" this.
- System fonts only. Never load a webfont.
- Cleanup only touches paths listed in src/main/cleaner/targets.json.
- The renderer never names a destination. It sends an id and the main process
  resolves what that id means from a list main already holds: cleanup takes
  tokens, not paths; the Security tab's settings link takes a check id, not a
  URL; the fetcher takes a source id, not a URL. Same rule, three places. A
  renderer that has been taken over has nothing to name, so there is nothing
  to validate — an unknown id matches nothing, rather than being resolved and
  then denied.
- `shell.openExternal` is called from exactly one place, the security:openFix
  handler in src/main/ipc.js, on a URL resolved from the audit that ran and
  only if it starts with `x-apple.systempreferences:`, `ms-settings:` or
  `windowsdefender:`. Never http or https: nothing in this app opens a web
  page. A check whose fixUrl is null (SIP, drive health) opens nothing at all.
- No security score, no threat counts, no urgency language in any UI copy.
  Security check statuses read "Nothing to change", "Worth a look", "Couldn't
  check" and "Doesn't apply". Never On/Off — two checks are health readings
  rather than switches, so "On" beside a drive reporting failure would be
  false — and never Pass/Fail, which is the scoreboard vocabulary this app
  exists not to use. Unknown is not a failure and every unknown row says so.
  The check list is never sorted by status and never totalled.

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
