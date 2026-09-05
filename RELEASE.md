# Releasing

Every step is marked **[auto]** (CI does it, you confirm) or **[you]** (nobody
else will). The whole thing is about fifteen minutes, most of it waiting.

## Before tagging — [you]

```sh
# 1. Bump the version. This is what names the installers.
#    package.json "version": "X.Y.Z"

npm test                # 319 tests, must be green
npm run verify:vendor   # vendored d3-hierarchy still matches node_modules

git add -A && git commit -m "..." && git push origin main
```

Do **not** change `appId` in `electron-builder.yml`. macOS keys Full Disk
Access and every folder permission to it, so changing it silently revokes what
users have granted. See DECISIONS.md.

## 1. Tag and push — [you]

```sh
git tag -a vX.Y.Z -m "DiskWatch vX.Y.Z

<what changed>"
git push origin vX.Y.Z
```

The tag push is the trigger. Nothing else starts a release.

## 2. Watch the run — [auto], you confirm

```sh
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') \
  --repo kovist-studio/diskwatch --exit-status
```

CI builds both platforms natively, then publishes. **What it already checks, so
you don't have to:**

- the vendored copy matches `node_modules`
- the macOS signature is valid, is `app.kovist.diskwatch`, and is not
  `linker-signed` — this is what stops a build shipping as "damaged"
- Gatekeeper can assess the app (`rejected` is correct and expected)
- SHA-256 checksums, generated only in CI, attached and appended to the notes

If the run fails **before any asset is published**, fix it and move the tag:

```sh
git tag -d vX.Y.Z && git push --delete origin vX.Y.Z
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

Once assets *are* published, do not move the tag — cut the next patch version.

## 3. Confirm the assets — [you], one command

```sh
gh release view vX.Y.Z --repo kovist-studio/diskwatch \
  --json assets --jq '.assets[] | "\(.name)  \(.size)"'
```

Expect **six**: `-arm64.dmg`, `-x64.dmg`, `-arm64.zip`, `-x64.zip`,
`-Setup-x64.exe`, `SHA256SUMS.txt`.

Then verify the published sums against the bytes actually served:

```sh
cd "$(mktemp -d)"
gh release download vX.Y.Z --repo kovist-studio/diskwatch
shasum -a 256 -c SHA256SUMS.txt     # five lines, all OK
```

This is the only check that proves the checksums describe what a user
downloads, rather than what CI believed it hashed.

## 4. VirusTotal — [you]

Not automatable here: the API needs a key and the web UI is behind reCAPTCHA.

Upload all three installers at [virustotal.com](https://www.virustotal.com),
wait for each to finish, and keep the three report URLs.

## 5. Update the README — [you]

In **Verify your download → Antivirus reports**, replace all three filenames,
SHA-256 values and report links, and re-date the snapshot line.

Two things to get right:

- The report URL *contains* the file's SHA-256. The hash in the link and the
  hash in the code block below it must be the same string.
- Match each hash to its file from `SHA256SUMS.txt`. Do not infer it from the
  order of anything — the published order and the upload order differ.

State the detection count as a dated snapshot, and only a count you have
actually read. If you cannot read exact denominators, write "no detections"
rather than inventing an `N/M`.

## 6. Install it like a user would — [you]

The last mile no test can reach. Every check above runs from source or against
a build directory; none of them install anything.

1. Download the `.dmg` from the release page in a browser — not `curl`, which
   does not set the quarantine flag.
2. Drag to Applications, try to open it.
3. Confirm the message is the **unverified developer** one, not *"damaged and
   can't be opened"*. Damaged means the signature is broken; stop and fix it.
4. Confirm **System Settings → Privacy & Security → Open Anyway** appears and
   works.
5. Launch it, scan a folder, quit.

If the wording of the macOS dialog has changed, update the README's install
steps to quote what it actually says now.
