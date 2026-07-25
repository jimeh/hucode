# Hucode Architecture and Quality Review

**Date:** 2026-07-25  
**Hucode HEAD:** `9988ea33b8b22cadc9332eae44c01df7589a22ad`  
**VS Code baseline:** `1b6a188127eeaf9194f945eb6eb89a657e93c54c`
(`upstream-1.130.0`)  
**Comparison:** `upstream-1.130.0..HEAD`  
**Patch series:** 14 Hucode commits, approximately 495 changed paths

## Executive assessment

Hucode has a credible architectural foundation and is substantially more
coherent than a typical alpha-quality fork. Its strongest decisions are the
ones that make the fork sustainable:

- most policy lives in Hucode-owned modules;
- upstream files are usually thin integration seams;
- the Omni shell is separated from hosted VS Code workbenches;
- desktop and web share a typed lifecycle state model;
- difficult controllers expose injected test adapters;
- product identity is isolated in a validated overlay;
- the release pipeline has unusually strong asset and publication contracts.

The central product architecture is justified. Omni cannot reasonably be
implemented as a normal workbench contribution, and the review found no basis
for replacing it with an upstream feature that does not fit the requirement.
The custom shell, hosted-workbench controllers, project service, and platform
adapters should remain Hucode-owned.

The codebase is nevertheless **not beta-ready yet**. Two verified high-severity
issues should block a beta designation:

1. Serve-web uses the terminal browser lifecycle shutdown operation as an unload
   preflight. Dirty-workbench vetoes are discarded, and a parent-side abort can
   leave a still-live workbench whose lifecycle has already shut down.
2. Five committed Hucode-related test suites are assigned to no active CI
   runner, and CI has no completeness guard to detect future omissions.

Stable readiness is further blocked by project-state durability, destructive
handling of transient state-file errors, Git subprocess policy, serial shutdown,
controller retention, missing real-app lifecycle coverage, and duplicated
cross-platform orchestration policy.

The overall maturity is best described as:

> **Architecturally credible, but still in reliability and verification
> hardening.**

The review found no critical defects. After deduplication and adversarial
verification, the final set contains:

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 10 |
| Low | 14 |
| **Total surviving** | **26** |

Ten additional candidates were refuted or found out of scope.

## Methodology

Three independent model reviews were performed against the same baseline and
review criteria:

- **GPT-5.6 Sol**, executed through the raw Codex CLI.
- **Fable 5**, verified from model metadata.
- **Opus 5**, verified from model metadata.

The initial reviews produced 40 raw findings:

| Reviewer | Raw findings |
| --- | ---: |
| Sol | 6 |
| Fable | 10 |
| Opus | 24 |

The findings were normalized into 36 root-cause candidates. Candidates were
then challenged by a non-originating reviewer or, for multi-reviewer overlaps,
by the orchestrator. Verification was explicitly adversarial: reviewers were
asked to find guards, tests, platform constraints, and intended behavior that
would refute or narrow each claim.

Results:

- 26 candidates survived.
- 10 were refuted or out of scope.
- Several reported severities were reduced.
- No severity was increased above high.

Fable's completed pass was intentionally limited to architecture, lifecycle,
maintainability, tests, and VS Code alignment after broader attempts encountered
false-positive model safeguards. External-boundary and release-authenticity
coverage therefore came from Sol and Opus, not Fable.

This was primarily a static review. One focused release-assets test passed, and
a scratch Git reproduction confirmed that a worktree `startPoint` can be
reinterpreted as an option. Broad compilation and test execution were not
possible because root dependencies are not installed; precommit currently
fails while resolving the missing `event-stream` package.

## Readiness assessment

### Beta readiness: not ready

The beta blockers are:

- **H-01:** serve-web hosted unload does not preserve lifecycle veto semantics;
- **H-02:** CI silently omits five committed test suites.

