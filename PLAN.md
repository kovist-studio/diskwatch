# Project Plan — Cross-Platform Disk Health, Security & Cleanup App

**Status:** Draft for approval
**Target platforms:** macOS + Windows
**Model:** Free, open source, no ads, no upsell

> **DECISIONS.md wins.** This file is the plan as first written. `DECISIONS.md`
> is the record of what was actually decided and built, including the places
> where building it proved the plan wrong. Where the two disagree, DECISIONS.md
> is correct and this file is out of date.
>
> Sections corrected against shipped code on 2026-08-27: §2 (permanent
> deletion), §3 (trash, updates), §5 (treemap colour), §7 (allowlist and
> acceptance).
> Anything still unbuilt below is a plan, and may change the same way.

---

## 1. What this is

One desktop app that answers three questions about a computer's disk:

1. **What's on it?** — visual breakdown of where space actually went
2. **Is it protected?** — encryption, firewall, drive health, startup items
3. **What can I safely remove?** — vetted junk, moved to Trash, never deleted

Plus a bundled scam-link checker (v4) as a fourth tab.

### What this explicitly is NOT

| Not this | Because |
|---|---|
| An antivirus | Real detection needs signature DBs + real-time interception. Being wrong is expensive both directions. |
| A registry cleaner | Snake oil. Actively harmful. |
| A "speed booster" | Meaningless claim, universal scam signal. |
| A one-click auto-fixer | Every action is user-initiated and reversible. |

### Positioning

Most tools in this category are scareware. The differentiator is restraint: honest numbers, no manufactured urgency, open source, reversible actions. That restraint is also the portfolio story — see §11.

---

## 2. Safe defaults + Advanced Settings

Every behaviour below **ships safe by default**. Advanced Settings can loosen most of them. Defaults do the protective work, because the large majority of users never open a settings pane — so availability costs far less than a bad default would.

| # | Behaviour | Default | Adjustable? |
|---|---|---|---|
| 1 | Trash instead of permanent delete | On | **No** — absolute, no carve-out |
| 2 | Allowlist-only cleanup | On | **Yes** — custom paths, still routed through Trash |
| 3 | Per-item checkboxes, none pre-selected | On | **Yes** — "Select all" permitted; confirmation still required |
| 4 | Scan and clean as separate steps | On | **Yes** — scheduled auto-clean, restricted to allowlist + Trash |
| 5 | Security checks read-only | On | **Partial** — see below |
| 6 | Checklist, no score | On | **Yes** — score permitted if computed from real check results |
| 7 | No telemetry | On | **Yes** — opt-in only, never opt-out, never on by default |

### Settings implementation

- Advanced Settings live behind a collapsed section with a one-time explanation of what each toggle changes
- Persist to `settings.json` in `app.getPath('userData')`
- Every non-default setting is read at action time, never cached at startup
- A "Reset to safe defaults" button
- Any loosened setting is surfaced in the pre-action confirmation dialog, so the user is reminded at the moment it matters

### 1 — Permanent deletion: kept out entirely

**~~Allowed: an explicit Empty Trash action.~~** *Removed 2026-08-26. This carve-out was written, specified in full, implemented in the loader, and then deleted. Reading `~/.Trash` on macOS needs Full Disk Access — including merely to count the items and total the bytes the confirmation was required to display. This app asks for no permission anywhere else, so the product would have had exactly one permission prompt, attached to its only irreversible operation, to do something Finder already does. The Recycle Bin went with it: it cost nothing on its own, but keeping it means keeping the exception, and a rule with one carve-out is not the same rule as one without. See DECISIONS.md, "The permanent-deletion exception lasted one phase".*

**There is now no permanent deletion in this app, for any id, under any condition.** `~/.Trash` and `C:\$Recycle.Bin` are recorded in the `excluded` list in `targets.json` with the reasoning attached, because an entry that is merely absent gets re-proposed. The loader treats `method: "emptyTrash"` as a hard error naming the reason.

**Also not allowed:** a general "skip Trash" toggle applied to scanned files. Three reasons:

1. **Bug surface, not user choice.** The toggle isn't the risk — the existence of the code path is. Once `unlink` on scanned paths exists in the codebase, every path-resolution bug has permanent deletion as its blast radius, including for users who never touched the setting. Keeping the path absent is what makes the guarantee real.
2. **Adverse selection.** The users who enable "skip Trash to save time" are systematically the users least equipped to judge what they're about to lose.
3. **The speed premise is false.** Trashing on the same volume is a metadata move — effectively instant. There is no performance to win.

