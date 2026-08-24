# Decisions

A short log of non-obvious design decisions and the reasoning behind them.
Newest first.

## P6 — The treemap (2026-08-24)

**Decision:** a squarified treemap drawn to the same canvas the block field
uses, replacing the finished-scan summary list.

### Why a treemap replaces the "largest items" list

The list answered "what are the ten biggest things here". The treemap answers
"where did 93 GB go" — including the case the list is worst at, where no single
item is large but a thousand small ones together are. Area is the answer, and
area is what a treemap draws.

The summary figures (total size, files, folders, skipped) and the skipped-folder
note are kept. A treemap shows none of them, and the skipped note is a
truthfulness requirement, not a decoration.

### Canvas, not SVG

The pruned tree carries up to 5,000 nodes. As SVG that is 5,000 live DOM
elements to style, hit-test, and reflow, and every hover re-enters the DOM's
own hit-testing. As canvas it is one element and a loop of `fillRect` calls,
with hit-testing done by comparing four numbers per node. Measured: layout plus
a full repaint of the real ~/Library tree is **33ms**, and a hover scan of all
5,000 nodes is a few thousand comparisons.

### How squarify works, and why it isn't just "area = size"

Any treemap makes area proportional to size. The hard part is *shape*: a
1000x1 sliver and a 32x32 square have the same area, but only one can be seen,
labelled, or clicked.

The naive algorithm ("slice and dice") alternates direction by depth: cut the
parent into vertical strips, cut each strip into horizontal bands, and so on.
It is trivial and it produces slivers — measured on the same real data, its
median rectangle had an **aspect ratio of 180:1** against squarify's **1.5:1**.

Squarify is greedy. It fills the rectangle one *row* at a time, laying children
into the current row in descending size order. Before adding each child it asks:
*does adding this improve the worst aspect ratio in this row, or make it worse?*
If it improves, add it. If it makes it worse, close the row, and start a new one
in the space that remains. Rows run along the shorter side of the remaining
space, which is what keeps each row's cells near-square.

The greedy choice is the whole trick, and it is worth stating why it works: a
row's cells all share one thickness, so adding another item makes the row
thicker while making every cell in it narrower. The first few additions help —
a thick short row of one item is a bad sliver — and past a point they hurt.
That turning point is a local minimum you can detect with only the current row
in hand, which is why the algorithm needs no lookahead and runs in one pass.

It is a heuristic, not an optimum: squarify makes no claim to the best possible
layout, only a good one, cheaply. The **13:1 worst case** in our own data is
real and is the price. It also does not preserve order — neighbouring
rectangles mean nothing — which is the trade it makes to get shape.

### Sizing: why a plain `.sum()` would be wrong

The worker already aggregates `size` onto directories. Handing that to d3's
`.sum(d => d.size)` counts every byte twice: once in the file, once in each
ancestor. Verified — on ~/Library a naive sum reports well over double the
true total.

So the value function asks whether a directory's children are *present in this
tree*. If they are, the directory contributes 0 and takes its value from them.
If it is a leaf here — pruned, or genuinely empty — it contributes its own
`size`, which is the only surviving record of what is inside it. With this, the
treemap's root value equals the scanner's `bytesSeen` exactly.

The children accessor branches on `type === 'dir'`, never on whether `children`
is truthy: P3 established that files omit the array entirely, and the shape of
the data should stay explicit at every consumer.

### Padding must not become a second pruning

A flat 1px gap between siblings is legible on big rectangles and fatal on small
ones — d3 collapses a rectangle whose padding exceeds its size. Measured with a
flat 1px: **1,907 of 4,760 rectangles collapsed to nothing on ~/Library, and
2,793 of 3,492 on ~/Downloads**. The worker already decided what was worth
showing; padding silently discarding 40-80% of it is the renderer overruling
that decision invisibly.

So the gap is spent only where the average child can survive it (area per child
above ~120px²). That recovers most of them — 4,452 of 4,760 drawable — and, as
a side effect, *improves* the median aspect ratio, because unpadded small cells
keep their proportions. What remains lost is genuinely sub-pixel: on
~/Downloads, 9.9 GB is dominated by a handful of large files, so thousands of
small ones are truly too small to draw. That is what zoom is for.

### Colour is monochromatic on purpose

Six categories — media, documents, code, other, caches, system — at one hue
(the brass 40°), separated only by lightness, lighter meaning more likely to be
something the user chose to keep. The map should read as one material with
denser and lighter regions, not as a chart with six competing colours. A
categorical rainbow would also imply the categories matter more than the sizes,
which is backwards: the sizes are the finding.

Anything under a cache directory is a cache whatever its extension — a `.png`
inside `Caches` is not a photo anyone chose to keep.

### Two things that are not files get their own treatment

- **`(smaller items)`** aggregates are hatched. They are a rollup of hundreds
  of things, and at a glance they must never read as one large file.
- **Pruned directories** get a dashed edge: real contents exist that are not in
  this tree, and the dashed boundary says it is one you can cross.

### Zoom is a re-scan, so the trail is the only history

P3 established that drilling in is just `startScan()` on that subdirectory —
no retained full tree, no new machinery. The consequence is that nothing in the
data records how the user got where they are, so the breadcrumb is not a
convenience: it is the only record of the path taken.

### The hover readout outlives the pointer

Reveal sits outside the canvas. Clearing the readout on `mouseleave` would
erase the subject on the way to the verb — the user would arrive at the button
with nothing selected. So the highlight clears on exit and the readout does not.


