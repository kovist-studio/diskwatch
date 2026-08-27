# DiskWatch

A free, open-source desktop app for macOS and Windows that answers three
questions about a disk: **what's on it**, **whether it's protected**, and
**what's safe to remove**. A scam-link checker arrives in v4.

DiskWatch is local-first: no telemetry, no analytics, and no network calls at
all until the v4 link checker — and then only to fetch blocklists.

---

## What v1 does

Point it at a folder and it reads through it, then draws what it found as a
**treemap**: every rectangle's area is its size on disk, so the answer to
"where did 93 GB go" is something you can see rather than scroll through.

- **Colour is file age** — recent files dark, old files pale — so the parts of
  a disk that have gone cold stand out from the parts still in use.
- **Hover** any rectangle for its full path, size, and modified date.
- **Click a folder** to zoom into it; the breadcrumb takes you back.
- **Reveal** shows the hovered item in Finder or Explorer.
- **Folders it couldn't read are counted and reported**, so the totals never
  quietly pretend to be complete.

While a scan runs you get a live count of files, bytes, elapsed time and
skipped folders — and **no progress percentage**, because a directory walk
cannot know its total until it has finished. A bar that fills to 100% and keeps
going is a guess dressed up as a measurement, so there isn't one.

v2 adds the security audit, v3 adds cleanup, v4 adds the link checker.

---

## The rules this app is built to

These are not aspirations, they are constraints on the codebase:

- **It only reads.** v1 never moves, changes, or deletes anything.
- **When deletion arrives in v3, it goes to the Trash** — via the `trash`
  package, never `rm`. Nothing is destroyed outright, and permanent deletion of
  scanned files stays out of the product entirely.
- **Cleanup will only ever touch a fixed, reviewable list of paths**, not
  anywhere it happens to find something.
- **No network access at all** until the v4 link checker, and then only to
  fetch blocklists. No telemetry, no analytics, no crash reporting, no remote
  fonts, no CDNs. System fonts only.
- **The renderer is sandboxed** with `contextIsolation` on and `nodeIntegration`
  off. Every argument crossing between the UI and the filesystem is validated
  at the boundary.
- **No security scores, no threat counts, no urgency language.** A tool that
  manufactures alarm to justify itself is a tool you cannot trust about
  anything else.

Anything that could surprise you — custom cleanup paths, select-all, scheduled
cleaning — will ship **off**, in Advanced Settings, if it ships at all.

---

## Install

**Requirements:** macOS 12 Monterey or later, or Windows 10 or later (64-bit).

Download from **[GitHub Releases](https://github.com/kovist-studio/DiskWatch/releases)**.
Nowhere else — see [Official downloads](#official-downloads) below.

### macOS

Pick the right file for your Mac:

| Your Mac | File |
| --- | --- |
| Apple Silicon (M1/M2/M3/M4) | `DiskWatch-<version>-arm64.dmg` |
| Intel | `DiskWatch-<version>-x64.dmg` |

Not sure? Apple menu → About This Mac. "Chip" means Apple Silicon; "Processor"
means Intel.

1. Open the `.dmg` and drag **DiskWatch** to Applications.
2. **The first launch needs one extra step.** Double-clicking will be refused,
   with a message like *"Apple could not verify DiskWatch is free of malware"*
   or *"DiskWatch can't be opened because it is from an unidentified
   developer"*. That is expected — DiskWatch is unsigned, and
   [here's why](#a-note-on-signing).

   **Right-click** (or Control-click) the app in Applications and choose
   **Open**, then **Open** again in the dialog.

   On macOS 15 Sequoia and later, that right-click route may not appear. Instead:
   try to open the app once and let it be blocked, then go to **System Settings →
   Privacy & Security**, scroll to the message about DiskWatch, and click
   **Open Anyway**.

   You only do this once.
3. **macOS will ask permission** as you scan. Folders like Desktop, Documents
   and Downloads each prompt the first time. To scan the whole of your home
   folder or `~/Library` without gaps, grant **Full Disk Access** in
   **System Settings → Privacy & Security → Full Disk Access**.

   DiskWatch works fine without it — it just reports the folders it couldn't
   open rather than pretending they weren't there.

### Windows

Download `DiskWatch-<version>-Setup-x64.exe` and run it.

1. **SmartScreen will interrupt the first run** with *"Windows protected your
   PC"*. That is expected — DiskWatch is unsigned, and
   [here's why](#a-note-on-signing).

   Click **More info**, then **Run anyway**.
2. The installer is per-user and does not need administrator rights. You can
   choose the install location.

---

## A note on signing

**DiskWatch is not code-signed, and we would rather say so plainly than have
you find out from a scary dialog.**

Signing is not a security check on the code. It is a statement of *identity*,
backed by a paid membership: Apple's Developer Program is a yearly fee, and a
Windows Authenticode certificate is a separate ongoing cost. Neither is in place
yet. Both operating systems treat "not signed" as "unknown", and show a warning
that reads more alarming than the situation warrants.

We could have signed ad-hoc or with a self-issued certificate. We didn't,
because that produces a signature that asserts nothing while looking like it
does — which is exactly the kind of half-measure this project is trying not to
ship.

**What actually protects you here is verification, not a signature:**

- The **source is public**, and deliberately readable. Even the one third-party
  library is vendored unminified so you can read what the app runs.
- Every release lists a **SHA-256 checksum generated in CI**, never on a
  developer's machine.
- The **name and logo are trademarked** precisely so a tampered build can't
  legitimately call itself DiskWatch.

Signing will happen when there's a funded account behind it. Until then, please
check the checksum.

---

## Official downloads

DiskWatch is distributed **only** from these sources:

- **GitHub Releases:** https://github.com/kovist-studio/DiskWatch/releases
- **Homebrew tap:** _(coming later)_

> **Anything else is not ours.** Builds of "DiskWatch" from any other website,
> mirror, ad, or download portal are not official and may be tampered with.
> When in doubt, come back here.

### Verify your download

Every release lists a **SHA-256 checksum** for each file, generated in CI (never
on a developer machine). Check your download against it:

```sh
# macOS
shasum -a 256 DiskWatch-<version>-arm64.dmg

# Windows (PowerShell)
Get-FileHash .\DiskWatch-<version>-Setup-x64.exe -Algorithm SHA256
```

The value must match the one published in that release's notes. If it doesn't,
delete the file and download it again from GitHub Releases.

---

## Building it yourself

```sh
npm ci
npm start                 # run it
npm run build             # installers for the current platform, into dist/
```

`npm run build` produces `.dmg` files on macOS (both architectures) and an NSIS
`.exe` on Windows. Releases are built by CI, one runner per platform, and are
never uploaded from a developer machine.

---

## Trademark

The code is MIT-licensed, but the **DiskWatch** name and logo are not. Forks are
welcome — they must rebrand. See [TRADEMARK.md](TRADEMARK.md).

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) for the source code. Name and logo: see [TRADEMARK.md](TRADEMARK.md).