The first can lose unbacked-up working-copy state and can leave a hosted
workbench in an invalid lifecycle state. The second means green CI does not
establish the guarantees implied by the committed test suite.

The project should also strongly consider resolving the following before beta,
even though they are classified medium:

- durable and atomic serve-web project persistence;
- non-destructive handling of transient state-file read errors;
- last-known-good project state after transient Git failures;
- bounded and cancellable Git subprocesses;
- bounded concurrent hosted-workbench shutdown.

### Stable readiness: not ready

In addition to the beta blockers, stable readiness requires:

- real-app coverage of hosted-workbench restore, switching, suspend, crash,
  shutdown, and relaunch;
- direct coverage of the largest imperative shell and project-switcher modules;
- explicit management of forked Omni workbench drift across VS Code upgrades;
- reduced or contract-tested duplication between desktop and web lifecycle
  orchestration;
- removal of long-lived retained controller objects after window destruction.

## Architectural strengths worth preserving

### 1. Hucode-owned policy and thin upstream seams

The patch is overwhelmingly additive. Hucode policy generally lives under:

- `src/vs/hucode/`;
- `src/vs/platform/projectManager/`;
- Hucode-named companions beside upstream consumers;
- `build/hucode/`.

This is the correct structure for a long-lived source fork. Upstream changes are
usually imports, service injection, feature checks, or delegation rather than
large inline policy blocks.

### 2. The Omni shell is appropriately custom

A persistent shell hosting multiple full workbenches has no meaningful upstream
VS Code analogue. The decision to use a dedicated shell renderer, normal hosted
workbench bundles, Electron `WebContentsView`s on desktop, and same-origin
iframes on web is justified.

Trying to force Omni into a normal view contribution, editor group, or sessions
shell would increase coupling and violate the product model. The review supports
retaining the custom architecture.

### 3. Shared lifecycle state and pure decision helpers

`HostedWorkspaceStateModel`, retained-workbench helpers, restore planning, and
layout models move important decisions out of platform controllers. Their tests
are among the strongest parts of the Hucode suite.

The model uses explicit lifecycle states, generation counters, and stable path
identity. Several initially suspicious paths were refuted because the state
model and callers already enforce clear invariants.

### 4. Injected platform adapters

Desktop and web controllers expose injected adapters for browsers, persistence,
folder access, native views, and timing. This makes hard lifecycle logic
unit-testable without launching Electron or a browser.

The pattern should be extended to currently uncovered shell and project-switcher
code rather than replaced.

### 5. Product-overlay discipline

Hucode identity is isolated under `build/hucode/mixin/stable/`, while root
`product.json` remains upstream Code OSS. Validation checks both the presence of
Hucode identity and the absence of unintended upstream branding in generated
artifacts.

This is substantially safer than maintaining permanent branding edits across
upstream files.

### 6. Release publication contracts

The release pipeline:

- pins third-party actions;
- scopes permissions per job;
- checks `hucodeVersion` against the tag;
- refuses to mutate an already-published release;
- verifies the remote release asset contract before publication;
- uses a repository-scoped GitHub App token for update-service dispatch.

The remaining release findings are hardening items, not evidence of a weak
pipeline overall.

### 7. Several Hucode deviations improve upstream behavior

Examples include the shared utility-process crash registry and the bounded,
single-flight clipboard permission retry. These deviations are justified by
Hucode's higher process count and lifecycle shape and should be preserved.

# Verified findings

## High severity

### H-01 — Serve-web unload bypasses dirty-workbench vetoes

**Candidate:** C001  
**Origin:** SOL-001  
**Verdict:** confirmed with corrections

The hosted web contribution implements unload preparation by calling the
terminal browser lifecycle operation:

- `src/vs/hucode/browser/hostedOmniWorkspace.web.contribution.ts:126`
- `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts:93`
- `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts:122`
- `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts:158`
- `src/vs/hucode/browser/webShellService.ts:1310`

