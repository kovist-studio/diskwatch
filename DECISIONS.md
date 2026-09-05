# Decisions

A short log of non-obvious design decisions and the reasoning behind them.
Newest first.

## V2 — Four statuses, and why none of them is "On" (2026-09-05)

**Decision:** the Security tab renders each check's status as one of four
phrases — **Nothing to change**, **Worth a look**, **Couldn't check**,
**Doesn't apply** — derived from `status` alone. The list is never sorted by
status and never totalled.

**"On" and "Off" were the obvious pair and they are wrong.** Not every check is
a switch. One of the six macOS checks is a reading rather than a setting —
drive health, which comes back `SMART status: Verified` or `Failing` — and the
Windows audit has the same shape in `disks`. "Drive health (SMART) — On" is
meaningless, and "Off" beside a drive that reports itself failing is flatly
false. The platform modules' own vocabulary ("pass — the protection is on") is
a switch vocabulary,
and it does not survive contact with the checks that are not switches. A status
column may not state something false about any of its rows, and one in six is
not a rounding error.

**"Pass" and "Fail" were worse.** That is the scoreboard vocabulary, and the
word FAIL in a column beside disk encryption is precisely the register this app
exists not to use. It also reintroduces the grade that `security/index.js`
refuses to compute, one row at a time.

**Others considered and rejected.** *Yes/No* is never false — it answers the
label read as a question — but a bare "Yes" at the end of a row is cryptic
without the question mark to anchor it. *"As it should be" / "Not as it should
be"* is true of switches and readings alike, but the two are nearly identical
at a glance, which defeats the only job the column has: being scannable down
the left-to-right sweep. The four chosen are each true of a switch and of a
reading, and no two look alike.

**Unknown is not a failure, and one word cannot carry that.** "Couldn't check"
says what happened, but the point is easy to skim past, so every unknown row
also carries a standing line: *this is not something found, it is something
DiskWatch could not read, so it says nothing either way*. It is attached by
status rather than by check id, so a new check that comes back unknown inherits
it without anyone remembering to add it.

**Nothing is ranked and nothing is added up.** Rows appear in the order the
audit returned them, which is the order the checks were declared. Sorting the
failures to the top is a scoreboard with the numbers filed off, and there is no
scale these six answers share that a total could be computed on — the list says
so in one line, so an order that looks arbitrary is explained rather than left
to be puzzled over. `test/security-ui.test.js` fails the build on `.sort`,
`.reduce` and `.filter` anywhere in the view.

**No red.** The palette has an `--alert` token and it stays unused in this view,
as it is in the Check tab. A failing check is amber — the same signal colour as
a hovered treemap rectangle and a caution row in cleanup. The strongest thing
this app has to report is that a drive says it is failing, and the row says
that in words, at body size.

The status word was also dropped from the `microlabel` treatment used elsewhere
for section headings. Uppercase with letter-spacing turned five identical
passing rows into a column of badges shouting the same thing, which is a
different way of being loud.

## V2 — The renderer names a check, never a destination (2026-09-05)

**Decision:** `security:openFix` takes a **check id**. The main process
resolves the settings URL from the audit that actually ran, and refuses three
things rather than opening them: an id no audit produced, an id whose check has
no settings pane, and a URL outside `x-apple.systempreferences:`,
`ms-settings:` and `windowsdefender:`. http and https are absent on purpose —
nothing in this app opens a web page.

**This is the same rule for the third time.** Cleanup takes tokens, not paths
(*V3 — The renderer is never told a path*). The fetcher takes a source id, not
a URL, and `test/checker.test.js` has a case named "refresh has no way to be
handed a URL". Now the settings link takes a check id, not a URL. In all three
the renderer names a thing and the main process resolves what that thing means
from a list it already holds.

**Why the shape rather than validation.** Validating a URL the renderer sends
means resolving it and then denying it, and it means keeping the allowlist on
both sides where the two can drift. With ids there is nothing to validate: an
unknown id matches nothing. `/etc/passwd` is not refused as a dangerous path,
it is refused for not being a token; `https://evil.example` is not refused as a
dangerous URL, it is refused for not being a check id. The dangerous case never
reaches code that would have to reason about it.

**Why it matters more here than elsewhere.** `shell.openExternal` is the one
call in this app that hands a string to the operating system and asks it to act
on it. It is worth exactly one place in the codebase, with the destination
resolved rather than received.

**The pane registry is refilled by every audit and cleared first**, so a
destination cannot outlive the audit that named it — the same reason
`remove.js` resets its ledger at the start of every survey. A check whose
`fixUrl` is null never puts an entry there at all, which is how SIP and drive
health are prevented from opening a pane rather than merely not offered one:
SIP is set from macOS Recovery and drive health is read in Disk Utility, and a
link to a pane without the switch sends someone hunting for a control that is
not there.

**The renderer does still receive `fixUrl`, and that is not a hole.** It reads
it for two things — whether a row gets a link at all, and which app to name on
the button — and never sends it anywhere. The property that matters is what the
main process *accepts*, not what the renderer *holds*: the URL could be edited
in the renderer to anything at all and the only effect would be a button with
the wrong label on it, because the id is what crosses. This is the same
distinction as *V3*: the guarantee is a property of the channel, not a
convention kept by whoever writes the next view.

Verified against this machine by driving the real handler: every check with a
pane opens exactly its own URL and nothing else, every check without one opens
nothing, and the FileVault pane identifier does open Privacy & Security on
macOS 26 — a wrong identifier fails silently, which is the worst way for this
to be wrong.

## V4 — The public suffix bug was harmless by luck, not by design (2026-08-28)

**Decision:** Mozilla's Public Suffix List is bundled verbatim as
`src/main/checker/public_suffix_list.dat`, and blocklist lookups walk a
subdomain's ancestors down to the **registrable domain** and stop there.

**What was wrong.** A blocklist may list a parent domain and mean everything
beneath it, so `login.evil.example` has to check `evil.example` too. The first
implementation walked ancestors down to two labels, because two labels is what
a domain looks like. It is not. `barclays.co.uk` is three, and that code
queried **`co.uk`** against the blocklists.

**Why nothing broke.** No blocklist currently contains a public suffix. That is
the only reason this never produced a wrong answer — and it is a fact about
today's data, not a property of the code. Any of the three sources could add
one tomorrow, by mistake or by an over-broad rule, and the app would report
that every domain under `.co.uk` was listed. The design offered no defence; it
was relying on other people's data staying well-formed.

