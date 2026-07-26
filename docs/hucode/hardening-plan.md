# Hucode Hardening Plan

Work breakdown derived from the [Architecture and Quality Review
2026-07-25](archive/hucode-architecture-review-2026-07-25/README.md), plus two
runtime issues raised independently of it.

Every one of the review's 26 surviving candidates maps to a work item or an
explicit accept decision below. Candidate IDs are preserved so each item stays
traceable to the review; read the finding detail in
`archive/hucode-architecture-review-2026-07-25/authoritative/`.

This plan is the living tracker. It moves into `archive/` when the work lands.

## Assessment at current HEAD

The review targeted `9988ea33b8b`, which is one docs-only commit behind current
HEAD. Code drift is zero, so every finding was assessed as still live without
re-deriving it.

The review's five-phase roadmap is broadly sound and its architectural
conclusion — Omni is justified, this is hardening not redesign — holds. Four
corrections follow from re-checking the findings against current source and
against issues #105 and #106.

**1. The five orphaned CI suites all pass.** Verified locally: 33 assertions,
0 failures. Nothing was rotting behind the CI gap. The exposure was never
"broken code hiding" but "no regression protection," and it sits directly on
the surface that B1 and E3 are about to change. This makes A1 a zero-risk
prerequisite rather than a risky cleanup.

**2. C009 is mis-framed, not merely mis-severed.** The review downgraded
desktop/web duplication to medium because "no realized divergence survives
verification." Issue #106 is a realized divergence: `skipBuiltinExtensions` and
`hucodeExtensionEnablementPolicy` exist only in
`src/vs/hucode/electron-browser/omni.main.ts:153-180`, and
`HucodeOmniBrowserMain` (`src/vs/hucode/browser/omniWeb.factory.ts:22`)
overrides only `createWorkbench`. The consequence is severe and user-visible.
The real gap is that no parity contract exists between desktop and web Omni on
any axis; lifecycle orchestration is one axis and environment/extension policy
is another that has already shipped a defect.

**3. C001 blocks issue #105.** #105's Layer 1 depends on
`unloadAndRemoveInstance` returning `false` when a hosted workbench vetoes. It
cannot: `prepareUnload`
(`src/vs/hucode/browser/hostedOmniWorkspace.web.contribution.ts:126`) returns
`true` unless `shutdown()` throws, and `requestUnload`
(`src/vs/hucode/browser/webShellService.ts:1311`) maps `true` to `'ready'`. The
veto branch is unreachable; only the timeout branch works. #105 must not land
before B1 or its safety fallback is disconnected on arrival.

**4. Phase ordering has two defects.** The review's Phase 1 lists C003 before
C004, but C003's prescribed bounded-backoff retry needs the cancellation and
timeout primitives C004 introduces. And it places shared desktop/web contract
tests in Phase 2, after the concurrent-shutdown work in Phase 1 — that would
change shutdown sequencing in two parallel implementations of an invariant
recorded only in prose, with no test that they still agree.

Both issues were found by runtime investigation. The review was static by
construction and found neither. That is the review's stated limitation behaving
as documented, and it is the reason B1 should be reproduced at runtime rather
than fixed from the report alone.

## Ordering basis

Every finding in this plan is intended to be fixed. Nothing here is gated on a
release milestone, and no item is deferred on the grounds that a beta does not
need it. Ordering is therefore by **dependency and risk**, not by release tier:

- **Unblocking** — cheap work that other items depend on for safety or signal.
- **Independent** — no prerequisites, can start immediately and in parallel.
- **Sequenced** — has a hard prerequisite; see the graph below.
- **Low priority** — real work, genuinely small consequence. Do it, but last.

| Basis | Items |
| --- | --- |
| Unblocking | A1, A2 |
| Independent | E1, C1, D1, F1, G1, R1 |
| Sequenced | B1 → E4, B1 + E2 → E3, D1 → D2, G1 → G2, G2 → G3 |
| Low priority | B2, C2, H1, H2, H3, L-items in the low table |

## Recommended sequence

Dependencies between items, independent of which phase they land in:

```
A1 ──── A2                     (guard starts from a clean inventory)

B1 ──┬── E4 (#105 orphan adoption)
     └── E3 (concurrent shutdown) ◄── E2 (contract suite)

D1 ──── D2                     (backoff needs cancellation primitives)

G1 ──── G2 ──── G3             (packaged CI path, then scenario, then units)

C1 ──── C2 (opportunistic, same file)

E1, F1, R1, H1, H2, H3         no prerequisites
```

**Start with A1.** Until CI runs the committed suites, every later fix ships on
an unverified signal — and it is a green, zero-risk YAML change already
verified locally.