Genuine edge case: external and network volumes where Trash may not exist. Handle that by detecting it and asking per-action, not with a global toggle.

### 5 — Security remediation: partial

**Can be enabled:** firewall toggle, Defender toggle, opening the correct settings pane — reversible changes that need no key material.

**Should stay out:** programmatically enabling FileVault or BitLocker. Both generate a recovery key. Mishandle it, and the user's entire disk is unrecoverable — permanently, with no support path. Link to System Settings instead; the OS handles key custody properly.

### Still fixed regardless of settings

- No invented threat counts, no manufactured urgency, no scareware copy
- No `Windows.old` handling
- Confirmation dialogs cannot be permanently dismissed for destructive actions

---

## 3. Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Shell | **Electron** | Node `fs` for scanning, `child_process` for system commands, `electron-builder` handles both installers. Large training corpus = strong AI assistance. |
| UI | **Vanilla HTML/CSS/JS** | No build step, no framework to learn. Revisit if state gets unmanageable. |
| Treemap | **D3** (`d3-hierarchy`) | `d3.treemap()` with squarified tiling is the standard solution. |
| Trash | **Electron's `shell.trashItem`** | Ships with Electron; does the same job on both platforms. The `trash` npm package was rejected on inspection: 66 transitive dependencies into a project with one, pure ESM in a CommonJS codebase, two bundled native binaries needing `asarUnpack` and eventually signing — and it glob-expands paths by default, so a file named `report[1].pdf` does not mean what it reads like and `!invoice.zip` becomes a negation. |
| Packaging | **electron-builder** | `.dmg` (arm64 + x64) and NSIS `.exe`. |
| CI | **GitHub Actions** | Matrix build on `macos-latest` + `windows-latest`. Free for public repos. |
| Updates | **None in-app** | `electron-updater` was planned and is not installed. `electron-builder.yml` sets `publish: null`; `.github/workflows/build.yml` builds with `--publish never` and uploads artifacts with `gh release create`. Users update by installing a newer build. |

**Electron vs Tauri:** Tauri produces ~10MB binaries vs Electron's ~120MB, and Rust walks a filesystem noticeably faster on a large drive. But Rust is a heavy lift for a first project and has thinner AI support. Decision: **Electron now, port later if scan speed becomes a real complaint.** Keep scanner logic isolated in one module so a port stays cheap.

### Electron security config — non-optional

```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, '../preload/index.js')
}
```

A security-branded app shipping with `nodeIntegration: true` is the kind of thing that gets screenshotted. The renderer gets a narrow `contextBridge` API and nothing else.

---

## 4. Architecture

```
┌─────────────────────────────────────────────┐
│ Renderer (Chromium) — UI only, no Node      │
│  index.html · app.js · treemap.js           │
└───────────────────┬─────────────────────────┘
                    │ contextBridge (narrow, explicit)
┌───────────────────┴─────────────────────────┐
│ Preload — whitelisted IPC surface           │
└───────────────────┬─────────────────────────┘
                    │ ipcMain / ipcRenderer
┌───────────────────┴─────────────────────────┐
│ Main (Node) — lifecycle, IPC routing        │
│   ├── scanner.worker.js  (worker thread)    │
│   ├── security/{macos,windows}.js           │
│   └── cleaner/ + targets.json               │
└─────────────────────────────────────────────┘
```

The disk scan runs in a **worker thread**. A synchronous walk of a 500GB drive freezes the UI for minutes.

### File layout

```
DiskWatch/
├── package.json
├── electron-builder.yml
├── LICENSE                     # MIT
├── README.md                   # includes the 7 safety rules
├── PLAN.md                     # this file
├── src/
│   ├── main/
│   │   ├── index.js
│   │   ├── ipc.js
│   │   ├── scanner.js
│   │   ├── scanner.worker.js
│   │   ├── security/
│   │   │   ├── index.js        # runner + result shape
│   │   │   ├── macos.js
│   │   │   └── windows.js
│   │   └── cleaner/
│   │       ├── index.js
│   │       └── targets.json    # the allowlist — plain data, auditable
│   ├── preload/index.js
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       ├── app.js
│       ├── treemap.js
│       └── views/
├── build/                      # icons: icon.icns, icon.ico
└── .github/workflows/build.yml
```