There is a second cost that was being paid the whole time. Each ancestor query
is a filter lookup with a 0.1% false-positive rate, and a public suffix is a
query that can only ever return a wrong yes — there is no right yes available.
The bug was quietly adding false-positive surface in exchange for nothing.

**Licence: MPL 2.0, and it is clean here.** The list's own header states it.
MPL 2.0 is **file-level** copyleft, not project-level: section 3.3 permits
distributing a Larger Work under terms of your choice provided the Covered
Software keeps its licence. So the `.dat` file stays MPL inside an otherwise
MIT application, and nothing conflicts.

That is a genuinely different answer from the Bloom filter case, and the
difference is worth understanding rather than pattern-matching. There, GPL-3.0
and CC BY-SA attached to a **derived artifact** we would have distributed, and
two copyleft licences on one artifact is a real conflict. Here we distribute
the file **unmodified**, so no derivative exists and only that one file carries
MPL.

**Which is why it must stay verbatim.** Reformatting the list, minifying it, or
converting it to JSON would each be a Modification under MPL 2.0 §1.10, and the
result would have to be licensed MPL in turn. Parsing it at runtime costs a few
milliseconds once and keeps the question from arising. `suffix.json` records
that alongside the provenance, and a test fails the build if the licence
notice, the version stamp, or the file's structure is stripped.

**The awkward cases are the point**, and all are tested: `co.uk` and `com.au`
are multi-label suffixes; `github.io` is a suffix owned by a company, so
`a.b.github.io` is registrable at `b.github.io`; `*.ck` makes every label under
it a suffix; and `!www.ck` carves one back out, because exceptions beat
wildcards. A bare suffix returns `null` for its registrable domain, since
nobody owns `co.uk`.

**The list goes stale.** Registries add and remove suffixes continuously.
Staleness degrades safely — a newly-created suffix is treated as a registrable
domain, which is the old behaviour and not dangerous — and `npm run sync:psl`
refreshes it from the one URL the maintainers support.

## V4 — RDAP widens the network allowlist, and heuristics never decide (2026-08-28)

**Two decisions, recorded together because the second is what makes the first
acceptable.**

**1. RDAP endpoints cannot all be written down, and that is a real widening.**
`sources.json` lists every blocklist URL, and `fetch.js` has no code path that
can request anything else. RDAP cannot work that way: there is one server per
registry, several hundred of them, and the mapping changes as registries move.

So `rdap.json` writes down the **bootstrap** endpoint — IANA's published
registry-to-server map — and every server is discovered from it. The narrower
guarantees survive: https only, a redirect that leaves https is refused, there
is a timeout, and a discovered http endpoint is skipped rather than used. What
does not survive is "you can read the file and know every host this app will
contact". You can read it and know the one host it *starts* from.

That is written here rather than glossed, because a future reader comparing
`sources.json` with `rdap.json` will notice they are not the same posture, and
should find the reason rather than assume it was carelessness.

**2. A heuristic that renders a verdict is how a false accusation ships.**
Each of the three signals fires on legitimate domains, and not rarely:

- **paypay.com** is a real Japanese payment company, one edit from paypal.com.
  The brand check flags it. It is correct to flag it and wrong to conclude
  anything from it alone.
- **Every domain was registered recently once.** A three-day-old domain is the
  strongest single signal available and is still the normal state of every new
  business on the internet.
- **президент.рф** is a Russian government domain full of characters that look
  like Latin ones. It is not flagged, because the signal is script *mixing*
  rather than the presence of a non-Latin script — treating any non-Latin
  script as suspicious would flag most of the internet outside the anglosphere.

So `heuristics.js` returns observations with their evidence and stops. There is
no `score`, no `risk`, no `verdict`, no `malicious` field, and the word "scam"
appears nowhere in a result. A test asserts all of that, and a second test
fails the build if any heuristic module assigns a verdict-shaped field. Weighing
signals is a presentation decision, made where the user's words are chosen.

**"Unknown" is kept distinct from "absent" throughout.** When RDAP cannot
answer, the age signal reports `known: false` rather than `present: false`, and
the count of unknowns is returned separately. Collapsing them would let a
domain whose age could not be checked read as a domain that had been checked
and found old — which is the one way this design could quietly flatter
something dangerous.

**A bug worth remembering.** `normalise()` validated against an ASCII-only
pattern, so it returned null for every internationalised domain — meaning the
one input the homograph check exists to examine could never reach it. It failed
silently, as a domain that simply looked unparseable. Domains are now
canonicalised to punycode before validation, which is also the form the
blocklists store, so a lookup and a heuristic now agree on what a domain is.
The second half of the same bug: an `[a-z]{2,63}` TLD pattern rejects
`xn--p1ai` (.рф), because punycode TLDs contain digits.

## V4 — The Bloom filter is built on the user's machine, never shipped (2026-08-28)

**Constraint, not a preference:** DiskWatch must never distribute a Bloom filter
— or any other structure — derived from the blocklists. Each installation
fetches the lists itself and builds its own filter locally. Pre-building one in
CI and shipping it in the installer would be faster to start up and is
**forbidden**.

**The reason is licensing, and it is not negotiable by optimisation.** Two of
the three sources are copyleft:

| Source | Licence | What it demands of a derivative |
|---|---|---|
| PhishDestroy | MIT | attribution |
| jarelllama/Scam-Blocklist | **GPL-3.0** | derivative works distributed must be GPL-3.0 |
| CyberHost | **CC BY-SA 4.0** | derivative works distributed must be CC BY-SA 4.0 |

A Bloom filter computed from those lists is a derivative work of both. Shipping
one would oblige us to license that artifact under GPL-3.0 *and* CC BY-SA 4.0
simultaneously — two copyleft licences with different terms, inside an
otherwise MIT application. That is not a licensing inconvenience to work
around; it is a genuine conflict with no clean resolution.

**Fetching sidesteps it completely.** Copyleft attaches on *distribution*. When
each user's own machine downloads the lists and builds its own filter, we
distribute nothing derived from them — we distribute MIT code that knows some
URLs. The user's local copy is their own use, which every one of these licences
permits.

**To whoever is tempted later:** pre-building the filter is an obvious
optimisation. It removes a first-run download, it makes startup deterministic,
and it would let the app work offline immediately. Those are real benefits and
they do not matter, because the artifact cannot legally be shipped. If you find
yourself adding a build step that reads `sources.json` and emits a filter into
`dist/`, that is this decision being reversed by accident. The correct place to
spend effort is making the first-run fetch pleasant, not eliminating it.