**Then E1**, as the first item of phase 2. It is the only finding with
confirmed severe runtime impact, and it is self-contained: a browser-side
enablement change touching no lifecycle code, so it cannot conflict with the
rest of the plan. See [Two phases](#two-phases) for why it is not batched with
the phase 1 items despite having no prerequisites.

## PR boundaries

One PR per work item, with deliberate bundling where items are trivial or
genuinely inseparable. The test for a boundary is: **can this PR be reverted
without also reverting something still wanted?** That yields roughly 16 PRs.

Not one PR per stream — Stream E alone would combine extension policy, contract
tests, shutdown concurrency, and orphan adoption, which is exactly the "PR that
mixes unrelated runtime, architecture, test, and release changes" the review
warns against. And not one mechanical PR per item either: H2 and H3 are ten
lines of docs between them, and B2/C2 exist only if the parent work makes them
natural.

| PR | Items | Title prefix | Fragment |
| --- | --- | --- | --- |
| 1 | A1 | `ci:` | No |
| 2 | A2 | `ci:` | No |
| 3 | E1 | `fix:` | Yes |
| 4 | B1 (+B2 if natural) | `fix:` | Yes |
| 5 | C1 (+C019 from C2) | `fix:` | Yes |
| 6 | D1 | `fix:` | Yes |
| 7 | D2 | `fix:` | Yes |
| 8 | F1 | `fix:` | Yes |
| 9 | E2 | `test:` | No |
| 10 | E3 | `perf:` | Yes |
| 11 | E4 Layer 1 | `fix:` | Yes |
| 12 | E4 Layer 2 | `fix:` | Yes |
| 13 | G1 | `ci:` | No |
| 14 | G2 | `test:` | No |
| 15 | G3 | `test:` | No |
| 16 | R1 | `feat:` | Yes |
| 17 | H1 | `feat:` | Yes |
| 18 | H2 + H3 | `docs:` | No |
| 19 | Low-priority batch | varies | Per item |

G3 may split further per module. The low-priority batch (C006, C008, C016,
C022, C023, C025, C028, C029) should not be one PR — group by subsystem so each
stays revertable.

---

# Work items

## Stream A — CI trust

### A1 — Assign orphaned suites to the Electron runner

**Objective.** Make CI actually execute the five committed Hucode test suites
that no runner currently loads, and record the local-run procedure.

**Candidates.** C005 (partial).

**Coherent because** it is a single mechanical change with no behavioral risk,
and it is the regression net under every other item in this plan.

**Affected files.**

- `.github/workflows/hucode-ci.yml` (Electron test list, from `:343`)
- `AGENTS.md` (local Electron test procedure)

**Direction.** Append the five suites to the existing `--run` list:

```
src/vs/hucode/test/browser/omniConfigurationService.test.ts
src/vs/hucode/test/browser/projectSwitcher/openProjectSwitcherTarget.test.ts
src/vs/hucode/test/electron-main/omniWorkspaceOpen.test.ts
src/vs/hucode/test/electron-main/omniWorkspaceReopen.test.ts
src/vs/workbench/contrib/browserView/test/electron-browser/overlayManager.test.ts
```

Do not attempt the glob-or-generate refactor here; that is A2's design problem
and bundling it would delay a change that should land immediately.

Add to `AGENTS.md` beside the existing `ELECTRON_RUN_AS_NODE` note: local
Electron unit runs need `ELECTRON_DISABLE_SANDBOX=1` because
`.build/electron/chrome-sandbox` must be root-owned mode 4755 and only CI does
that with `sudo`; without it the runner aborts with a
`FATAL:setuid_sandbox_host.cc` trap. `VSCODE_SKIP_PRELAUNCH=1` avoids
re-running `npm run electron` on each invocation.

**Acceptance criteria.**

- All five suites appear in the CI Electron list.
- CI is green with 33 additional passing assertions.
- `AGENTS.md` documents the sandbox and prelaunch variables.

**Validation.** Already performed locally — 33 passing, 0 failing. Confirm the
same count in CI.

**Risk.** None identified. The suites pass today; the change is additive. Roll
back by reverting the YAML.

**Prerequisites.** None. **Dependents.** Everything that relies on regression
coverage, particularly B1, E3, and E4.

**PR size.** Very small. **Changelog fragment.** No — `ci:`/`test:` title.

### A2 — CI test-inventory completeness guard

**Objective.** Make it impossible for a committed test file to be assigned to
no runner without CI failing.

**Candidates.** C005 (remainder).

**Coherent because** the five orphans were a symptom; the hand-maintained
enumeration is the cause. Separated from A1 because this needs design and A1
must not wait for it.

**Affected files.**

- `.github/workflows/hucode-ci.yml`
- likely a new script under `build/hucode/`
- `test/unit/node/index.js:57-64` (layer exclusion rules are the reference for
  which runner owns which layer)

**Direction. Decided: generate the lists.** `build/hucode/test-suites.ts`
resolves which suites exist and which runner each reaches; the workflow calls
it per runner and passes the result as repeated `--run=` arguments. A new suite
under `src/vs/hucode/`, or any `hucode*.test.ts` anywhere, is picked up with no
workflow edit, so the orphan failure mode disappears for everything a rule can
see rather than merely being detected.

Two earlier shapes were considered and rejected. Handing the runner a glob does
not work: `--runGlob`/`--glob` takes a single pattern, is mutually exclusive
with `--run` (`test/unit/electron/renderer.js:163`), matches compiled `out/`
paths through `glob@5`, and globbing the layers the Electron runner owns would
select 795 committed suites against the 34 wanted — the full upstream matrix
`docs/hucode/agent-instructions.md` keeps out of the fork baseline. Keeping the
hand-maintained list and adding a completeness *checker* works, but leaves the
list hand-maintained; generation subsumes it. Those objections were about the
runner's glob support, not about pattern matching as such — doing the matching
in TypeScript sidesteps all of them.

**Assignment is not derivable from the layer.** An explicit `--run` bypasses
the Node runner's layer exclusions, and two Electron-layer suites deliberately
run under `npm run test-node`; they are recorded as `NODE_RUNNER_OVERRIDES`
rather than inferred.

**What generation gives up, and how it is repaid.** A hand-maintained list
makes a pull request show exactly what CI will run. A generated one does not,
so the resolved lists are committed to `build/hucode/test-suites.snapshot.json`
and a stale snapshot fails the check. Ordering is stably sorted, because suites
that have never shared a runner can leak state and an ordering change should be
deliberate. Each step prints its resolved list so a CI failure is diagnosable
without re-running the resolver.

**Known limitation, and an H1 dependent.** Eleven suites are upstream-named and
run only because Hucode patched their subject. No rule can find them, so they
stay listed by hand in `UPSTREAM_SUITES` — with a reason each, and validated to
exist — and a twelfth would still be invisible.

This is not hypothetical: of the five orphans A1 fixed, rules find **four**. The
fifth,
`src/vs/workbench/contrib/browserView/test/electron-browser/overlayManager.test.ts`,
is invisible, and a copyright-header rule would not close it either — that file
carries Microsoft's notice. Only provenance distinguishes "upstream file Hucode
has forked" from "upstream file Hucode does not run", which is H1's map. Derive
`UPSTREAM_SUITES` from it when H1 lands rather than building a second
provenance mechanism here.

**Acceptance criteria.**

- Adding a Hucode suite in any layer requires no workflow edit, and shows up in
  the committed snapshot.
- A stale snapshot, a missing or redundant `UPSTREAM_SUITES` entry, a workflow
  that stops invoking either runner, and a workflow that stops using the
  resolver all fail the check.
- The resolver has coverage under `npm run test-build-scripts`.

**Validation.** The generated Electron list must reproduce the previous
hand-maintained list exactly, verified end to end through the real runner — 415
passing, matching the A1 baseline. The Node list drops 20 entries the bare
`npm run test-node` pass already enumerates, confirmed against compiled output
rather than against the resolver's own model of it. Note the
`test-build-scripts` filtering constraint in `AGENTS.md` when running a subset.

**Risk.** A rule that matches too much runs unwanted suites; one that matches
too little silently runs none. The snapshot covers both — either shows as a
diff — and the resolver refuses to emit an empty Electron list. Deliberate
exclusions have no opt-out list by design: a suite Hucode owns but does not
want run should say so where it lives, not in a second registry that rots.

**Prerequisites.** A1 (so generation starts from a clean, verified list).

**PR size.** Small-medium. **Changelog fragment.** No — `ci:` title.

## Stream B — hosted unload protocol

### B1 — Two-phase veto-capable web unload

**Objective.** Stop discarding hosted-workbench shutdown vetoes, and stop
irreversibly shutting down a workbench that may not be removed.

**Candidates.** C001. **Phase 2.**

**Coherent because** both defects are the same root cause: a terminal lifecycle
operation used as a reversible preflight.

**Affected files.**

- `src/vs/hucode/browser/hostedOmniWorkspace.web.contribution.ts:126`
- `src/vs/hucode/browser/webShellService.ts:1301-1325`
- `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts` (reference
  only — `:93`, `:122`, `:158`)

**Direction.** Introduce a real two-phase protocol matching the semantics
desktop already has via before-unload/will-unload:

1. veto-capable `beforeUnload` preparation that collects and *returns* veto
   results without mutating lifecycle state;
2. parent decision, including the existing generation and path checks;
3. irreversible `willUnload` commit issued only once removal is guaranteed.

Do not reuse `BrowserLifecycleService.shutdown()` as the preflight. Note that
`handleVeto` returns early with "veto handling disabled" when `vetoShutdown` is
not a function, so the veto results are computed and dropped today — the
information exists and is being thrown away.

**Scope discipline: protocol shape only.** Leave the serial fan-out in
`webShellService.ts:1007` untouched. E3 parallelises it afterwards. Changing
both at once means building the protocol and immediately rewriting it.

**Acceptance criteria.**

- A hosted workbench with a modified, unbacked-up working copy vetoes, and the
  iframe is not removed.
- An unload aborted by the parent's generation check leaves the workbench live
  *and* interactive — its lifecycle has not shut down.
- A successful unload still shuts the child down exactly once.

**Validation.** A regression test using the production lifecycle-service
composition, not a fake child response — the review is explicit that a fake
would not have caught this. Extend
`src/vs/hucode/test/browser/webShellService.test.ts`. Manually reproduce the
data-loss path first: `npm run hucode:web`, disable hot exit, modify a
non-file custom working copy, then Suspend/Unload/Dismiss. The review flags
this as not runtime-verified, and the exact loss surface should be confirmed
before the fix is designed around it.

**Risk.** Medium. Unload is on the shutdown path; a bug here hangs quit rather
than losing data, but hangs are user-visible. The generation checks already in
place limit blast radius. Roll back by reverting to the single-phase call.

**Prerequisites.** A1. **Dependents.** E3, E4.

**PR size.** Medium. **Changelog fragment.** Yes — `fix:`.

### B2 — Replace timer coordination with acknowledgements

**Objective.** Replace fixed-timer reload and connection teardown coordination
with protocol acknowledgements.

**Candidates.** C013 (L-04). **Opportunistic.**

**Coherent because** it is the same protocol surface as B1, and the review
identifies timer coordination as a symptom of the same missing
preparation/commit boundary. Worth folding in only if B1's implementation makes
it natural.

**Affected files.** `src/vs/hucode/browser/webShellService.ts:966`, `:1110`,
`:1318`.

**Direction.** Acknowledge rather than assume. The current fallback is
self-cancelling and the unload timeout fails closed — it refuses the close
rather than removing the workbench — so the verified consequence is redundant
reloads and refused closes on slow links, not lost state. Treat as cleanup, not
a defect fix.

**Acceptance criteria.** No fixed-duration timer gates a state transition that
the child can acknowledge. Slow-link behavior degrades to waiting, not to
duplicate work.

**Risk.** Low, but only if it rides along with B1. As a standalone PR the churn
is not obviously worth it.

**PR size.** Small if bundled with B1; skip otherwise.
**Changelog fragment.** Yes if shipped separately — `fix:`.

## Stream C — serve-web state durability

### C1 — Atomic project persistence and non-destructive load failure

**Objective.** Stop acknowledging mutations that may not be durable, and stop
relocating valid state files on transient I/O errors.

**Candidates.** C002, C021.

**Coherent because** these are the same file, the same subsystem, and the same
root cause — the serve-web project state adapter does not distinguish durable
from acknowledged, nor permanent from transient. The review splits them across
two phase items; they are one PR. Fixing either alone leaves the other's
failure mode intact on the same code path.

**Affected files.**

- `src/vs/server/node/hucodeWebProjectManagerServer.ts:129-149` (load/corrupt
  handling)
- `src/vs/server/node/hucodeWebProjectManagerServer.ts:172`, `:189`, `:192`,
  `:409` (write queue)

**Direction.** Reuse upstream semantics rather than inventing them. Upstream's
`src/vs/platform/state/node/stateService.ts:52` logs load failures without
relocating the source file — match that. For writes, adopt
`FileStorage`/`IStateService` atomic-replacement semantics where practical:
temp file plus rename, and a `close` that actually joins the queue during normal
disposal rather than only under test.

**Decided: serve-web project data is durable.** An HTTP success means the
mutation has reached disk. Await durable completion on the request path rather
than acknowledging from the write queue. Accept the added latency — project
mutations are infrequent and user-initiated, so correctness wins over
throughput.

For loads, reserve `.corrupt` relocation for confirmed parse or schema failure.
On I/O failure leave the primary file untouched, expose a typed degraded state,
and refuse overwrite until a read succeeds. This is the review's cross-cutting
theme 1 — failures rendered as valid empty state — in its most damaging form.

**Acceptance criteria.**

- A mutation acknowledged over HTTP survives immediate process termination, or
  the contract explicitly documents that it does not.
- Normal disposal joins pending writes.
- A JSON parse error still produces `.corrupt` preservation.
- `EACCES`/`EBUSY`/`EMFILE` on read leaves the primary file in place and
  surfaces a degraded state; the catalog is not silently emptied and is not
  overwritten from empty.

**Validation.** Unit coverage per failure class — parse error, permission
error, lock error, `ENOENT`. Assert that only the parse case relocates.
Existing coverage lives in
`src/vs/hucode/test/browser/projectManager/webProjectManagerService.test.ts`
(already CI-wired).

**Risk.** Medium. Touches the read path for all serve-web project state; a
regression empties users' project catalogs. Mitigate by making the degraded
state refuse writes — failure should be inert, not destructive. Roll back
cleanly; no migration.

**Prerequisites.** None. **Dependents.** None.

**PR size.** Medium. **Changelog fragment.** Yes — `fix:`.

### C2 — Serve-web endpoint hardening

**Objective.** Close two low-severity gaps in the same file while it is open.

**Candidates.** C019 (L-08), C023 (L-10). **Opportunistic.**

**Direction.** C019: serve-web bypasses the UI's validation, letting a worktree
`startPoint` be reinterpreted as a Git option
(`hucodeWebProjectManagerServer.ts:481` into `gitWorktreeService.ts:156`,
`:188`). This is a privileged-client correctness issue, not shell injection —
validate at the endpoint. C023: the projects SSE endpoint
(`:582`, `:612`) has no client cap or backpressure handling; close cleanup is
reachable and no permanent update loss was established, so add caps only if
load evidence appears.

Take C019 with C1. Leave C023 unless profiling justifies it.

**Risk.** Low. **PR size.** Small.
**Changelog fragment.** Yes if C019 ships — `fix:`.

## Stream D — project-manager Git

### D1 — Per-operation Git subprocess policy

**Objective.** Bound, cancel, and control every Git subprocess the project
manager spawns.

**Candidates.** C004.

**Coherent because** it is one function's missing policy, and it is the
foundation D2 needs.

**Affected files.**

- `src/vs/platform/projectManager/node/gitWorktreeService.ts:399` (`execGit`)
- `src/vs/platform/agentHost/node/agentHostGitService.ts:678` (in-tree
  precedent — explicit timeouts and enlarged buffer)

**Direction.** Follow the existing in-tree precedent rather than inventing a
policy. Define per-operation timeouts, kill timed-out children, thread
`CancellationToken` through, control the environment to disable interactive
credential prompts, and either stream or set an intentional maximum for ref
enumeration. The primary reachable risk is an unbounded worktree operation that
triggers a credential prompt, filter, or hook — not the buffer ceiling, which
only bites at roughly 5k+ refs and fails visibly.

**Acceptance criteria.**

- No Git invocation can run unbounded.
- A hung Git process is killed at its deadline and surfaces a typed error.
- Cancellation propagates and kills the child.
- Credential prompts cannot block a subprocess.
- Ref enumeration succeeds on a repository with 10k+ refs.

**Validation.** Unit coverage with a stub Git that hangs, one that overruns the
buffer, and one that exits non-zero. Existing suite:
`src/vs/platform/projectManager/test/electron-main/projectManagerMainService.test.ts`.

**Risk.** Medium. Too-aggressive timeouts break legitimate slow operations on
large repositories. Choose per-operation values, not one global, and log at the
deadline so tuning is evidence-driven.

**Prerequisites.** None. **Dependents.** D2.

**PR size.** Medium. **Changelog fragment.** Yes — `fix:`.

### D2 — Preserve last-known-good worktrees on transient failure

**Objective.** Stop presenting a transient Git failure as an authoritative
empty worktree list.

**Candidates.** C003.

**Coherent because** it is the recovery-policy half of the same subsystem, but
it needs D1's primitives to implement bounded retry.

**Affected files.**
`src/vs/platform/projectManager/node/projectManagerMainService.ts:603-610`
(failure path), `:381` (public refresh, the existing manual recovery).

**Direction.** On refresh error, keep the last-known-good snapshot and keep the
metadata watcher alive. Represent the project as stale or unavailable — a typed
state, not an empty list. Retry with bounded backoff using D1's cancellation
and timeout support. Clear state only when permanent removal is established.
This is cross-cutting theme 1 again.

**Acceptance criteria.**

- A transient failure leaves the previous worktree list visible, marked stale.
- The metadata watcher survives and can still drive recovery.
- Backoff is bounded and cancellable.
- Genuine removal still clears the project.

**Validation.** Unit tests for transient-then-recover, transient-then-persist,
and permanent-removal. Assert the watcher is not disposed on transient failure.

**Risk.** Low-medium. Risk is showing stale data as current; mitigate by making
the stale state visible in the UI rather than silent.

**Prerequisites.** D1. **PR size.** Medium.
**Changelog fragment.** Yes — `fix:`.

## Stream E — desktop/web parity

This stream is deliberately wider than the review's C009. The review scoped
desktop/web duplication to lifecycle orchestration; issue #106 shows the parity
gap also covers environment and extension policy, and has already shipped a
defect there.

### E1 — Web Omni extension policy parity

**Objective.** Stop the web Omni shell from loading extensions it neither
exposes nor needs.

**Candidates.** None — issue #106. Reinforces C009.

**Coherent because** it is a single missing policy consumer with a single cause,
independent of every other item in this plan.

**Affected files.**

- `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts:678`
  (`_isDisabledBySessionsWindow` — the upstream pattern to mirror)
- `src/vs/workbench/services/environment/browser/environmentService.ts:226-232`
  (`isOmniWindow` / `isHostedOmniWorkspace` — the route flags, already plumbed)
- `src/vs/hucode/electron-browser/omni.main.ts:153-180` (the desktop skip list,
  as the source of which extensions to exclude)

**Direction.** Two mechanisms exist on desktop and only one of them matters
here. `hucodeExtensionEnablementPolicy` explicitly exempts builtins —
`hucodeIsExtensionDisabledByPolicy` returns `false` for
`extension.isBuiltin` — so it would never have blocked `GitHub.copilot-chat` or
`vscode.git` on either platform. `skipBuiltinExtensions` is doing all the work.
Both are worth parity, but only the builtin filtering resolves #106.

The route-scoped seam this needs **already exists and is already wired for
web**. `BrowserWorkbenchEnvironmentService` reads `isOmniWindow` and
`isHostedOmniWorkspace` from the connection payload
(`environmentService.ts:226-232`), and `webShellService.ts:1448` sets
`isHostedOmniWorkspace` on hosted iframes. The shell and hosted workbenches are
therefore already distinguishable browser-side, per connection.

Upstream also already implements exactly this filtering for its own restricted
window: `_isDisabledBySessionsWindow`
(`extensionEnablementService.ts:678`) is browser-side, gated on a payload flag,
carries an allow-list, and disables builtins that contribute unsupported
features. Mirror it as an Omni-shell equivalent gated on
`isOmniWindow && !isHostedOmniWorkspace`, seeded from the desktop skip list.

This means **no server change, no RPC contract change, and no patch to the
remote extension scanner.** An earlier reading of this plan assumed web had no
route-scoped seam and that `scanSystemExtensions` would need parameterising;
that was wrong. The seam was built; only the consumer is missing.

One thing to verify before implementing: that disabling at enablement prevents
*activation*, not merely UI contribution. Upstream chose this mechanism for the
sessions window with the same goal, so the precedent is strong, but #106 shows
a setting can suppress visibility while a provider still registers. Confirm the
disabled set reaches the remote extension host before activation events fire.

The underlying Copilot behavior — force-opening every saved session's
repository, each creating a recursive `**` watcher — is upstream and unmodified.
Hucode's fix is to make it unreachable from the shell, not to patch Copilot.
Not reporting upstream for now: the shape of this gap suggests Omni's web setup
was modelled on the sessions window and inherited its flags without its
extension filtering, which would make it a Hucode integration gap rather than
an upstream defect. `hostedWorkspacesController.ts:1370` setting
`isSessionsWindow: false` alongside `isOmniWindow: false` is consistent with
that reading.

**Acceptance criteria.**

- Loading `/` or `/omni` does not activate `GitHub.copilot-chat` or
  `vscode.git`.
- An empty web Omni shell holds watcher counts in the same order as desktop
  Omni, not hundreds of thousands.
- `/workbench` remains a normal workbench with ordinary extension behavior.
- `/omni/workbench` hosted workbenches keep normal extension behavior.
- Desktop Omni behavior is unchanged.

**Validation.** Regression coverage for route-specific extension filtering,
asserting both extensions are excluded from the shell — cover extension
*scanning* and remote extension-host *activation* separately, since #106 shows
a setting can suppress contribution visibility while the provider still
registers. Manually re-run the issue's measurement: start `serve-web --omni`,
load `/`, and count inotify watches per file-watcher process.

**Risk.** Medium. Over-broad filtering breaks hosted workbenches, which do need
normal extensions. The route distinction is the whole safety property — test
`/`, `/workbench`, and `/omni/workbench` separately.

**Prerequisites.** None. **Dependents.** None, but informs E2's parity axes.

**PR size.** Medium. **Changelog fragment.** Yes — `fix:`.

### E2 — Desktop/web lifecycle contract suite

**Objective.** Convert the desktop/web keep-in-sync requirement from prose into
an executable contract.

**Candidates.** C009.

**Coherent because** it is the prerequisite that makes E3 safe, and the
mechanism that would catch the next E1-class divergence.

**Affected files.** New shared suite exercising
`src/vs/hucode/electron-main/hostedWorkspacesController.ts:153` and
`src/vs/hucode/browser/webShellService.ts:327` through their existing injected
adapters. Reference invariant: `docs/hucode/architecture.md:66`.

**Direction.** One suite, identical scenarios, run against both adapters:
generation guards, deferred state emission, restoration, activation, close-next
behavior, shutdown sequencing. Extend to environment and extension policy given
E1. Extract a common orchestration skeleton *only* where these tests
demonstrate genuinely shared policy — the review is explicit that forcing
`WebContentsView` and iframe mechanics behind one abstraction would hide
important differences rather than reduce risk. Tests first, extraction second,
and only if the tests justify it.

**Standard: converge far enough that the split is sensible.** The target is not
maximum shared code, and not minimum. When a reader asks "why are these two
implementations separate?", the answer should be a specific platform mechanic —
`WebContentsView` versus iframe, native focus versus DOM focus — not "history."
Anything that fails that test is a candidate for extraction; anything that
passes it stays split, documented as to why.

**Acceptance criteria.**

- One scenario set runs green against both adapters.
- A deliberate divergence introduced in either implementation fails the suite.
- No abstraction is introduced that the tests did not justify.

**Validation.** The suite is the deliverable. Verify by mutation: break one
platform, confirm failure.

**Risk.** Low — additive test work. The real risk is over-reach into premature
abstraction; the acceptance criteria guard against it.

**Prerequisites.** A1. **Dependents.** E3.

**PR size.** Medium-large. **Changelog fragment.** No — `test:` title.

### E3 — Bounded concurrent hosted-workbench shutdown

**Objective.** Stop multiplying quit latency across resident workbenches.

**Candidates.** C010.

**Affected files.**

- `src/vs/hucode/electron-main/hostedWorkspacesController.ts:1591`
- `src/vs/hucode/browser/webShellService.ts:1007`
- `src/vs/hucode/electron-browser/omni.main.ts:290`

**Direction.** Run independent preflight and teardown handshakes concurrently
under one overall deadline rather than per-instance. Preserve per-instance veto
results. Serialize only the native destruction steps that genuinely require
ordering. Desktop currently waits up to 5s before-unload and 15s will-unload
*per instance*, so several unresponsive workbenches multiply quit latency while
the shell joins the operation into shutdown. Upstream multi-window shutdown
paths are the precedent for bounded concurrency.

**Acceptance criteria.**

- Quit latency with N unresponsive workbenches approaches the single-instance
  deadline, not N times it.
- Every per-instance veto is still honored.
- Ordering-sensitive native teardown remains ordered.

**Validation.** E2's contract suite extended with a multi-instance shutdown
scenario including one unresponsive instance. Manual: quit with several
workbenches open, one deliberately hung.

**Risk.** Medium-high — this is the riskiest item in the plan. It changes
shutdown sequencing on both platforms simultaneously, and shutdown bugs
manifest as hangs or lost state at the least recoverable moment. E2 is a hard
prerequisite, not a nicety.

**Prerequisites.** B1 (protocol must be settled first), E2 (contract coverage).

**PR size.** Medium. **Changelog fragment.** Yes — `perf:`.

### E4 — Orphan hosted-workbench adoption

**Objective.** Stop project removal from stranding live, invisible hosted
workbenches.

**Candidates.** None — issue #105. Demonstrates C009's cost.

**Affected files.**

- `src/vs/hucode/browser/webShellService.ts` (reconcile `:713-738`, restore
  `:1141-1144`, persist `:1505-1517`)
- `src/vs/hucode/electron-main/hostedWorkspacesController.ts` (twins at
  `:1013-1031`, `:657-663`)
- `src/vs/hucode/common/retainedWorkbench.ts:62-204`
- `src/vs/hucode/browser/projectSwitcher/projectSwitcher.contribution.ts`
  (`:1421-1442`, `:2370-2377`, `:3008-3045`)

**Direction.** As specified in #105 — two layers. Layer 1: Remove Project
unloads its own client's loaded worktrees. Layer 2: any instance whose
`projectId` no longer resolves, and whose path no live project worktree claims,
is adopted into `RetainedWorkbenchCatalog`. Restore needs the same treatment or
pre-fix snapshots keep resurrecting orphans.

**Two constraints the issue calls out and this plan reinforces.** Fix in the
shell services, not the tree model — the catalog feeds the sidebar, the picker,
and the snapshot, so patching `projectSwitcherTreeModel.ts` alone leaves two of
three broken. And do not add demotion to `reconcileRetainedWorkbenches` as it
stands: `projectSwitcher.contribution.ts:2370-2377` calls it with a *partial*
project list, so demotion logic there would convert every other project's
loaded worktree into an arbitrary workbench whenever a project is added.

**Hard dependency on B1.** Layer 1's decision — on veto, fall through to Layer 2
rather than force-drop — requires a working veto signal. Until B1 lands,
`requestUnload` cannot return `'vetoed'` from an actual veto, so a dirty
workbench would be dropped rather than adopted. Landing E4 first ships its
safety fallback disconnected.

**Acceptance criteria.** Per #105's verification section: an unresolvable
`projectId` renders somewhere; adoption occurs on both reconcile and restore;
the Layer 1 veto path produces an arbitrary workbench; desktop behaves
identically; re-adding a project still de-duplicates; adding an unrelated
project demotes nothing.

**Validation.** Unit coverage in `projectSwitcherTreeModel.test.ts`,
`webShellService.test.ts`, and `hostedWorkspacesController.test.ts` — all
CI-wired. Manual: the issue's two-browser repro.

**Risk.** Medium. Adoption logic that misfires demotes live project worktrees
into arbitrary workbenches. The partial-list hazard above is the specific trap.
Never silently drop a workbench.

**Prerequisites.** B1. Benefits from E2.

**Opportunistic.** This touches three regions of the 3,193-line
`projectSwitcher.contribution.ts` (C015 / L-05). If the change makes the split
natural, take it here; do not force it.

**PR size.** Large — consider splitting Layer 1 and Layer 2.
**Changelog fragment.** Yes — `fix:`.

## Stream F — lifecycle ownership

### F1 — Release destroyed controllers from the service store

**Objective.** Stop retaining one disposed controller per Omni window for the
main-process lifetime.

**Candidates.** C024.

**Affected files.** `src/vs/hucode/electron-main/shellMainService.ts:471`
(registration), `:92` (window destruction). Reference:
`src/vs/base/common/lifecycle.ts:420`, `:481`.

**Direction.** Use a `DisposableMap` keyed by window id, or register a
self-removing wrapper. `DisposableStore` retains entries in a `Set` until
clear, delete, or dispose, so disposing the controller is not enough — it must
be removed from the store.

**Acceptance criteria.** Repeated open/close cycles leave no controller
retained. A main-process heap profile after the fix confirms the retained size
is gone.

**Validation.** The intended unit assertion is not available:
`shellMainService.ts` cannot be loaded by either runner, for the reason
recorded under G3. Nothing in the module is reachable from a test until that
is unblocked, so this ships on the existing Electron suite as regression cover
plus a heap profile. Add the store-size assertion as part of G3.

**Risk.** Low. Small, local, well-understood.

**Prerequisites.** None. Land whenever.

**PR size.** Very small. **Changelog fragment.** Yes — `fix:`.

## Stream G — verification depth

### G1 — Run the Omni smoke script in CI

**Objective.** Execute the packaged smoke script that already exists but no
workflow invokes.

**Candidates.** C018 (partial).

**Affected files.** `build/hucode/linux-omni-smoke.ts`, `package.json:17`,
`.github/workflows/hucode-ci.yml`.

**Direction.** Wire the declared script into a workflow as-is. Do not extend it
here — that is G2. Cheap, and it establishes the packaged-app CI path that G2
builds on.

**Acceptance criteria.** The script runs in CI and fails the job on a
non-zero exit.

**Risk.** Low, but packaged-app jobs are slower and flakier than unit tests.
Budget for that and consider a separate job rather than blocking the main one
initially.

**PR size.** Small. **Changelog fragment.** No — `ci:`.

### G2 — Real-app hosted-workbench lifecycle scenario

**Objective.** Cover hosted-workbench lifecycle against a packaged application,
not injected fakes.

**Candidates.** C018.

**Direction.** Extend the smoke script to the review's six-step scenario: start
Omni with two workbenches; switch between them; suspend and restore one;
terminate a hosted renderer and observe crashed/recovery state; quit and
relaunch; verify expected active and dormant restore state. The controller
suite is extensive but uses injected fakes throughout, and the current smoke
script only checks startup and renderer counts.

**Acceptance criteria.** All six steps assert observable state. A deliberate
regression in restore or crash handling fails the job.

**Risk.** Medium — real-app tests are the flakiest thing in any suite. Keep the
scenario deterministic and generous with timeouts. Do not make it a required
check until it has proven stable.

**Prerequisites.** G1. **PR size.** Large.
**Changelog fragment.** No — `test:`.

### G3 — Direct coverage for the largest shell modules

**Objective.** Close the direct-coverage gap on the biggest imperative
surfaces.

**Candidates.** C020.

**Affected files.**
`src/vs/hucode/browser/projectSwitcher/projectSwitcher.contribution.ts:1044`,
`src/vs/hucode/browser/workbench.ts:806`,
`src/vs/hucode/electron-main/shellMainService.ts`, and the shell Part
implementations.

**`shellMainService.ts` cannot be loaded by any runner today.** Found while
implementing F1. It imports `IBrowserViewMainService` from
`browserViewMainService.ts`, which imports `browserView.ts`, which does a named
import of `WebContentsView` from `electron`. That export exists only in the
main process, and the Electron unit runner executes in a renderer — so the
import fails there, and under `npm run test-node` too. The absence of direct
coverage for this service is a structural constraint, not an oversight.

Unblocking it means moving the `IBrowserViewMainService` decorator and
interface into a module that does not pull in `browserView.ts`; six files
import the decorator. That refactor belongs here rather than bundled into an
unrelated fix, and it is a prerequisite for any direct test of this service.

**Direction.** Extend the existing injected-adapter pattern to DOM, drag/drop,
service wiring, visibility, and multi-window orchestration. Use G2's real-app
scenario for native behavior rather than duplicating it in unit tests. Note
that the review reduced this from high because core decision logic is already
extracted into tested pure models — this is filling gaps, not building from
zero.

**Acceptance criteria.** Each named module has direct behavioral coverage of
its primary responsibilities.

**Risk.** Low. Additive.

**Prerequisites.** A1. Best done after E4 and G2 so it covers settled behavior.

**PR size.** Large — split per module.
**Changelog fragment.** No — `test:`.

## Stream H — upgrade sustainability

### H1 — Forked-file provenance and drift detection

**Objective.** Turn silent upstream drift in forked Omni files into a loud
upgrade-time failure.

**Candidates.** C007.

**Affected files.** `src/vs/hucode/browser/workbench.ts:113`,
`parts/titlebarPart.ts:95`, `parts/panelPart.ts:39`,
`parts/auxiliaryBarPart.ts:41`; the `hucode-upgrade-vscode` skill;
`docs/hucode/repo-strategy.md`.

**Direction.** Maintain a machine-readable provenance map per forked file
recording its upstream source and last synchronized baseline. Add an upgrade
check that fails or warns when the recorded upstream source has changed. Keep
reducing copied code where delegation is possible — but the review is explicit
that the separate shell architecture is justified, so this is drift
*management*, not de-forking.

E1's new upstream seam should be registered here too.

**Acceptance criteria.** Every intentionally forked file has a provenance
entry. The upgrade skill reports changed upstream sources. A missing entry for
a new fork fails the check.

**Risk.** Low. Tooling only.

**Prerequisites.** None, but naturally triggered by the next VS Code upgrade —
sequence it with that rather than as a standalone push.

**Dependents.** A2's suite resolver, whose rules cannot see upstream-named
suites that exist only because Hucode patched their subject. Feed the
provenance map into `UPSTREAM_SUITES` in `build/hucode/test-suites.ts` so that
list is derived rather than remembered.

**PR size.** Medium. **Changelog fragment.** Yes — `feat:`.

### H2 — Record the ProxyChannel lazy-event dependency

**Objective.** Add the undocumented upstream dependency to the upgrade
checklist.

**Candidates.** C017 (L-07). **Fix now — near-free.**

**Direction.** `hucodeCreateLazyEventService` depends on ProxyChannel's
undocumented enumeration-based event discovery
(`src/vs/base/parts/ipc/common/hucodeLazyEventService.ts:16`). The integration
tripwire already exists — the unit test at
`hucodeLazyEventService.test.ts:39` round-trips through the real
`ProxyChannel.fromService` and asserts zero eager subscriptions, so a
regression fails a test rather than passing silently. Only the checklist entry
is outstanding.

**Acceptance criteria.** The dependency appears in the upgrade checklist.

**PR size.** Trivial — bundle with H3.
**Changelog fragment.** No — `docs:`.

### H3 — Reconcile the layering rule with the lint allow-list

**Objective.** Make the architecture doc agree with what the code actually
does.

**Candidates.** C012 (L-03). **Fix now — near-free.**

**Direction.** `windowsMainService.ts:43` imports from `src/vs/hucode`,
contradicting the documented layering rule, but the import is explicitly
allow-listed at `eslint.config.js:1601` and creates no cycle. The review found
relocating the helpers would not materially reduce the upgrade conflict
surface. So this is a doctrine/config inconsistency: update
`docs/hucode/architecture.md` to describe the actual, deliberate integration
strategy including the allow-list, rather than moving code to satisfy a rule
nobody intends to enforce.

**Acceptance criteria.** The architecture doc and the lint config describe the
same policy.

**PR size.** Trivial — bundle with H2.
**Changelog fragment.** No — `docs:`.

---

## Stream R — release integrity

### R1 — Sign or attest release checksums

**Objective.** Give `SHA256SUMS` independent authenticity.

**Candidates.** C034 (L-14). **In scope.**

**Affected files.** `build/hucode/release-assets.ts:120`,
`.github/workflows/hucode-release-build.yml:1347`.

**Direction.** **Decided: GitHub artifact attestation**, not a detached
signature. It needs no key custody, fits the existing GitHub-hosted release
matrix, and carries build provenance rather than only authorship. Publish it
alongside `SHA256SUMS` so a checksum is verifiable independently of the channel
that delivered it. Document the verification procedure in
`docs/hucode/release.md` — an attestation nobody knows how to check provides no
assurance.

**Acceptance criteria.** Every release publishes a verifiable attestation or
signature covering `SHA256SUMS`. The documented verification command succeeds
against a real release asset and fails against a tampered one.

**Validation.** Extend the existing release-assets test coverage. Verify
end-to-end against a real release once, including the negative case.

**Risk.** Low-medium. Key custody or attestation misconfiguration blocks
releases. Add it as a non-blocking step first, confirm it produces valid output
across a full release, then make it required.

**Prerequisites.** None. **PR size.** Medium.
**Changelog fragment.** Yes — `feat:`.

---

# Low-priority work

Real work with genuinely small consequence. All of it gets fixed; none of it
should displace the items above. Grouped by subsystem so each batch stays
independently revertable.

| ID | Finding | Action |
| --- | --- | --- |
| C006 (L-01) | Update-metadata dispatch has no retry after publication | Add retry with backoff and alerting on the dispatch step. The ordering itself is fine — the gap is that a failed dispatch is silent until someone notices. |
| C016 (L-06) | Command-forwarding suppression uses module-global mutable state | Scope the state to the forwarding surface that owns it. Currently safe because only one surface uses it; that is a property of today's callers, not a design guarantee. |
| C022 (L-09) | Clipboard forwarding calls `preventDefault` before knowing forwarding succeeded | Make failed forwarding recoverable, or fall back to native handling when forwarding reports failure. |
| C023 (L-10) | Projects SSE lacks client cap and backpressure | Add a client cap and backpressure handling. Bundle with C1/C2 — same file. |
| C025 (L-11) | OpenVSX verifier selection is host-exact and error mapping is text-based | Make the verifier host configurable and replace text-based error classification with structured signals. |
| C029 (L-13) | Browser-view layout repeats two tree walks per layout | Profile first, then decide. The action is the measurement — do not optimise unmeasured. |

## Document rather than change

Two findings where the current behavior is correct and the gap is that nothing
says so.

| ID | Finding | Action |
| --- | --- | --- |
| C008 (L-02) | Omni silently no-ops show requests for unsupported shell parts | Deliberate. Record the intent at `workbench.ts:1011` and consider a debug-level log so the no-op is observable rather than invisible. |
| C028 (L-12) | Hosted routing supplements a typed allowlist with an undocumented Electron `webContentsId` | Register as an upgrade seam under H1. The trust model is sound; the risk is that an upstream change to the optional field passes unnoticed. |

C015 (L-05, the 3,193-line project-switcher contribution) is **opportunistic** —
split it during E4, which already touches three regions of the file, rather
than as dedicated work.

---

# Candidate mapping

All 26 surviving candidates. Rejected candidates (C011, C014, C026, C027, C030,
C031, C032, C033, C035, C036) are not listed and must not be re-opened without
new evidence from current source.

| ID | Sev | Work item |
| --- | --- | --- |
| C001 | high | B1 |
| C005 | high | A1 + A2 |
| C002 | med | C1 |
| C003 | med | D2 |
| C004 | med | D1 |
| C007 | med | H1 |
| C009 | med | E2 (re-framed; see E1) |
| C010 | med | E3 |
| C018 | med | G1 + G2 |
| C020 | med | G3 |
| C021 | med | C1 |
| C024 | med | F1 |
| C006 | low | Low-priority — dispatch retry |
| C008 | low | Document intent |
| C012 | low | H3 |
| C013 | low | B2 (opportunistic) |
| C015 | low | Opportunistic during E4 |
| C016 | low | Low-priority — scope the state |
| C017 | low | H2 |
| C019 | low | C2 |
| C022 | low | Low-priority — recoverable forwarding |
| C023 | low | Low-priority — bundle with C2 |
| C025 | low | Low-priority — configurable verifier |
| C028 | low | Document under H1 |
| C029 | low | Low-priority — profile first |
| C034 | low | R1 |

Items without a candidate: **E1** (issue #106), **E4** (issue #105).

---

# Decisions taken

Recorded so the reasoning survives, and so these are not silently re-litigated.

**1. No release-milestone tiering.** Every finding gets fixed. Ordering is by
dependency and risk, not by what a beta needs. This removed the plan's original
beta-blocker framing and reclassified six findings from accept/monitor into
low-priority work.

**2. Serve-web project data is durable.** HTTP success means the mutation
reached disk. C1 awaits durable completion rather than acknowledging from the
write queue, accepting the latency.

**3. Desktop/web convergence goes far enough that the split is sensible.** The
test is whether a specific platform mechanic explains each remaining
divergence. "History" is not an acceptable answer; `WebContentsView` versus
iframe is.

**4. The Copilot force-open behavior is not reported upstream for now.** The
shape of the gap suggests Omni's web setup was modelled on the sessions window
and inherited its flags without its extension filtering — a Hucode integration
gap rather than an upstream defect. Revisit if E1's implementation contradicts
that.

**5. C034 is in scope**, implemented as R1 using GitHub artifact attestation.

**6. This work lands on its own integration branch.** See below.

# Integration branch

All work in this plan targets a dedicated integration branch rather than the
active `series-*` mainline. The volume of refactoring makes cohesion
unverifiable until most of it has landed, and the mainline should not carry a
half-migrated state in the meantime.

**Name it to match `series-*`.** The CI and changelog workflows filter on base
branch:

```yaml
# .github/workflows/hucode-ci.yml, .github/workflows/hucode-changelog.yml
on:
  pull_request:
    branches: [main, "series-*", "release/*"]
```

A branch named `hardening` or `integration/*` would receive **no CI and no
changelog validation** on PRs targeting it — the checks would simply not run,
silently. `series-1.130.0-hardening` matches the existing glob, inherits every
check with no workflow edit, and sits alongside the established
`series-<version>-replay` suffix convention. (`semantic-pr.yml` uses
`pull_request_target` with no branch filter, so PR-title validation works
regardless. `hucode-release-build.yml` triggers on tags only and is
unaffected.)

**Keep it short-lived.** The repository replays its patch series onto each new
VS Code baseline rather than tracking upstream continuously, so a long-lived
divergent branch works against the model. **Decided: no baseline upgrade will
be started while this work is in flight**, which removes the replay risk. The
branch should still not outlive its purpose.

## Two phases

Work splits into two batches with a review gate between them.

**Phase 1 — mechanical and independent.** Branch
`series-1.130.0-hardening-base`. Six PRs, none touching runtime lifecycle code:

| PR | Item | Surface |
| --- | --- | --- |
| 1 | A1 | `hucode-ci.yml`, `AGENTS.md` |
| 2 | A2 | workflows, new `build/hucode/` script |
| 3 | F1 | `shellMainService.ts` |
| 4 | G1 | workflows, `package.json` |
| 5 | R1 | `release-assets.ts`, release workflow, `release.md` |
| 6 | H2 + H3 | `architecture.md`, upgrade checklist |

The selection criterion is **mechanical *and* independent**, not independent
alone. C1, D1, and E1 have no prerequisites either, but they are substantive
runtime refactors whose review needs sustained attention — batching them with
CI wiring and docs would make the batch harder to review, not easier.

Overlap check: `shellMainService.ts` (F1) is not referenced by
`webShellService.ts` or `hostedWorkspacesController.ts`, so F1 cannot conflict
with the phase 2 lifecycle work. G3 also touches `shellMainService.ts`, but G3
is late in phase 2 and the concerns are disjoint.

Review gate: merge phase 1 into mainline once reviewed as a batch.

**Phase 2 — coupled runtime work.** Branch `series-1.130.0-hardening`, cut from
mainline *after* the phase 1 merge. Everything else: E1, B1, C1, D1→D2, E2→E3,
E4, G2, G3, and the low-priority batch. Final integration is one PR into
mainline once the set is verified together.

**One caveat on R1.** It is mechanical, but it touches the release pipeline and
its acceptance criteria require verification against a real release, including
the negative case. That may take longer than the rest of the batch. Land it as
a non-blocking step first and do not let it gate the phase 1 merge if the other
five are ready.

**Mechanics.**

- Both branches match the `series-*` glob, so CI and changelog validation run
  on PRs targeting them with no workflow edit.
- `.changes/*.md` fragments work unchanged — named by PR number, validated by
  the changelog workflow.
- Rebase from mainline periodically during phase 2 so divergence stays small
  and conflicts surface early.

# Remaining open questions

**1. Does enablement-time filtering prevent extension activation?** Not
answerable from here — it is an implementation-time verification, and it is the
first task inside E1 rather than a decision to take up front. Upstream uses
this mechanism for the sessions window with the same intent, so the precedent
is strong. If it turns out activation happens off the scanned set regardless of
enablement, E1 falls back to parameterising the remote scanner, which is
materially more work. Resolve it before E1's design is fixed, not before E1
starts.