`BrowserLifecycleService.shutdown()` calls the shutdown path without a veto
handler. Before-shutdown vetoes are computed but discarded. The child therefore
reports that unload is ready even when a working copy says it is not safe to
close.

The data-loss scope is narrower than the initial report suggested. Web autosave
and hot exit protect many working copies. The exposed state is a modified copy
without a completed backup, or a configuration where hot exit is disabled.
Those are precisely the cases where the veto matters, however, and it is
currently ignored.

There is also a second lifecycle problem. `shutdown()` is terminal: it removes
listeners and fires shutdown events. The parent performs further generation
checks after the child reports ready. If one of those checks aborts removal, the
iframe can remain alive after its lifecycle has irreversibly shut down.

**Recommended direction:** introduce a real two-phase hosted-web protocol:

1. veto-capable `beforeUnload` preparation;
2. parent decision;
3. irreversible `willUnload` commit only after removal is guaranteed.

Match the semantics of desktop's before-unload/will-unload split without trying
to reuse the terminal browser shutdown method as a preflight. Add a test using
the production lifecycle-service composition, not only a fake child response.

### H-02 — Five committed Hucode-related suites do not run in CI

**Candidate:** C005  
**Origins:** SOL-005, OPUS-002  
**Verdict:** confirmed; five suites

Hucode CI invokes Electron tests through an explicit list beginning at
`.github/workflows/hucode-ci.yml:343`. The default Node runner excludes browser
and Electron layers at `test/unit/node/index.js:57-64`. When the Electron runner
receives `--run`, it loads only those explicit modules at
`test/unit/electron/renderer.js:163-170`.

The following files are assigned to no active CI runner:

1. `src/vs/hucode/test/browser/omniConfigurationService.test.ts`
2. `src/vs/hucode/test/browser/projectSwitcher/openProjectSwitcherTarget.test.ts`
3. `src/vs/hucode/test/electron-main/omniWorkspaceOpen.test.ts`
4. `src/vs/hucode/test/electron-main/omniWorkspaceReopen.test.ts`
5. `src/vs/workbench/contrib/browserView/test/electron-browser/overlayManager.test.ts`

Sol counted four because its first inventory was limited to `src/vs/hucode`; the
fifth is a Hucode-added suite beside an upstream browser-view integration point.

**Recommended direction:**

- add all five suites to their correct runner immediately;
- replace hand-maintained file enumeration with layer-appropriate Hucode globs,
  or generate the explicit list;
- add a CI completeness check that fails whenever a changed or Hucode-named test
  file is assigned to no runner.

## Medium severity

### M-01 — Serve-web project persistence is not atomic or durably joined

**Candidate:** C002

The serve-web state adapter queues direct writes to the live file:

- `src/vs/server/node/hucodeWebProjectManagerServer.ts:172`
- `src/vs/server/node/hucodeWebProjectManagerServer.ts:189`
- `src/vs/server/node/hucodeWebProjectManagerServer.ts:192`
- `src/vs/server/node/hucodeWebProjectManagerServer.ts:409`

The request path does not await durable completion, writes do not use a temporary
file plus atomic replacement, and failures are logged after callers have already
received success. A close method exists but is only exercised by tests; normal
disposal does not join the queue.

A crash or immediate shutdown can therefore lose an acknowledged mutation or
leave truncated JSON. This affects Hucode project catalog metadata, not Git
repositories or workspace contents.

**Recommended direction:** reuse upstream `FileStorage`/`IStateService`
semantics where practical, or implement atomic replacement, a joined close, and
a clear contract for whether an HTTP success means the mutation is durable.

### M-02 — Transient Git refresh discards last-known-good state

**Candidate:** C003  
**Origins:** SOL-003, OPUS-005

At `src/vs/platform/projectManager/node/projectManagerMainService.ts:603-610`,
any refresh error replaces the current worktree list with `[]` and disposes the
project's metadata watcher.