**Phishing Army was dropped for the neighbouring reason.** It is licensed
CC BY-**NC** 4.0 — NonCommercial. DiskWatch is MIT, which permits commercial use
downstream and cannot be revoked. Shipping code that directs a commercial user
to fetch and use an NC-licensed feed walks them into violating its terms, and
both the OSI and the FSF treat NC as non-free for this reason. It was the
largest single source considered, at 156,735 entries, and it is out. Three
sources we are clearly entitled to use beat four we are not.

The remaining three were verified live over HTTPS with no redirects before
being written down: PhishDestroy 3.5 MB / 120,717 entries, jarelllama 9.4 MB /
468,729 entries, CyberHost 4.8 MB / 75,220 entries.

## v1.0.1 — `identity: null` does not mean "ship unsigned" (2026-08-27)

**Decision:** `mac.identity` is `"-"`, codesign's ad-hoc identity. It was
`null`, and v1.0.0 shipped a macOS app that Gatekeeper reported as **damaged**.

**The distinction the whole bug turns on.** `identity: null` reads like "ship
without a signature". It does not mean that. It means *skip the signing step
entirely* — and skipping is not the same as producing an unsigned app, because
the app is not unsigned to begin with. Electron's own binary arrives carrying
an ad-hoc signature applied by the linker, identifying it as `Electron`.
electron-builder then assembles a bundle around that binary — renames it, adds
the asar, adds resources — and, told to skip signing, leaves the linker's
signature in place over a bundle it no longer describes.

The result is not a missing signature. It is a **present signature that claims
resources which do not match**:

```
code has no resources but signature indicates they must be present
```

**And that is why the message was "damaged".** A *missing* signature means
untrusted: macOS says the developer cannot be verified, and Privacy & Security
offers Open Anyway. A *broken* signature means tampered: the bytes do not match
what the signature attests, which is indistinguishable from someone having
modified the app after it was signed. macOS reports that as
*"DiskWatch is damaged and can't be opened. You should eject the disk image."*
and Sequoia offers no Open Anyway, because there is nothing safe to offer.

So the worst-sounding message in the entire install flow was attached to the
one thing that was genuinely our fault, and its advice — delete it — was the
only advice a user could reasonably follow. Every download was told the app was
corrupt.

**The check that tells the two states apart**, and the reason to run it rather
than eyeball a config file:

```
v1.0.0:  CodeDirectory ... flags=0x20002(adhoc,linker-signed)   Identifier=Electron
         codesign --verify --deep --strict -> FAILS

v1.0.1:  CodeDirectory ... flags=0x2(adhoc)                     Identifier=app.kovist.diskwatch
         codesign --verify --deep --strict -> valid on disk, satisfies its Designated Requirement
         spctl -a -vv                      -> rejected
```

`linker-signed` in the flags is the fingerprint of the broken state. Its absence
is the fingerprint of the fixed one. `spctl` returning a plain **rejected** is
the goal, not a failure: it means Gatekeeper can assess the app and declines to
trust it, which is the honest status of software with no Developer ID. An
*error* from `spctl` means it could not assess the app at all, which is what
v1.0.0 produced.

Ad-hoc signing costs nothing that `null` was protecting. There is still no
certificate, no key material, no Apple account, and no dependence on whose
keychain the build ran against — which was the entire reason `null` was chosen.

**How it was found is the part worth keeping.** Not by review, and not by any
test. Every check this project runs — the 229-test suite, `npm start`, the
`--dev` runs, the CI build itself — executes **from source**. None of them
package an app bundle, so none of them produce a signature, so the defect is
not merely unnoticed by them: it is *structurally invisible* to them. There is
no assertion that could have been added to the suite to catch it, because the
artifact that carries the bug is never built in that path.

It took downloading the published `.dmg`, mounting it, and inspecting the app
the way a user's Mac does.

That is exactly the shape of the trash-and-restore loop recorded earlier: the
suite injects a fake trasher and therefore cannot prove that anything is
recoverable, so the real `shell.trashItem` had to be run against a real disk
before the claim meant anything. Two different subsystems, same category of
gap — **the last mile between what the tests execute and what the user
receives, which by construction no test in that suite can cross.**

The general form: when a defect can only exist in an artifact your test path
never produces, no amount of testing rigour will find it. The only remedy is to
obtain the artifact the way the user does and put it through what the user's
machine puts it through.

**Worth doing next:** the three verification commands above are cheap and
deterministic, and CI has the built `.app` in hand immediately after packaging.
A `codesign --verify --deep --strict` step in the macOS build job would turn
this from something caught by a user report into something that fails the
release. It is not yet wired up.

## v1.0.0 — `gh` needs a repository, and two confident guesses were wrong (2026-08-27)

**The bug:** the release job failed with

```
failed to run git: fatal: not a git repository (or any of the parent directories): .git
```

`gh` infers which repository to act on from the git remote of its working
directory. The release job deliberately does **not** check out the source — it
only needs the built artifacts — so there was no `.git` anywhere, and `gh
release create` failed before it made a single API call.

**The fix** is `GH_REPO: ${{ github.repository }}` alongside `GH_TOKEN`, set at
the job level so both `gh` steps inherit it and cannot drift apart. Adding
`actions/checkout` would also have worked, at the cost of cloning the entire
source tree purely to publish three files. Naming the repository is cheaper and
says what is actually meant.

**Two plausible causes were inferred, and both were wrong.**

The first was that the repository's default workflow permissions were
read-only, capping the `permissions: contents: write` the workflow requests.
This was entirely plausible: the org was hours old, new orgs default to
read-only, and the failing step was the first one that writes. Acting on it
cost a real settings change at both org and repo level — and changed nothing.
The run failed again, identically.

The second, never tested, was that `--generate-notes` was returning 422 with no
previous release to diff against, or that pushing `v1.0.0` three times had left
a stale ref association. Also plausible. Also wrong.

**The error was in the log the whole time.** It was unreadable only because
`gh` was not installed and the API log endpoint returns 403 unauthenticated.
Installing it and reading the step output took one command and produced the
answer immediately — after two rounds of inference, one of which sent the user
into GitHub's settings to fix a problem that did not exist.

The failure shape was even actively misleading in a way worth noticing: a
permissions error and a missing-repository error both surface as a write step
exiting 1, and the second is far less familiar. Plausibility ranked the wrong
cause first, and plausibility is not evidence.

