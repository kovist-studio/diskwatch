# Security policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue
for a suspected vulnerability.

- **Email:** tyk201212@gmail.com
- Suggested subject: `DiskWatch security`

Include, if you can:

- A description of the issue and its impact
- Steps to reproduce, ideally a proof of concept
- The affected version or commit
- Your platform (macOS or Windows) and OS version

## What to expect

- Acknowledgement within a few days.
- We'll work with you on a fix and coordinate disclosure. Please allow a
  reasonable window to ship a fix before any public disclosure.
- With your permission, we'll credit you when the fix ships.

## Especially in scope

DiskWatch reads the filesystem, and later moves files to the OS trash (v3) and
checks links against blocklists (v4). Reports we care about most:

- Anything that could delete or permanently destroy user data
- Path handling that escapes the intended cleanup targets
- Code execution via crafted filenames or file contents
- Anything that weakens the Electron sandbox / context-isolation guarantees
- Impersonation or tampered builds (see the README's "Official downloads")

## Supported versions

Security fixes target the latest released version.