A transient Git lock, filesystem failure, or subprocess error therefore makes
the UI display an authoritative empty state and removes automatic watcher-driven
recovery. The original reports overstated permanence: the public refresh method
at `projectManagerMainService.ts:381` can recover when explicitly invoked.

**Recommended direction:** preserve the last-known-good snapshot and watcher on
transient failure, represent the project as stale or unavailable, and retry with
bounded backoff. Clear state only when permanent removal is established.

### M-03 — Git subprocesses have no timeout or cancellation policy

**Candidate:** C004

`src/vs/platform/projectManager/node/gitWorktreeService.ts:399` delegates all
process policy to Node's `execFile` defaults. Commands have no timeout, kill,
cancellation, controlled environment, or explicit output-size limit.

The most reachable problem is an unbounded worktree operation that invokes a
credential prompt, filter, or hook. Reference enumeration can also exceed
Node's roughly 1 MiB default output buffer in repositories with several thousand
refs. In-tree precedent exists at
`src/vs/platform/agentHost/node/agentHostGitService.ts:678`, which uses explicit
timeouts and a larger buffer.

**Recommended direction:** define per-operation process policies, disable or
control interactive prompts, support cancellation, kill timed-out children, and
use streaming or an intentional maximum for large ref enumeration.

### M-04 — Forked Omni workbench code has unmanaged drift cost

**Candidate:** C007  
**Origins:** FABLE-001, OPUS-008

The separate Omni workbench is justified, but it implements a broad upstream
contract over a large custom surface:

- `src/vs/hucode/browser/workbench.ts:113`
- `src/vs/hucode/browser/parts/titlebarPart.ts:95`
- `src/vs/hucode/browser/parts/panelPart.ts:39`
- `src/vs/hucode/browser/parts/auxiliaryBarPart.ts:41`

This is not evidence that Omni should be shoehorned into an upstream workbench
contribution. It is a stable-readiness maintenance risk: upstream part and
layout contracts can evolve without a mechanical signal that Hucode's copies
need comparison.

**Recommended direction:** maintain a machine-readable provenance map for each
forked file, record the last synchronized upstream source and baseline, add an
upgrade check that detects source changes, and keep reducing copied code where
delegation is possible.

### M-05 — Desktop and web duplicate lifecycle orchestration policy

**Candidate:** C009

The desktop and web controllers are independently substantial:

- `src/vs/hucode/electron-main/hostedWorkspacesController.ts:153`
- `src/vs/hucode/browser/webShellService.ts:327`
- `docs/hucode/architecture.md:66`

Both implement generation guards, deferred state emission, restoration,
activation, close-next behavior, and shutdown sequencing. The shared state model
is good, but the remaining keep-in-sync requirement is enforced primarily by
documentation.

The initial high severity was not justified: no verified current divergence was
found, and significant platform mechanics are genuinely different.

**Recommended direction:** first create one shared contract-test suite that runs
identical lifecycle scenarios against desktop and web adapters. Extract a common
orchestration skeleton only where those tests demonstrate truly shared policy.
Do not force Electron and iframe mechanics behind an abstraction that merely
hides important differences.

### M-06 — Hosted-workspace shutdown is serial

**Candidate:** C010  
**Origins:** FABLE-003, OPUS-010

Both desktop and web await resident teardown one instance at a time:

- `src/vs/hucode/electron-main/hostedWorkspacesController.ts:1591`
- `src/vs/hucode/browser/webShellService.ts:1007`
- `src/vs/hucode/electron-browser/omni.main.ts:290`

Desktop can wait up to 5 seconds for before-unload and 15 seconds for will-unload
per instance. Multiple unresponsive workbenches can therefore multiply quit
latency while the shell joins the operation into shutdown.

**Recommended direction:** run independent preflight/teardown handshakes
concurrently with an overall deadline. Preserve per-instance veto results and
serialize only native destruction steps that actually require ordering.