This is the same lesson as the stdout premise recorded under the logging policy
— *when a mechanism is checkable, check it rather than reasoning from what
sounds likely* — except that here the reasoning was mine rather than inherited,
and it cost more. Two entries in one project is enough to call it a pattern:
**the cost of one command to observe is almost always lower than the cost of a
confident guess.**

**Afterwards the permission change was reverted to read-only and verified, not
assumed.** The release job was re-run under the read-only default and passed,
including `gh release upload --clobber`, which requires `contents: write`. So a
workflow's own `permissions:` block does elevate above a restrictive repository
default — the thing the first guess assumed was impossible. That is now an
observed fact about this repository rather than a reading of the docs.

*(The preceding failure in the same release was unrelated and simpler: Windows
runners default to `core.autocrlf=true`, so the tracked vendored copy was
checked out as CRLF while npm's tarball copy stayed LF, and the byte-for-byte
`verify:vendor` check failed on Windows while passing on macOS. Fixed with a
`.gitattributes` marking `src/renderer/vendor/** -text`. That one was diagnosed
by mechanism and the diagnosis held — which is presumably why the same approach
was trusted twice more than it deserved.)*

## The appId is permanent from the first release (2026-08-27)

**Decision:** `appId` is `app.kovist.diskwatch` — reverse-DNS of `kovist.app`, a
domain that is actually owned. It was `com.diskwatch.app`, which reversed a
domain nobody holds. **It must not change again after the first public release.**

**Why it is not just a string.** On macOS the appId is the bundle identifier,
and the bundle identifier is the key TCC files permissions under. When someone
grants DiskWatch Full Disk Access — or Desktop, Documents, Downloads, or
Removable Volumes, all four of which this app asks for by walking them — the
grant is recorded against that identifier. Change it and the OS sees a program
it has never met: every permission silently reverts, scans start failing on
folders that worked yesterday, and the fix is for the user to go back into
System Settings and re-grant by hand. Windows has a milder version of the same
problem, where the appId keys the installer's upgrade path.

That failure is also close to invisible from this side. The build succeeds, the
app launches, and the damage shows up only on machines that had granted
something — which is every existing user and no test machine.

**So the window for getting it right is now**, before anything is published,
which is why it moved from a domain nobody owns to one that is held. After the
first release the cost of a rename is paid by users, one System Settings dialog
at a time, and no cosmetic improvement is worth that.

If it ever genuinely has to change, the honest path is a migration note in the
release that tells people their permissions will need re-granting — not a quiet
bump.

## OPEN — In-app updates are unresolved, not decided against (2026-08-27)

**This is not a decision.** It is recorded here because the question has not
been asked yet and will be, and because its absence currently looks like an
answer. Nothing below has been agreed.

**The state of things:** `electron-updater` appears in PLAN.md §3 and was never
installed. It is not a dependency, `publish: null` stops electron-builder
publishing anything itself, and CI builds with `--publish never` and uploads
through `gh release create`. So the app has no in-app updater — by omission,
not by argument. No one weighed it and declined it.

**The tension worth naming before someone does weigh it.** An auto-updater
writes to the application bundle without being asked, which sits oddly in an app
whose entire design is that nothing happens to your disk unless you chose it and
can undo it. The whole of V3 went into making one delete provable and
reversible; shipping a component that silently replaces the app's own binary is
a different kind of write, aimed at a different target, with none of those gates
in front of it.

That is not an argument against having updates. Users on an old build of a tool
that touches their filesystem is its own risk, and the §9 channels (Homebrew
Cask, winget, Scoop) are updates too — they just put the person in the loop.
The question is which of those this app should have, and it deserves the same
treatment the Trash carve-out got: cost it properly, in the open, before writing
it down as settled.

Whoever picks this up: the honest options are (a) no in-app updater, notify only,
(b) a check that tells the person a new version exists and links to it, or (c) a
real updater. They are meaningfully different products and only (a) is currently
true.

## V3 — The renderer is never told a path (2026-08-27)

**Decision:** a survey tells the renderer what it needs to draw a list — label,
description, size, item count, risk, and an opaque token per item — and nothing
else. No path crosses. The measured property, taken by driving the real IPC
handler against this machine's disk:

```
8 targets, 1,208 items, 20.5 GB surveyed
survey payload contains a user path: false
```

**This is stronger than "the UI does not display paths".** That would be a
convention, kept by whoever writes the next view. This is a property of the
data: the renderer cannot name a place on disk because it was never told one.
`remove()` accepts tokens and has no overload taking a path or a target id, and
the IPC boundary rejects anything that is not a v4 UUID before it reaches a
module that would have to reason about what it is — `/etc/passwd` is refused as
a *shape* error, not resolved and then denied.

The two ends reinforce each other. Tokens exist so provenance cannot be forged;
because tokens carry provenance, the payload does not need paths to be useful;
because the payload has no paths, a compromised renderer has nothing to leak
and nothing to name. Each property makes the next one cheap.

Paths appear in exactly one place: the *result* of a removal, where the skipped
list says which item was left alone and why. That is after the fact, about work
the person just asked for, and it is rendered with `textContent` and never held.

**The one deliberate exception, and why it is not a hole.** Per-file targets get
a disclosure that lists **basenames and dates** — never paths — on explicit
request, through its own channel. A filename is what someone recognises their
own file by; the directory above it tells them nothing they do not know and is
the part worth not sending. The survey property is unchanged: the survey still
carries nothing. This is a separate, user-initiated act.

It reads the ledger the survey already filled rather than walking again. That is
1ms instead of seconds, but the real reason is correctness: a fresh walk could
return a different set from the one the tokens were minted for, and then the
list a person read would not be the list they agreed to.

## V3 — Downloads are not a cache, so one checkbox was wrong (2026-08-27)

**Decision:** a target whose items are individual files the person chose to put
there cannot be ticked until its list has been opened and looked at. The
checkbox ships disabled; opening the disclosure is what enables it.

**What made this visible was a number, not a review.** The first real survey of
this machine returned `downloads-old-macos` as **1,040 items, 8.2 GB** — behind
a single checkbox, in a row that looked exactly like the seven cache rows above
it. Every other row in the list is regenerable: the app that made those files
makes them again, and the cost of being wrong is a slower launch. Downloads are
the opposite. Nothing re-downloads them for you, and the row said so in its own
description while still offering the same one-click affordance as a cache.