## P5 — ELAPSED runs on a wall clock, not on scan progress (2026-08-24)

**Decision:** the ELAPSED figure is driven by its own `setInterval` against
`Date.now()`, deliberately independent of `scan:progress` events.

**Why it can't be derived from progress.** The obvious implementation — update
the clock when a progress message arrives — fails in exactly the situation the
clock exists for. Progress messages are emitted from inside the directory walk,
so when the walk blocks (a slow network volume, a directory with a pathological
number of entries, a stalled device) the messages stop. A progress-driven clock
would freeze at that instant. The reading would be indistinguishable from a
crashed scanner, and it would freeze *precisely* at the moment the user most
needs to know that time is still passing.

**What the pair says together.** ELAPSED and the currently-reading path are one
instrument, not two figures:

| ELAPSED | path | reads as |
| --- | --- | --- |
| rising | moving | working normally |
| rising | frozen | slow — stuck on one directory, still alive |
| frozen | frozen | the renderer itself is wedged |

Only an independent clock can produce the middle row, which is the row that
prevents someone force-quitting a scan that was going to finish.

**Consequence.** ELAPSED measures wall-clock time from the moment the scan was
started, including time spent blocked — which is the honest number. It is not
"time spent scanning" and must never be recalculated from the sum of progress
intervals.

## P5 — The block field counts; it does not estimate (2026-08-24)

**Decision:** no progress percentage anywhere in the scan UI. The block field
is a *counter at a stated scale*: each block is a fixed quantum of files
(starting at 25), blocks fill and stay filled, and when the grid would fill
completely the quantum doubles and the field redraws at half density.

**Why the percentage had to go.** A directory walk cannot know its total until
it has finished — that is the whole shape of the problem. Any denominator is
therefore invented, and the old bar exposed the invention: it wrapped at 100%
and kept going. For a tool whose pitch is "read exactly what it does before you
let it touch your disk", a number that resets to zero and starts again is worse
than no number.

**Why doubling, not a bigger grid or a moving scale.** Doubling keeps the two
properties that make the field readable:

- *It never wraps.* At a rescale the field halves — full to half full — so it
  never returns to empty. The rescale is a coarsening, never a reset. Only the
  quantum grows; it is never lowered, so a block that has been earned is never
  taken back.
- *It never claims a total.* The field says "at least this many files, at this
  scale", and the label beside it (`1 BLOCK = 50 FILES`) states the scale, so
  the reader can always recover the count.

Doubling is applied in a `while` loop, not once: progress is batched every
200ms, and a fast volume can cross several scales in a single message. A resize
re-derives the scale for the same reason — a narrower window holds fewer blocks.

**The field is deliberately never completely full.** The rescale triggers at
`filled >= capacity`, so `filled < capacity` is an invariant rather than a
near-miss. "Full" is a state that exists only long enough to become the next
scale.

**In-flight progress from a cancelled or superseded scan is dropped in main**
(`scanner.js`), not filtered in the renderer. Starting a scan cancels the
previous one, whose worker may still have messages queued; delivering them
would walk the counts backwards. The rule is that only the scan that owns the
readout is heard.

## P5 — Skipped folders are counted apart, and shown while scanning (2026-08-24)

**Decision:** the worker's single `errors` counter is split into `dirsSkipped`
(a directory that could not be opened at all) and `entriesSkipped` (one entry
that could not be stat'd). `dirsSkipped` is surfaced as SKIPPED in the live
readout *and* in the results summary.

**Why they are not one number.** They describe holes of wildly different size.
A skipped directory removes an entire subtree from the totals — on `~/Library`
that is 143 subtrees, and the reported 93 GB is 93 GB *of what could be read*.
A failed `lstat` on one entry loses one entry. Adding them together produces a
number that means nothing in particular.

**Why it appears during the scan, not only in results.** A scan that quietly
omits 143 directories and only mentions it at the end is the same failure as
the fabricated percentage, inverted: the percentage asserted knowledge it did
not have, and a hidden skip count withholds knowledge it does have. The live
SKIPPED figure means the totals are never watched under a false impression of
completeness.

**It is stated as normal, not as a failure.** Skipped folders are the expected
state of an unprivileged app on macOS. The note names the number, says what is
missing because of it, and then says why it is ordinary and where Full Disk
Access lives — in body text, in body colour, with no alert styling. Compare
CLAUDE.md: no threat counts, no urgency language.

## P5 — A failed scan resolves; it does not reject (2026-08-24)

**Decision:** `scan:start` resolves with `{ ok: false, code, detail }` when a
scan fails. Only a malformed *argument* still throws.

**Why not a rejection.** The renderer has to name the failure — "this folder is
closed to DiskWatch" and "that folder isn't there any more" need different copy
and different actions — and naming it requires the error code. A rejection
cannot carry one: Electron rewrites a rejected handler's error into
`Error invoking remote method 'scan:start': ...` and drops custom properties on
the way, so `err.code` is gone by the time it reaches the renderer. Recovering
it would mean regex-matching a message string we do not control — exactly the
vagueness the error states exist to remove.

**The distinction being drawn** is between an *outcome* and a *bug*. An
unreadable folder is a normal, expected result of asking to read a disk, and it
resolves. A caller passing a non-string path is a programmer error and still
rejects, so P2's validation contract is unchanged.

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
