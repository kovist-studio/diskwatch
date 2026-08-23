# Decisions

A short log of non-obvious design decisions and the reasoning behind them.
Newest first.

## P3 — Tree ownership: the worker prunes before the handoff (2026-08-23)

**The worker owns the full tree; nothing else ever sees it.** The worker builds
the complete graph, then prunes to a renderable subset (<= 5,000 nodes) *before*
`postMessage`. Main and the renderer only ever receive the pruned tree.

**Why in the worker, not in main.** Peak memory is at the worker->main handoff:
`postMessage` structured-clones the tree, so for a moment two full copies exist
(worker heap + main heap). Pruning in main happens *after* that clone — too late.
Pruning in the worker eliminates the second copy entirely (and the future third
copy that the treemap would need in the renderer). Measured on ~/Library
(~749K nodes): peak RSS **1,071 MB -> 431 MB**. The worker then exits and its
full-tree copy dies with it; main holds ~5 MB.

**Pruning rule.** Within each directory, children below 0.1% of the parent's
size collapse into one synthetic `(smaller items)` node (so every expanded
directory's total reconciles exactly — verified: max error 0 bytes). A global
best-first budget caps output at ~5,000 nodes, spending detail on the largest
subtrees. Directories left unexpanded are marked `pruned: true` and keep their
real `size` and `childCount`, so the UI can show there's more inside.

**Zoom is a re-scan.** Drilling into a pruned directory is just
`startScan(thatSubdir)` — no new machinery, and it never has to reconstruct or
retain the full tree.

**Deferred / rejected.** Dropping per-node `path` strings (build paths lazily
from parents) is held for later: with this design it only affects the worker's
transient peak and is self-contained enough to add without touching consumers.
Structure-of-arrays + transferables is rejected here — it's the right call only
north of ~5M nodes, and the wrong complexity at this scale.

## P3 — Disk scanner (2026-08-23)

**Files omit the `children` array; only directories have one.** Skipping a
per-file empty-array allocation matters at hundreds of thousands of nodes. The
consequence: any consumer walking the tree must branch on `type === 'dir'`
before touching `children` — it is `undefined` on files, not `[]`. The
`d3-hierarchy` treemap in P6 will walk this tree and must respect that.

**Hard-link duplicates report `size: 0`.** The first sighting of a multi-linked
inode carries its real size; later sightings show 0, matching true disk-usage
(`du`) semantics rather than logical file size.

**Sizes are aggregated in a second pass, in reverse discovery order.** The walk
records directory nodes in pre-order; iterating that list backwards totals every
child before its parent — bottom-up aggregation without recursion.

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