### M-07 — No automated real-app hosted-workbench lifecycle coverage

**Candidate:** C018  
**Origins:** FABLE-010, OPUS-016

The controller suite is extensive but uses injected fake windows, views,
webContents, IPC, and browser adapters. The packaged Omni smoke script at
`build/hucode/linux-omni-smoke.ts:222` checks startup and renderer counts but
does not create, switch, suspend, crash, unload, or restore a hosted workbench.
No active workflow invokes the script declared at `package.json:17`.

**Recommended direction:** before stable, automate at least one packaged desktop
scenario that:

1. starts Omni with two workbenches;
2. switches between them;
3. suspends and restores one;
4. terminates a hosted renderer and observes crashed/recovery state;
5. quits and relaunches;
6. verifies the expected active and dormant restore state.

### M-08 — Largest shell modules lack direct behavioral coverage

**Candidate:** C020

Direct coverage is missing for important imperative surfaces, including:

- `src/vs/hucode/browser/projectSwitcher/projectSwitcher.contribution.ts:1044`
- `src/vs/hucode/browser/workbench.ts:806`
- `src/vs/hucode/electron-main/shellMainService.ts`
- the shell Part implementations.

The original high severity was reduced because much of the core decision logic
has already been extracted into tested pure models, and the main resident
controller has broad tests.

**Recommended direction:** extend existing injected-adapter patterns to DOM,
drag/drop, service-wiring, visibility, and multi-window orchestration. Use the
real-app scenario in M-07 for native behavior that should not be duplicated in
unit tests.

### M-09 — Transient state-file errors trigger destructive recovery

**Candidate:** C021

`src/vs/server/node/hucodeWebProjectManagerServer.ts:129-149` uses one catch for
JSON parse errors and non-`ENOENT` filesystem read failures. All are handled by
renaming the primary file to `.corrupt` and starting from empty state.

A transient permission, lock, resource, or sharing error can therefore relocate
valid state. The file is preserved for manual recovery, so this is not literal
deletion, but subsequent mutations can create a new primary state file while
the UI presents an empty catalog.

Upstream's state service at `src/vs/platform/state/node/stateService.ts:52`
logs load failures without relocating the source file.

**Recommended direction:** reserve `.corrupt` preservation for confirmed parse
or schema failure. On I/O failure, leave the primary file untouched, expose a
degraded state, and refuse overwrite until a later read succeeds.

### M-10 — Closed Omni controllers remain retained by the service

**Candidate:** C024

Controllers are registered into the long-lived service `DisposableStore` at
`src/vs/hucode/electron-main/shellMainService.ts:471`. Window destruction at
`shellMainService.ts:92` disposes the controller and removes it from a separate
map, but does not remove the registered object from the store.

`DisposableStore` retains registered entries in a `Set` until clear, delete, or
dispose (`src/vs/base/common/lifecycle.ts:420`, `:481`). Repeated Omni window
open/close cycles therefore retain one disposed controller object per window for
the main-process lifetime.

**Recommended direction:** use a `DisposableMap` keyed by window id or register
a disposable wrapper that removes itself. Confirm the retained heap size with a
main-process profile after the structural fix.

## Low-severity hardening and maintainability

