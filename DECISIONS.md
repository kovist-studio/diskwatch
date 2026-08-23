# Decisions

A short log of non-obvious design decisions and the reasoning behind them.
Newest first.

## P2 — The IPC boundary (2026-08-23)

**The IPC boundary is the real privilege boundary.** The renderer runs
sandboxed with no Node access; the main process has full filesystem and shell
power. `ipcMain.handle` is the single doorway between them — so that doorway,
not the process split by itself, is where privilege is actually enforced.

**Validation is the gate; policy is the lock.** Every argument crossing IPC is
type/shape checked (reject non-strings, reject empty strings). That guarantees
*well-formed* input, not *safe* input — `"/etc/passwd"` is a perfectly valid
string. Authorization (deletions only via `trash`, cleanup limited to
`targets.json`, never `fs.rm` on user data) is a separate layer that lives in
the handlers.

**The renderer is untrusted even though we wrote it.** "We control both sides"
is true when the code is written, not when it runs. A future DOM-injection bug
(this app renders arbitrary filenames off the user's disk), a compromised
dependency, or a CSP bypass would hand injected script full access to
`window.api`. Validating at the boundary assumes the caller may already be
hostile.