That is the same argument that gave `ios-backups` an `expand` contract, only
with a different safety net. iOS backups are irreplaceable and have none, so
that entry does not ship at all until per-device selection exists
(`ifUnsupported: omit`). Downloads go to the Trash and can be dragged back out,
so the proportionate answer is a gate rather than a withdrawal — but "recoverable"
is not "reversible without noticing", and 1,040 files is well past the point
where a person can hold what they just agreed to in their head.

**The rule keys off the unit, not the id.** A target is gated when its items are
individual files (`unit === 'file'`, which is what a `minAgeDays` entry produces)
rather than one rebuildable directory. Nobody has to remember to add the next
Downloads-shaped target to a list — the shape carries the rule. Verified both
ways on this machine: `downloads-old-macos` gates, `pip-cache-macos` does not.

**What is deliberately NOT claimed.** This is the minimum, not the end state.
Per-file selection is still the right answer for files someone chose to keep,
and the data is already shaped for it: every disclosure row carries its own
token, so adding a checkbox per file needs no new channel and no new IPC
contract. What is shipped is the gate; the argument for going further is
recorded here so the next person does not have to rediscover it.

## V3 — What the app writes about you, and the rule that keeps it that way (2026-08-27)

**Decision:** in a production build, nothing containing a **user path** may be
written to disk or to stdout. A user path is one under the user's home
directory or one the user selected — a scan root, a survey result, a cleanup
item. System binaries and OS locations (`/usr/sbin/spctl`, `C:\Windows\System32`)
stay loggable, because they identify the machine's software, not its owner. The
`--dev` flag is the only exception, hung on the `isDev` gate that already exists
at `src/main/index.js:9` rather than on a new mechanism.

**This is belt-and-braces, not a leak being closed.** The inventory was taken
before the rule was written, and it came back clean. `src/` contains exactly
five `console.*` calls: four in `src/main/security/cli.js`, which is the
`npm run audit` dev CLI and never ships, and one in `src/main/ipc.js` that logs
`formatAudit(audit)` from the main process. *(Amended 2026-09-05: that fifth
call is gone. It existed because the audit had no UI and the console was its
readout; the Security tab is now that readout. Four remain, all in the dev
CLI.)* Running the audit confirms its
output is prose about FileVault, SIP, Gatekeeper, the firewall and SMART, with
no home directory and no volume paths in it. That line is also unreachable
today: nothing in the renderer calls `security.audit()` yet. `crashReporter`
appears nowhere in the repo, and there is no `Crashpad/` directory and no
DiagnosticReports entry to show otherwise. Nothing in `src/` calls `getPath`,
`writeFile`, `mkdir`, or `createWriteStream` at all.

What Chromium writes on its own is a longer list — 18 entries under
`~/Library/Application Support/DiskWatch/`, none of them ours: `Cache`,
`Code Cache`, `GPUCache`, `Local Storage`, `Session Storage`, `Preferences`,
`DIPS`, `Trust Tokens` and the rest. The question worth asking of that tree is
not what it is but what is in it, so: `grep -rl` for the home directory across
all of it returns four files, and all four are leveldb's own `LOG`, recording
the path of the leveldb directory itself. No scanned path is persisted
anywhere. `Local Storage` holds only `devtools://devtools` keys left by
`--dev` runs.

So the rule costs nothing today. That is the argument for adopting it now
rather than later: a policy written while the code already complies is a
description, and one written after a violation is a negotiation.

**The premise this started from was mine to test, and it was wrong.** The
audit was requested on the stated understanding that on macOS a main-process
`stdout` lands in the unified log — which would have made `ipc.js` an active
disclosure rather than a latent one. That understanding was the user's, and
rather than accept or argue it, it got tested: a minimal `.app` bundle,
launched through LaunchServices with `open` rather than from a terminal,
writing a marker to `stdout`, a second marker to `stderr`, and a witness file
to prove it ran. On this machine (Darwin 25.6.0) the witness file appeared and
`log show` contained neither marker. Both streams were discarded.

The rule is kept anyway, because it is still correct on Windows, still correct
whenever anyone launches from a terminal, and cheap. But it is now justified as
defence in depth instead of as plugging a hole, and that distinction is the
whole reason this paragraph exists. A rule resting on a premise that does not
hold is a rule that gets repealed the first time someone checks. Recording the
failed premise alongside the surviving rule means the next reader re-derives
the same conclusion instead of discovering the gap and assuming the rule was
careless.

**The failure shape is designed now, while nothing is broken.** The cost of the
rule is diagnosing "the scan fails on *my* Downloads folder" without being told
which folder. What recovers nearly all of it is reporting the *shape* of a
failure rather than its name:

```
{ code, depth, index, targetId }
```

`code` is the errno or app code (`EACCES`, `ELOOP`, `ENOENT`). `depth` is
directory levels below the scan root, root being 0. `index` is the ordinal of
the entry within its directory as `readdir` returned it. `targetId` is the
`targets.json` id, which is already public data in a shipped allowlist. None of
the four is user data: three are structural facts about a walk and the fourth
is a constant we wrote.

Those four reconstruct a bug. "`EACCES` at depth 4, entry 312" is reproducible
by anyone holding the same root, and the root is the one thing a person can
always supply themselves in a bug report. That is the principle the shape
encodes: **the user may volunteer a path; the app may never emit one on their
behalf.** This is written down before the first bug report rather than after,
because the moment a real user is stuck is exactly the moment "just log the
path once, we will take it out later" wins the argument.

**`deleteAppDataOnUninstall: false` is now a choice, not an inherited default.**
It stays `false`, and the reason is the same rule that governs everything else
here: nothing this product does is irreversible. An NSIS uninstaller deleting
`%APPDATA%\DiskWatch` would be a permanent, unrecoverable directory removal —
it does not go to the Recycle Bin — performed by the installer, where not one
of `remove.js`'s gates applies and where the person is watching a progress bar
rather than a confirmation. Shipping the app's only permanent delete inside its
uninstaller would be an odd place to make an exception to a rule the app
otherwise keeps absolutely.

The cost is a few megabytes of Chromium cache left behind after an uninstall.
That is accepted, and it is small precisely because the inventory above
established there is nothing personal in that tree to leave behind. Had the
grep come back differently, this decision would have gone the other way.