`targets.json` as **data rather than code** is deliberate: anyone can read exactly what the app will touch without following logic. That's most of the trust argument.

---

## 5. v1 — Scan & Visualize

Read-only. Zero risk. The treemap is the hard part, so it comes first.

### Scanner

Recursive walk using `fs.promises.opendir` (streaming — doesn't buffer huge directories into memory).

Must handle:

- **Permission errors** (`EACCES` / `EPERM`) — skip, count, surface as "N folders unreadable"
- **Symlinks** — do not follow. Infinite loops otherwise.
- **Hard links** — track inodes to avoid double-counting
- **Mount points** — don't cross onto other volumes without asking
- **Progress** — batch IPC updates every ~200ms. One event per file will flood the channel and stall the UI.

Node shape: `{ name, path, size, type, children[] }`, sizes aggregated bottom-up after the walk.

### Treemap

- `d3.hierarchy()` → `d3.treemap()` with `d3.treemapSquarify`
- **Prune before rendering.** Drop nodes under ~0.1% of parent area. Half a million rectangles will kill the renderer.
- **Canvas, not SVG,** above ~5,000 nodes. SVG DOM gets slow fast.
- Click to zoom into a directory, breadcrumb trail to navigate back
- Colour by **age**, on a log scale — not by category. Category colouring needs a legend to decode, invents a taxonomy from file extensions, and a six-colour palette implies a sequence that does not exist. Age is genuinely ordinal, so one light-to-dark ramp reads correctly with no legend to learn. The scale is logarithmic because a linear map puts ~91% of `~/Library`'s files in the first tenth of the ramp; `Math.log1p` spreads the same files across all of it.
- Hover → path, size, modified date
- "Reveal in Finder / Explorer" via `shell.showItemInFolder()`

### v1 acceptance criteria

- [ ] Scans a full home directory without freezing the UI
- [ ] Handles permission-denied gracefully, reports the count
- [ ] Treemap renders in under 2s post-scan
- [ ] Zoom + breadcrumb navigation works
- [ ] Reveal-in-file-manager works on both platforms
- [ ] Zero write operations anywhere in the codebase

---

## 6. v2 — Security Audit

Read-only checks. Each returns `{ id, label, status: 'pass'|'fail'|'unknown'|'na', detail, fixUrl }`.

### macOS

| Check | Command |
|---|---|
| FileVault | `fdesetup status` |
| SIP | `csrutil status` |
| Gatekeeper | `spctl --status` |
| Firewall | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` |
| SMART / drive health | `diskutil info -plist /` → parse `SMARTStatus` |
| Auto-updates | `defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled` |
| Unsigned apps | `spctl -a -vv <app>` / `codesign -dv <app>` |
| Startup items | scan `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` |

### Windows (PowerShell)

| Check | Command | Admin? |
|---|---|---|
| BitLocker | `Get-BitLockerVolume` | Yes |
| Defender | `Get-MpComputerStatus` | No |
| Firewall | `Get-NetFirewallProfile` | No |
| Drive health | `Get-PhysicalDisk \| Select HealthStatus` | No |
| SSD wear / power-on hours | `Get-PhysicalDisk \| Get-StorageReliabilityCounter` | Usually |
| Secure Boot | `Confirm-SecureBootUEFI` | Yes |
| Startup items | `Get-CimInstance Win32_StartupCommand` | No |

> **Verify every one of these manually in Terminal / PowerShell before wiring it up.** macOS changes these between releases, and the Windows admin requirements above are my best understanding rather than tested fact. Which ones need elevation directly shapes the UX, so test early. Where elevation is needed, degrade to `unknown` with an explanation — never nag for admin on launch.

### The headline feature: SSD wear, in plain language

Translate raw counters into sentences people understand:

> "Your SSD has used about 61% of its rated write endurance."
> "This drive has been powered on for 4.2 years."

Nobody presents this in a friendly way. It's surprising, actionable, screenshot-worthy — and it ties the two halves of the app together, since junk writes wear out SSDs.

### Credential exposure — permissions only, never contents

- SSH private keys with world-readable permissions
- `.env` / `.aws/credentials` sitting inside a synced cloud folder
- Unencrypted iOS backups

Report the **path and the problem**. Never read or display file contents. That line is both the ethical boundary and a good thing to be able to articulate in an interview.

### v2 acceptance criteria

- [ ] Every check returns a defined status; none crash on unexpected output
- [ ] Elevation-required checks degrade to `unknown` with a clear reason
- [ ] Each failing check links to the correct settings pane
- [ ] No score anywhere in the UI
- [ ] Nothing is ever auto-remediated

---

## 7. v3 — Cleanup

Only now does the app gain write capability, and only through `shell.trashItem`, called from the single function in `src/main/cleaner/remove.js`.

### `targets.json` entry shape

```json
{
  "id": "xcode-derived-data",
  "label": "Xcode DerivedData",
  "platform": "darwin",
  "path": "~/Library/Developer/Xcode/DerivedData",
  "description": "Build intermediates. Xcode regenerates these; next build will be slower.",
  "risk": "safe",
  "defaultEnabled": false,
  "requiresAppClosed": ["Xcode"]
}
```

### Initial allowlist

**macOS:** `~/Library/Caches/*` · Xcode DerivedData · CoreSimulator caches · `~/.npm/_cacache` · pip cache · `~/.cargo/registry/cache` · Homebrew cache · Downloads older than 90 days *(flagged, never pre-selected)*

**Windows:** `%TEMP%` · Chrome / Edge / Firefox caches · npm / pip / cargo caches · Downloads older than 90 days *(flagged, never pre-selected)*

**Dropped from the list above, each recorded in `excluded` in `targets.json` with its reason:**

| Dropped | Why |
|---|---|
| Trash · Recycle Bin | No permanent deletion exists any more — see §2. |
| `C:\Windows\Temp` | Needs administrator rights, which this app asks for nowhere. |
| `C:\Windows\SoftwareDistribution\Download` | Needs administrator rights, and doing it correctly means stopping the Windows Update service. |
| CoreSimulator **device images** | Holds the simulators themselves and everything installed on them. Only the *caches* directory is offered. |
| iOS backups in `MobileSync/Backup` | Still in the allowlist, but withheld at runtime: its `expand` contract requires per-device selection, no handler exists, and `ifUnsupported: omit` means it does not ship as a folder-level checkbox. |
| `~/Library/Caches/JetBrains` | Excluded *within* the caches target — it holds LocalHistory, per-file edit history for uncommitted work. |

`Windows.old` is **excluded** — it needs special handling and getting it wrong is unrecoverable.

### v3 acceptance criteria

- [x] No `fs.unlink` / `fs.rm` / `fs.rmdir` anywhere under `src/` — not checked by hand but by `test/remove.test.js`, which strips comments, scans every `.js` file, and fails the build. Verified by inserting a call and watching the suite go red.
- [x] Everything routes through `shell.trashItem`, from one function
- [x] Every item unchecked by default — the loader makes `defaultEnabled !== false` a hard error, and `test/clean-ipc.test.js` fails if the UI assigns a checkbox anything but `false`, or contains a select-all
- [x] Removal accepts **single-use tokens, never paths**. A path can be forged by anything reaching the IPC boundary; a `randomUUID` in a process-local ledger cannot. Eight gates re-prove every token against the live filesystem immediately before it is used.
- [x] ~~Confirmation dialog lists exact paths~~ — **changed in build.** The confirmation names each selected target, its size and its item count. It does not list paths: one target resolves to 165 items and another to 1,040, so a path list is unreadable at exactly the moment attention matters most. The renderer never receives paths from a survey at all.
- [x] ~~Warns when a target belongs to a running app~~ — **stronger than planned.** It is a refusal, not a warning: the item is skipped with `app-running`. An unanswerable check (`ps` fails, times out, or names an app the table does not know) also refuses.
- [x] Verified against real hardware, not fixtures — `tools/cleaner-remove.js` ran the real `shell.trashItem` against a 150 MB cache directory, which was then restored intact with Finder's Put Back

---

## 8. v4 — Scam Link Checker

Fourth tab. Sources (all free, plain text over CDN, no API key):

- **Phishing Army** — regenerated every 6h from PhishTank, OpenPhish, Cert.pl, PhishFindR, urlscan.io, Phishunt.io, with whitelist filtering
- **PhishDestroy** — 208k+ entries via jsDelivr, no rate limits
- **jarelllama/Scam-Blocklist** — newly-registered scam domains
- **CyberHost** — CC BY-SA 4.0, each entry tagged with its source and date

Store as a **Bloom filter**, not a raw list: ~200k domains compress to a few hundred KB with instant lookups and no false negatives. This is what Google Safe Browsing does locally. It's also the single best thing in this project to discuss in an interview.

Cache locally, refresh daily. This is exactly why the desktop version beats a web page — no re-downloading 200k domains per visit, works offline, URLs never leave the machine.

### Local heuristics (no data source required)

- Domain age via RDAP — the strongest single scam signal
- Homograph detection — Cyrillic `а` masquerading as Latin `a`
- Levenshtein distance against commonly-spoofed brands — catches `paypaI.com`

### The wording rule

**Never display "This site is safe."** Display **"Not found in 6 blocklists (checked 2 hours ago)."**

A false *malicious* verdict annoys someone. A false *safe* verdict is how a person loses their savings.

---

## 9. Build & distribution

### Pipeline

`git tag v0.1.0` → GitHub Actions matrix build (macos-latest, windows-latest) → electron-builder → artifacts attached to a GitHub Release → `electron-updater` picks it up.

### Channels

| Platform | Channel | Notes |
|---|---|---|
| macOS | **Homebrew Cask via own tap** | `brew tap kovist-studio/apps && brew install --cask diskwatch`. Homebrew strips the quarantine flag, so users see **no** Gatekeeper warning. Own tap first; official cask has notability requirements. |
| macOS | Direct `.dmg` | Requires right-click → Open on first launch. Document it clearly. |
| Windows | Direct `.exe` | SmartScreen warning until reputation accrues. Document "More info → Run anyway". |
| Windows | winget / Scoop | Manifest submission, free. |

### Costs

| Item | Cost |
|---|---|
| Domain (Cloudflare Registrar, at-cost) | ~$12/yr |
| Hosting (Cloudflare Pages) | $0 |
| CI/CD (GitHub Actions, public repo) | $0 |
| Homebrew / winget / Scoop | $0 |
| Apple Developer Program | $99/yr — **deferred** until there are users worth signing for |
| Windows code signing | **Skipped** — $200–400/yr, not worth it |

**Start-up cost: ~$12.**

---

## 10. Timeline

Part-time, first project, AI-assisted:

| Milestone | Estimate |
|---|---|
| Repo, Electron boilerplate, window, IPC skeleton | 3–5 days |
| v1 — scanner + treemap | 2–3 weeks |
| v2 — security audit | 1–2 weeks |
| v3 — cleanup | 2 weeks |
| v4 — link checker | 2 weeks |
| Landing page, icons, distribution setup | 1 week |

**Realistic total: 2–3 months part-time.** First-project estimates always slip; the version split exists so every stage is independently shippable. If you stop after v2 you still have a real, useful, finished app.

---

## 11. Portfolio & EC track

Do these *during* the build, not after — reconstructing them later is painful and shows.

- **Commit regularly with real messages.** A commit history spanning months is evidence of sustained work in a way a finished repo isn't.
- **Keep a `DECISIONS.md`.** Log each significant call and why. The seven safety rules in §2 are the centrepiece.
- **Track downloads.** The GitHub Releases API exposes per-asset download counts for free. "1,400 downloads" beats "I built an app."
- **Write a short post per version.** Explaining a Bloom filter or a squarified treemap in plain English demonstrates understanding better than the code does.
- **Be able to explain any file you ship.** After I write something, ask me to walk you through it, then change something and confirm it still works.

The strongest thing you'll be able to say in an interview isn't "I built a disk cleaner." It's: *"I built a disk cleaner, then deliberately constrained it so it structurally cannot lose your data — here's each rule and the failure it prevents."* That's engineering judgement, and it's what gets probed.

---

## 12. Decisions needed before code

1. **Project name** — needed before buying the domain
2. **License** — recommend **MIT** (simpler and more permissive than BleachBit's GPL)
3. **Node.js installed?** — need v20+
4. **GitHub account ready?**
5. **Confirm Electron over Tauri**

---

## 13. First execution step on approval

1. `package.json`, dependencies, electron-builder config
2. Main process with hardened `webPreferences`
3. Preload with a minimal `contextBridge` surface
4. Window that opens, with tab shell (Scan / Security / Clean)
5. Scanner worker walking a directory and reporting progress
6. Verify it runs on both Mac and Windows before touching the treemap

Nothing is written to disk by this app until v3.
