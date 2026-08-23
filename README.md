# DiskWatch

A free, open-source desktop app for macOS and Windows that answers three
questions about a disk: what's on it, whether it's protected, and what's safe
to remove. A scam-link checker arrives in v4.

DiskWatch is local-first: no telemetry, no analytics, and no network calls at
all until the v4 link checker — and then only to fetch blocklists.

## Official downloads

DiskWatch is distributed **only** from these sources:

- **GitHub Releases:** https://github.com/OWNER/diskwatch/releases
- **Homebrew tap:** _(coming later)_

> **Anything else is not ours.** Builds of "DiskWatch" from any other website,
> mirror, ad, or download portal are not official and may be tampered with.
> When in doubt, come back here.

### Verify your download

Every release lists a **SHA-256 checksum** for each file, generated in CI (never
on a developer machine). Check your download against it:

```sh
# macOS
shasum -a 256 DiskWatch-<version>.dmg

# Windows (PowerShell)
Get-FileHash .\DiskWatch-<version>.exe -Algorithm SHA256
```

The value must match the one published in that release's notes.

## Trademark

The code is MIT-licensed, but the **DiskWatch** name and logo are not. Forks are
welcome — they must rebrand. See [TRADEMARK.md](TRADEMARK.md).

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) for the source code. Name and logo: see [TRADEMARK.md](TRADEMARK.md).