**The `Application Support/Electron/` tree is the dev CLI, not us.** Running
`npm run cleaner:remove` executes `electron tools/cleaner-remove.js`, which
launches Electron pointed at a script rather than at an app directory, so it
takes Electron's *default* app name and gets its own userData tree at
`~/Library/Application Support/Electron/`. It is a byproduct of the harness and
contains nothing of the app's. Deleting it is always safe. It is noted here
because a tree with that name sitting next to `DiskWatch/` invites exactly one
wrong conclusion — that the app writes somewhere it does not — and this record
is cheaper than the investigation.

Related, and harmless: on macOS `DiskWatch/` and `diskwatch/` under Application
Support are the same directory (one inode, case-insensitive APFS), not two.

## V3 — The first code that writes proves its input rather than trusting it (2026-08-26)

**Decision:** `src/main/cleaner/remove.js` is the only code in DiskWatch that
deletes. It calls Electron's `shell.trashItem` — not the `trash` npm package —
and it takes opaque single-use tokens, never paths. Eight gates re-prove each
token against the live filesystem immediately before anything is trashed.

**`npm install trash` was not one dependency.** `trash@10.1.1` pulls **66
transitive packages** into a project that currently has exactly one
(`d3-hierarchy`), is pure ESM in a CommonJS codebase, and bundles two native
binaries — a 726 KB Mach-O and a PE32+ `.exe` — that would each need
`asarUnpack` and, eventually, signing. Electron 43 already ships
`shell.trashItem(path)`, which does the same job on both platforms. Taking it
means `package.json` and `electron-builder.yml` are not touched at all.

It also glob-expands its input by default: `trash(['report[1].pdf'])` does not
mean what it reads like, and a file named `!invoice.zip` becomes a *negation*.
That is a live hazard for a tool pointed at a user's Downloads folder, and it
would have needed `{glob: false}` on every call site forever.

**The bug this module was really written to prevent.** `measure()` applies a
target's `exclude` list to the children it walks. It does not apply it to the
**roots**. Checked against this machine, 2026-08-27:

```
macos-user-caches: ~/Library/Caches/*  →  168 glob roots
3 of them ARE the exclusions: Homebrew, pip, JetBrains
```

The root count is a snapshot, not a constant: it is however many directories
`~/Library/Caches` happens to hold, so it moves with whatever is installed and
will not reproduce exactly. The number that is stable is the **3** — those come
from the target's own `exclude` list, not from the disk.

Because exclusions are applied inside the walk, those three measure as **0
bytes** — they look inert in a survey. But they are still returned as roots, so
the obvious implementation of "trash each root" would have moved
`~/Library/Caches/JetBrains` to the Trash, taking LocalHistory with it: the
uncommitted edit history that the entire V3 allowlist exists to protect. The
exclusion that was correct for *measuring* was silently wrong for *removing*.
An item is now refused if it sits under an exclusion **or contains one**, and
both halves have a test.

**Provenance is a token, not a path.** The requirement was that removal accept
only paths that came from a survey in this session. Tokens are strictly
stronger: a path string can be forged by anything that reaches the IPC boundary,
a `randomUUID` in a process-local ledger cannot. There is deliberately no
overload accepting a path or a target id — a path re-derived from an id is
exactly the "trust me, this is where that lives" move the rule forbids.

But a token is only a receipt for something seen *earlier*, which is why holding
one proves nothing on its own. Before any trash call the entry is re-checked
against a re-read and re-validated `targets.json`, a fresh enumeration of its
target, `dev`/`ino` identity, symlink status, and `realpath` containment on both
the item and its root. The root check is the non-obvious one: swapping a cache
directory for a symlink between plan and remove defeats a per-item check
completely, and there is a test that does exactly that.

**Unanswerable checks refuse.** If `ps`/`tasklist` fails, times out, returns
nothing, or names an app the mapping table has never heard of, the app is
treated as *running* and the item is skipped. This is the same stance the
Windows audit takes with `PermissionDenied` → `unknown`: a check that could not
be run is not a pass. Failing the other way would let a cleanup proceed while
Chrome holds its cache open.

**Per-item failure is the normal case, not an exception.** Removal is
sequential, never `Promise.all` — one rejection must not abandon the rest of the
list — and a failed item is recorded and stepped over. Never forced, never
retried. A locked file on Windows is locked for a reason, and an installer
mid-run keeps its working state in precisely the directories this app offers to
clean.

**Rule 1 is now enforced instead of described.** A test walks every `.js` file
under `src/`, strips comment lines, and fails on `fs.unlink`, `fs.rm`,
`fs.rmdir` or their `*Sync` forms. This is the same principle as the loader
validating `targets.json` and the `expand` contract replacing a `note`: a
requirement that cannot be made to fail is not a requirement. Verified by
inserting an `fsp.rm` call and watching the suite go red.

**The TOCTOU window is accepted, not overlooked.** Every gate resolves a path,
and then `shell.trashItem` resolves it again itself. Between those two
resolutions the filesystem can change, and nothing in this API can make the
check and the move one atomic operation — `trashItem` takes a path, not a file
descriptor, so there is no handle to hold across the gap and no
`*at()`-style call to reach for.

What the gates do is make the window small and the approach expensive: the
`lstat`, the `realpath` on both item and root, and the identity comparison all
happen immediately before the call, so the gap is microseconds rather than the
minutes between a survey and a click. Winning it requires an attacker who
already has write access to the user's own cache directory — that is, code
already running as the user, which could simply delete the files itself and
skip the race entirely. The exposure the race adds over that baseline is
approximately nothing.

It is written down here because "we checked and it is fine" and "we never
thought about it" produce identical-looking code, and the next person to read
`screen()` deserves to know which one this is. If `trashItem` ever grows a
descriptor-based form, this is the reason to adopt it.

**What the tests do not cover, and what does.** `shell.trashItem` is never
executed by `npm test`: the suite runs under plain `node --test` with no
Electron, and the trasher is injected. All 27 tests exercise the gates and none
exercise the real move to the Trash.

`tools/cleaner-remove.js` exists to close exactly that gap before any UI does.
It runs the real module under a real Electron process against a real disk —
`--dry-run` by default, `--confirm` to actually trash — and it is the only way
the production path gets executed at all right now. It is a dev harness, not a
feature: electron-builder's `files` list is an allowlist naming `src/` and
`package.json`, so `tools/` is excluded structurally, and tests assert both
that nothing under `src/` references it and that the allowlist stays an
allowlist.