| ID | Summary | Key evidence |
| --- | --- | --- |
| L-01 / C006 | Update-service dispatch has no retry or convergence check after release publication. The failure is visible and recoverable. | `.github/workflows/hucode-release-build.yml:1383`, `:1409` |
| L-02 / C008 | Omni silently ignores requests to show unsupported shell panel/auxiliary parts. | `src/vs/hucode/browser/workbench.ts:1011`, `:1052`, `:1086` |
| L-03 / C012 | `windowsMainService.ts` imports from `src/vs/hucode` despite the documented layering rule, but the import is lint-allow-listed and creates no cycle. | `src/vs/platform/windows/electron-main/windowsMainService.ts:43`, `eslint.config.js:1601` |
| L-04 / C013 | Web reload and connection teardown rely on timers rather than acknowledgements. Timeouts fail closed, so the verified consequence is redundant reload/refused close behavior on slow links. | `src/vs/hucode/browser/webShellService.ts:966`, `:1110`, `:1318` |
| L-05 / C015 | The 3,193-line project-switcher contribution combines 24 anonymous actions, view logic, tree wiring, and constants. | `src/vs/hucode/browser/projectSwitcher/projectSwitcher.contribution.ts:1` |
| L-06 / C016 | Command-forwarding suppression is module-global mutable state. It is currently safe because only one forwarding surface uses it. | `src/vs/platform/window/common/hucodeOmniCommandRouting.ts:68` |
| L-07 / C017 | Lazy IPC events depend on ProxyChannel enumeration internals. A real integration tripwire already exists; add the dependency to the upgrade checklist. | `src/vs/base/parts/ipc/common/hucodeLazyEventService.ts:16`, `src/vs/base/parts/ipc/test/common/hucodeLazyEventService.test.ts:39` |
| L-08 / C019 | Serve-web bypasses UI validation and allows a worktree `startPoint` to be interpreted as a Git option. This is a privileged-client correctness issue, not shell injection. | `src/vs/server/node/hucodeWebProjectManagerServer.ts:481`, `src/vs/platform/projectManager/node/gitWorktreeService.ts:156`, `:188` |
| L-09 / C022 | Clipboard forwarding prevents the native event before knowing whether forwarding succeeded. | `src/vs/workbench/electron-browser/hucodeOmniCommandForwarding.ts:263` |
| L-10 / C023 | Projects SSE lacks a client cap and backpressure handling. Production close cleanup is valid, and no permanent reconnect failure was established. | `src/vs/server/node/hucodeWebProjectManagerServer.ts:582`, `:612` |
| L-11 / C025 | OpenVSX selection is tied to the canonical hostname and one error mapping depends on diagnostic text. Current Hucode configuration is covered and verification fails closed. | `src/vs/platform/extensionManagement/node/hucodeOpenVsxExtensionSignatureVerifier.ts:129`, `:178` |
| L-12 / C028 | Hosted request routing supplements a typed process allowlist with an undocumented optional Electron `webContentsId`. This is an upgrade seam, not a verified trust bypass. | `src/vs/code/electron-main/app.ts:393`, `:427` |
| L-13 / C029 | Browser-view layout performs two tree walks and a z-order reinsertion per layout. Keep as a profiling candidate; material cost is unproven. | `src/vs/platform/browserView/electron-main/browserViewNativeHost.ts:122`, `:199`, `:232` |
| L-14 / C034 | `SHA256SUMS` is published without a detached signature or provenance attestation. GitHub delivery and platform signing limit practical exposure. | `build/hucode/release-assets.ts:120`, `.github/workflows/hucode-release-build.yml:1347` |

## VS Code architectural alignment

### Appropriately aligned

Hucode generally follows VS Code conventions in the areas where those
conventions fit:

- dependency-injected services;
- `common` versus platform-specific implementation layers;
- contribution and registration mechanisms;
- cancellation and disposable ownership in most long-lived services;
- project service separation from renderer adapters;
- typed IPC contracts;
- Hucode-named helpers at upstream integration seams;
- tests near the layer they exercise.

### Justified custom architecture

The following should remain Hucode-specific:

- the Omni shell renderer;
- hosted-workbench lifecycle controllers;
- the shared hosted-workspace state model;
- the Projects surface and retained-workbench catalog;
- Electron view ownership and web iframe adapters;
- shell-to-hosted-workbench command routing.

There is no upstream system with sufficiently similar requirements to justify
replacing these with stock workbench contributions or editor abstractions.

### Areas where upstream patterns should be reused or adapted

1. **State durability:** serve-web project persistence should reuse or match
   upstream state-storage atomicity and close semantics.