The first real run confirmed the design against hardware rather than fixtures.
As of 2026-08-27, `~/Library/Caches/*` produced 168 roots, of which **165 were
offered and 3 were refused** — Homebrew, pip, and JetBrains, each
`under-exclusion`. Only that last figure is worth holding onto: the roots and
the offered count are a snapshot of one machine on one day and drift as
software is installed and removed, whereas the 3 refusals are fixed by the
target's `exclude` list and reproduce on any machine where those caches exist.
The JetBrains refusal is the one that matters, and it is now something that has
actually happened rather than something a test asserts about a temp directory.

**The recoverability premise is observed, not assumed.** Rule 1 rests on a claim
that, until now, had never actually been executed: that everything this app
removes can be put back. On 2026-08-27 the harness ran `--confirm` against
`pip-cache-macos` and moved `~/Library/Caches/pip` — one item, the whole
directory, 157,431,205 bytes — to the Trash through the real
`shell.trashItem`. 1 moved, 0 skipped, exit 0. Finder's Put Back then restored
it to its original path with all four entries intact (`http`, `http-v2`,
`selfcheck`, `wheels`) and the directory mtime unchanged, and `~/.Trash/pip`
was gone afterwards — Put Back moved it back rather than copying it. The full
trash-and-restore loop, on real hardware, end to end.

This is worth recording because the automated suite structurally cannot reach
it. Every test injects a fake trasher, so `npm test` proves the gates and never
once proves the premise the gates exist to protect. A green suite is not
evidence that anything is recoverable; it is evidence that nothing got as far
as the delete call. Only a real removal on a real disk produces that evidence,
and until there is a UI, `tools/cleaner-remove.js` is the only thing that
performs one.

## V3 — The permanent-deletion exception lasted one phase (2026-08-26)

**Decision:** `~/.Trash` and `C:\$Recycle.Bin` are dropped. DiskWatch has no
permanent deletion at all, and rule 1 — deletions go through the `trash`
package, and nothing else — is absolute again with no carve-out. Both paths
move to `excluded` with the reasoning, because an entry that is merely absent
gets re-proposed.

**The exception was written carefully, and that was not the problem.** It named
exactly two ids and forbade a third. It required a separate function, so that
no boolean parameter anywhere could select permanence. It required a
confirmation stating the item count and the total size and containing the word
"permanently". It was off by default and unreachable from a select-all. The
loader enforced every clause and the tests proved each one could fail. Every
condition was about making permanent deletion safe *once you have decided to
have it*. Not one of them asked what having it costs everywhere else.

**What removed it was a permission, not a bug.** Reading `~/.Trash` on macOS
needs Full Disk Access — including reading it merely to count the items and
total the bytes that the confirmation was required to display. This app asks
for no permission anywhere else, on purpose and consistently: the security
audit's whole design is that a check which cannot see an answer reports
`unknown` rather than prompting or elevating, and `C:\Windows\Temp` and
`SoftwareDistribution\Download` were excluded rather than build an elevation
story for two cache folders.

So the product would have had exactly one permission prompt, and it would have
been attached to the single irreversible operation in it. The most dangerous
thing in the app asks for the broadest access the OS can grant, in order to do
something the OS already does: Empty Trash is in Finder and in the Dock's
context menu, where people already know to look for it. That trade is backwards
in every direction, and none of it was visible while the entry was still a
block of JSON. It became visible when the entry had to be resolved and measured
against a real disk.

**The Recycle Bin went too, though it cost nothing on its own.** No Windows
permission stands in the way of `SHEmptyRecycleBin`. It went because it existed
only as the Windows half of one exception, and keeping it means keeping the
exception. A rule with one carve-out in it is not the same rule as one without:
the next proposal argues about which side of the line it falls on instead of
being told there is no line to cross. The cost of the general rule is that it
sometimes forbids a specific thing that would have been fine.

**The inversion is the load-bearing part.** The loader's rule used to be
"exactly two entries may carry `emptyTrash`" — a check that would have *failed*
if the count ever dropped to zero. It now reads: zero entries may carry it, and
a first one is a hard error. `emptyTrash` survives in exactly one place,
`FORBIDDEN_METHOD` in the loader, so that re-proposing it fails loudly with the
reason attached rather than falling through the generic unknown-method branch.
That is the same move as the `excluded` list: the record of having decided,
kept where the next person will trip over it.

**The general lesson is about the order of the argument.** The carve-out was
reasoned into CLAUDE.md before the hardware fact was in hand, and it was
reasoned from the inside — conditions on the exception, not conditions on
whether to have one. The cheapest version of this decision would have been to
cost the permission first: what does the *rest* of the product have to give up
to make this one entry possible? That question does not need real hardware to
ask, only to answer.

## V3 — The allowlist is the design, and here is what it caught (2026-08-25)

**Decision:** cleanup only ever touches paths written down in
`src/main/cleaner/targets.json`. No pattern matching on names, no "anything
called cache", no size or age heuristic that discovers targets on its own. The
list is short on purpose and every entry was looked at individually.

**This is expensive, and it earns it.** The obvious alternative — sweep
`~/Library/Caches/*`, since that is what the directory is *for* — was in the
first draft of this list, because it looks unarguable. Checking it against the
development machine turned up this:

```
~/Library/Caches/JetBrains/PyCharmCE2024.1/LocalHistory
```

That is PyCharm's Local History: per-file edit history, the thing a person
reaches for precisely when they did **not** commit. It is user-authored work,
and it is filed under `Caches` because JetBrains chose that directory, not
because the contents are disposable. Nothing about the path says so. A
heuristic reading "it is under Caches, therefore it regenerates" is right about
189 of the 190 entries on that machine and catastrophically wrong about the one
that matters — and the person who loses it is a developer who was relying on it
as their undo.

**The general shape of the failure** is that the filesystem carries no
statement of intent. A directory name is a convention, and conventions are
followed by everyone except the one program that had somewhere else to put
something. No rule derived from the path can tell authored work from derived
work, because the distinction lives in the mind of whoever wrote the file. Only
someone going and looking can tell, which is what an allowlist is: the record
of having looked.

So `~/Library/Caches/*` stayed, but with an `exclude` list and a note saying
what was found and that it was verified rather than assumed. The same field
does load-bearing work elsewhere: pip and Homebrew live inside that directory
and are listed as separate entries, so without excluding them they would be
counted and deleted twice.