2. **State-load failures:** transient I/O errors should follow upstream's
   non-destructive logging/retry behavior rather than corruption recovery.
3. **Process policy:** project Git execution should adopt the explicit timeout
   and buffer discipline already used by Hucode's in-tree AgentHost Git service.
4. **Shutdown fan-out:** multiple independent workbench shutdown operations
   should use bounded concurrency, as upstream multi-window shutdown paths do.
5. **Disposable ownership:** per-window controllers should use a keyed disposable
   structure rather than permanent registration in a service-lifetime store.

### Areas where alignment would be harmful

- Replacing Omni with a normal workbench contribution.
- Forcing desktop `WebContentsView` mechanics and web iframe mechanics into one
  undifferentiated adapter.
- Reusing editor-centric panel/sidebar behavior inside the outer shell.
- Removing Hucode-specific platform services merely to reduce file count.

The correct goal is a small, explicit Hucode architecture that integrates using
VS Code conventions—not eliminating all custom architecture.

## Cross-cutting themes

### 1. Failures are sometimes rendered as valid empty state

Project refresh and state-file failures can produce an empty project/worktree
view that looks authoritative. Reliability would improve if degraded states
were typed and surfaced rather than converted into empty success.

### 2. Lifecycle preflight and lifecycle commit need stronger separation

The high-severity web unload issue is the clearest example. Timer-based reload
coordination and serial shutdown are related symptoms: the architecture needs
explicit preparation, decision, commitment, and settlement boundaries.

### 3. Tests are stronger at pure-model boundaries than integration boundaries

The extracted models and injected controllers have good focused tests. Gaps
concentrate in:

- production service composition;
- shell DOM and contribution wiring;
- native Electron behavior;
- packaged application lifecycle;
- CI assignment completeness.

### 4. The fork strategy is sound but needs mechanical drift detection

Repository documentation correctly emphasizes thin seams and replay branches.
The remaining upgrade burden comes from intentional copies and undocumented
external contracts. Provenance metadata, targeted upgrade checks, and
integration tripwires should convert those risks into loud failures.

### 5. Several original findings were plausible but too severe

Adversarial verification materially improved the result. Examples:

- worktree argument handling is not shell command injection;
- missing `Origin` is not a separate authentication bypass;
- the Electron trust field supplements a typed allowlist rather than replacing
  it;
- reload timers are state-guarded;
- Ctrl+V is not blocked on Linux/Windows;
- configuration changes correctly apply to the next restore;
- the state-model replacement branch is intentional and tested.

This is why the final report should be used instead of any individual raw
review.

## Remediation roadmap

### Phase 0 — beta blockers

1. Replace web `shutdown()` preflight with a two-phase, veto-capable unload
   protocol.
2. Add a production-composition regression test for dirty/unbacked-up hosted web
   workbenches and parent-side abort after preparation.
3. Assign all five omitted suites to CI.
4. Add a machine-checked CI test-inventory completeness rule.

### Phase 1 — reliability and state safety

1. Make serve-web project persistence atomic and joinable.
2. Separate parse corruption from transient read failures.
3. Preserve last-known-good worktrees and watchers after transient Git failure.
4. Add per-operation Git timeout, cancellation, environment, and buffer policy.
5. Run hosted-workbench shutdown concurrently under a bounded total deadline.
6. Remove destroyed controllers from the service's disposable ownership set.

### Phase 2 — stable-level verification

1. Put the existing Linux Omni smoke script into CI.
2. Extend it into a real hosted-workbench lifecycle scenario.
3. Add direct coverage for project-switcher UI/glue, shell workbench wiring,
   shell main service, and Part implementations.
4. Run shared lifecycle contract tests against both desktop and web adapters.

### Phase 3 — upgrade sustainability