**Corollary — the file records what was rejected, and why.** `excluded` is not
commentary. `C:\Windows.old` is the only copy of the previous install;
`C:\Windows\Temp` and `SoftwareDistribution\Download` need administrator
rights this app does not ask for anywhere, and two cache folders do not justify
building an elevation story the security audit deliberately avoided;
`CoreSimulator/Devices` holds every app and file installed on a simulator.
Without the reasons written down, each of these is a plausible-looking
addition that someone re-proposes in six months.

**Corollary — a requirement in a comment is not a requirement.** The iOS backup
entry has to expand to per-device backups showing name and date, and may only
offer a backup when a newer one exists for the same device. That started as
prose in a `note` field, where nothing enforces it. It is now an `expand`
contract with `wholeTargetSelectable: false` and `ifUnsupported: "omit"` — if
the per-device listing cannot be built, the entry does not ship rather than
degrading into a single checkbox over someone's only copy of their phone.

## V2 — The Windows audit classifies on codes, never on messages (2026-08-25)

**Decision:** no check is ever classified by reading an error *message*.
Classification uses only values that are identical in every locale — the
`ErrorCategory` enum name, the `FullyQualifiedErrorId`, and .NET exception type
names. Messages are carried through the envelope for diagnostics and are never
read by a decision.

**Why.** Windows localises error text. The machine this was verified against is
ko-KR, and every message it produced came back in Korean: `액세스가 거부되었습니다`
for access denied, `에 연결된 BitLocker 볼륨이 없습니다` for a missing volume. Matching
English substrings would have misclassified every non-English install in the
world, silently and in the direction of a false all-clear.

**A permission failure is never reported as "not protected".** A
`PermissionDenied` anywhere in a check's errors makes that check `unknown`,
full stop. Non-elevated `Get-BitLockerVolume` is the case that forces this: it
returns **two** errors that contradict each other.

| HRESULT | Meaning | Reads as |
|---|---|---|
| `0x80070490` | `ERROR_NOT_FOUND` — "no BitLocker volume" | an answer |
| `0x80041003` | `WBEM_E_ACCESS_DENIED` — "access is denied" | a refusal |

The first is a *consequence* of the second: the cmdlet could not see the
volumes, so of course it found none. Read alone it looks exactly like a machine
with no BitLocker at all. A machine that refuses to tell us cannot also be
telling us there is nothing there, so the refusal wins. The cascade scans the
whole error array rather than indexing it — `$Error` is newest-first today, and
on the probe machine the *wrong* error was the one sitting at index 0.

**`AntivirusSignatureAge` is a UInt32, and the `[int]` cast was a real bug.**
Defender fills the field with an all-ones sentinel (4294967295) when it has no
update to date from. Observed on PowerShell 5.1, ko-KR:

```
System.Management.Automation.RuntimeException
값 "4294967295"을(를) "System.Int32" 유형으로 변환할 수 없습니다.
오류: "값이 너무 크거나 작아 Int32 형식에 맞지 않습니다."
```

The failure is **non-terminating**, which is what made it invisible: it lands in
`$Error`, the assignment never happens, and `$data` stays null. The `try/catch`
around the body never runs. One unreadable field therefore took down
`AntivirusEnabled` and `RealTimeProtectionEnabled` with it — both perfectly
readable — and degraded the whole check to `unknown`. `[int64]` holds every
UInt32 there is, so the cast cannot fail.

The sentinel is also not an age. Anything past a human lifetime is Defender
saying it does not know, and reports as a **pass** with the age unstated: the
protection state is observed, only one field is missing, and discarding
observed facts because a neighbouring field is absent is the same false-alarm
failure the permission rule exists to prevent.

**What is still modelled rather than observed:** PowerShell's `ConvertTo-Json`
serialises a one-element array as a bare object, so a single-disk machine
produces a different JSON shape from a two-disk one. `toArray` absorbs both,
but the probe machine has two disks — that shape has never come off real
hardware, and the test that covers it says so.

## P6 — Colour encodes age, not category (2026-08-24)

**Decision:** the treemap's lightness ramp encodes file age — recent dark, old
pale — on a continuous scale. The six file-category colours it replaces are
gone, along with their legend.

**Why category failed.** It was the wrong kind of variable for the channel.
Lightness is an *ordered* visual dimension: darker reads as more-of-something.
File categories are **nominal** — media is not "more" than code — so laying
them along a ramp implied a sequence that does not exist, and left the reader
trying to remember an arbitrary swatch-to-meaning mapping. Six steps of a
single hue also had to fit inside one hue's usable lightness range, which
compressed the middle four to the point where they were indistinguishable at
the size most rectangles actually get. Widening the steps was not available:
the palette is deliberately monochromatic, and more hues would have made the
map a chart about categories when the finding is the sizes.

Age has a natural order, so the ramp reads correctly with no key to memorise —
and it answers a question people actually have about a folder.

**The ramp is logarithmic on age, and that is not a detail.** Measured on the
real data, a linear map puts **91% of ~/Library's files in the first tenth of
the ramp**: one fourteen-year-old file sets the pale end and crushes everything
else into a single tone — reproducing, by a different route, exactly the
failure this change was made to fix. On a log scale the same files spread
across 8 of 10 bands. (~/Downloads lands mostly at the pale end, which is
simply true: its median file is 4.6 years old.)

**The legend is a strip of the ramp, generated from the function that paints
the rectangles**, so the key and the map cannot drift apart.

**It carries three dates, not two.** On a log scale the middle of the strip is
nowhere near halfway between the ends — for ~/Library the midpoint is about
three months back while the far end is fourteen years. Labelling the midpoint
says so plainly. Two dates alone would have let a straight gradient imply a
straight timeline, which is the same class of untruth as a fabricated
percentage.

**Where there is no range, there is no ramp.** If nothing carries a timestamp,
or everything carries the same one, every rectangle sits mid-ramp and the
legend hides itself. Painting them all "newest" would assert something the data
does not say.


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

### The summary shrank when the map arrived

P5 gave the four summary figures the 30px `.figure` treatment, and that was
right at the time: the block field was the only other thing on screen, and the
numbers were the finding.

The treemap changed what the finding is. The map is now the answer and the
figures are context for it, so four 30px numbers were competing with the thing
they describe. They became one inline row at body size — 52px of height down to
20px, all of which the map took (270px tall to 301px in a default window).

The `.figure` treatment stays where it still earns the weight: the live scan
readout, where the block field is again the only other element and the counts
are again the finding. Same reasoning, opposite conclusion, because the context
is different.

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