1. Add a provenance and last-synced-baseline map for forked Omni workbench files.
2. Make the upgrade skill fail or warn when relevant upstream source changes.
3. Record ProxyChannel lazy-event discovery as an explicit upgrade dependency.
4. Reconcile the documented layering rule with the lint allow-list and actual
   windows-main integration strategy.

### Phase 4 — lower-priority hardening

Address low-severity timer protocol, release retry, alternate OpenVSX,
clipboard-failure, SSE flow-control, layout diagnostics, and release-attestation
items as appropriate to product scope.

## Refuted or out-of-scope candidates

The following were excluded from the final findings:

| Candidate | Result |
| --- | --- |
| C011 | Web teardown does not rewrite persisted recency because persistence is guarded by `shuttingDown`; an existing test pins it. |
| C014 | The uncancelled reload timer is state-guarded and cannot reload a removed or settled instance. |
| C026 | Origin-less requests follow the configured connection-token policy; this is not a separate authentication bypass. |
| C027 | Non-graceful controller disposal performs its teardown synchronously despite returning a settled Promise. |
| C030 | The restore setting intentionally applies to the next restoration, not live resident-set mutation. |
| C031 | All current callers of `sendToWorkspace` require activation or already target the active instance. |
| C032 | Only Meta+V is specially rerouted; ordinary Ctrl+V remains in the hosted renderer path. |
| C033 | Stale-window no-op versus rejection behavior reflects intentional lifecycle-specific contracts. |
| C035 | Keychain restoration matters only for unsupported persistent/self-hosted CI mode; current release jobs use ephemeral GitHub-hosted runners. |
| C036 | Normalized-path replacement is an intentional, tested state-model contract, and current callers dispose or reuse existing instances. |

## Verification and residual risk

### Completed verification

- Exact model identities were confirmed from session or CLI metadata.
- All reviewer and verifier JSON artifacts pass a dependency-free local schema
  validator.
- Candidate overlap and provenance are preserved in
  `candidate-matrix.final.json`.
- A scratch Git reproduction confirmed option reinterpretation through
  `startPoint`.
- The focused release-assets test passed during verification.
- Static CI assignment analysis confirmed all five omitted suites.

### Verification not completed

- Full TypeScript compilation.
- Full Hucode unit-test matrix.
- Packaged desktop Omni smoke test.
- Serve-web runtime unload reproduction with a dirty working copy.
- Shutdown timing with several deliberately stalled workbenches.
- Main-process heap profiling after repeated Omni window cycles.
- Browser-view layout profiling.

Root dependencies are currently absent, and precommit fails while resolving
`event-stream`. This limits runtime confidence but does not invalidate the
source-level findings above.

## Final recommendation

Do not redesign Omni wholesale. The major architectural decisions are sound.
Focus the next hardening cycle on lifecycle correctness, persistence durability,
CI truthfulness, and integration coverage.

A reasonable maturity gate would be:

### Before beta

- H-01 and H-02 resolved and covered;
- M-01, M-02, M-03, M-06, and M-09 either resolved or explicitly accepted with
  mitigations;
- the full Hucode test inventory running in CI.

### Before stable

- all medium findings resolved or accepted through documented constraints;
- at least one automated packaged-app hosted-workbench lifecycle scenario;
- desktop/web shared lifecycle contract tests;
- forked Omni workbench provenance and upgrade drift checks.

With those changes, Hucode would move from a well-designed but incompletely
hardened fork to a codebase with credible beta—and eventually stable—quality.

## Artifact index

- `review-brief.md` — baseline, scope, and rubric.
- `sol/report.md`, `sol/findings.json` — independent Sol review.
- `fable/report.md`, `fable/findings.json` — independent Fable architecture
  review.
- `opus/report.md`, `opus/findings.json` — independent Opus review.
- `candidate-matrix.md` — human-readable verified candidate matrix.
- `candidate-matrix.final.json` — complete deduplication and verification data.
- `verification/` — cross-review verdicts and evidence.
- `validate_artifacts.py` — dependency-free artifact schema validator.
