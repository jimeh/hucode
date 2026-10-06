# Verified Candidate Matrix

- Raw findings: 40
- Deduplicated candidates: 36
- Surviving candidates: 26
- Rejected or out of scope: 10

| ID | Sources | Verdict | Severity | Candidate |
| --- | --- | --- | --- | --- |
| C001 | SOL-001 | confirmed-with-changes | high | prepareUnload uses terminal BrowserLifecycleService.shutdown() as an unload preflight, so hosted-workbench vetoes are ignored and the iframe is removed regardless. Loss is limited to modified working copies without backups (hot exit off or backup pending) rather than all unsaved edits; additionally, shutdown() is irreversible, so any unload that is later aborted by the parent's generation check leaves a live workbench with a shut-down lifecycle. |
| C002 | SOL-002 | confirmed | medium | Serve-web project persistence lacks durable atomic commits |
| C003 | SOL-003, OPUS-005 | confirmed-with-changes | medium | A transient Git refresh failure discards the last-known-good worktree list and disables automatic watcher-driven recovery until an explicit refresh succeeds. |
| C004 | SOL-004 | confirmed-with-changes | medium | GitWorktreeService.execGit delegates all subprocess resource policy to Node execFile defaults, so no Git command has a timeout, kill, cancellation, or environment policy, and none can exceed the ~1 MiB default output buffer. The unbounded/uncancellable child process is the primary reachable risk; the buffer ceiling additionally breaks reference selection only on repositories with roughly 5k+ refs, and does so with a visible error rather than silent truncation. |
| C005 | SOL-005, OPUS-002 | confirmed-with-changes | high | Five committed Hucode-related suites are not assigned to any active CI runner, and CI has no completeness guard to detect future omissions. |
| C006 | SOL-006 | confirmed-with-changes | low | Publication and update-metadata refresh are two non-atomic steps with the release published first and no verification of convergence. The window is real but the failure is visible as a failed workflow job and is self-healing on retry; the actionable gap is the missing retry/alerting on the dispatch step, not the ordering itself. |
| C007 | FABLE-001, OPUS-008 | confirmed-with-changes | medium | The intentionally forked Omni workbench and parts create a medium stable-readiness upgrade and regression-testing burden; current evidence does not establish a high-severity defect or show that the separate shell architecture is avoidable. |
| C008 | OPUS-008 | confirmed-with-changes | low | Omni deliberately implements show requests for unsupported shell parts as silent no-ops; this is a low-severity API/diagnostic mismatch, not an established medium-severity layout failure. |
| C009 | FABLE-002 | confirmed-with-changes | medium | Desktop and web hosted-workbench orchestration policy is implemented twice with the shared invariant recorded only in prose. This is a maintainability and drift risk (medium), not a high-severity finding: no realized divergence survives verification, and part of the apparent duplication is irreducible platform mechanics. |
| C010 | FABLE-003, OPUS-010 | confirmed | medium | Serial hosted-workspace shutdown multiplies quit latency |
| C011 | FABLE-004 | refuted | none | Web shutdown may reactivate workspaces and rewrite recency |
| C012 | FABLE-005 | confirmed-with-changes | low | windowsMainService.ts imports three modules from src/vs/hucode/electron-main, contradicting the architecture doc's stated rule. The deviation is explicitly allow-listed in eslint.config.js and creates no layer cycle, and relocating the helpers would not materially reduce the upgrade conflict surface in windowsMainService.ts — so this is a low-severity doctrine/config inconsistency, not a structural architecture defect. |
| C013 | FABLE-006 | confirmed-with-changes | low | The web shell coordinates reload and connection teardown with fixed timers instead of protocol acknowledgements. The fallback is self-cancelling and the unload timeout fails closed (refuses the close rather than removing the workbench), so the consequence is redundant reloads and refused closes on slow links, not lost hot-exit state. |
| C014 | OPUS-021 | refuted | none | The timer is not cancelled, but current state transitions prevent it from reloading a removed or settled instance; cancellation would be cleanup hardening only. |
| C015 | FABLE-007 | confirmed-with-changes | low | projectSwitcher.contribution.ts is 3193 lines with 24 anonymous Action2 registrations plus view, tree, and constant definitions in one module. Real maintainability cost with no runtime risk; severity low. |
| C016 | FABLE-008 | confirmed | low | Command-forwarding suppression uses module-global mutable state |
| C017 | FABLE-009 | confirmed-with-changes | low | hucodeCreateLazyEventService depends on ProxyChannel's undocumented enumeration-based event discovery, so upstream changes there can disable the laziness. However, the recommended integration tripwire already exists: the unit test round-trips through the real ProxyChannel.fromService and asserts zero eager subscriptions, so such a regression would fail a test rather than pass silently. Only the upgrade-checklist entry remains outstanding. |
| C018 | FABLE-010, OPUS-016 | confirmed | medium | No automated real-app hosted-workbench lifecycle coverage |
| C019 | OPUS-001 | confirmed-with-changes | low | Serve-web bypasses UI validation and permits Git option reinterpretation through startPoint, but this is a low-severity privileged-API correctness issue rather than shell injection or unauthenticated arbitrary command execution. |
| C020 | OPUS-003 | confirmed-with-changes | medium | Direct tests are missing for the largest Omni renderer and shell orchestration classes, but core lifecycle and pure decision logic have substantial extracted coverage; the remaining gap is medium, not high. |
| C021 | OPUS-004 | confirmed | medium | Transient state-file read errors trigger destructive corruption handling |
| C022 | OPUS-006 | confirmed-with-changes | low | Failed forwarding is silently unrecoverable after preventDefault, but current source supports a low-severity failure-handling gap rather than a demonstrated high-frequency clipboard outage. |
| C023 | OPUS-007 | confirmed-with-changes | low | The production endpoint lacks caps and backpressure handling, but its close cleanup is reachable and missing keep-alives do not prove permanent update loss; severity is low pending load evidence. |
| C024 | OPUS-009 | confirmed | medium | Disposed hosted controllers remain retained by the service |
| C025 | OPUS-011 | confirmed-with-changes | low | Exact-host verifier selection and text-based error classification are brittle for alternate OpenVSX deployments and dependency diagnostic changes, but current Hucode configuration is covered and failures block installation rather than weakening signature enforcement. |
| C026 | OPUS-012 | refuted | none | The endpoint accepts Origin-less non-browser requests under the server's configured authentication policy; this is not an Origin-check bypass or standalone security defect. |
| C027 | OPUS-013 | refuted | none | dispose discards an already-synchronous non-graceful teardown Promise; there is no current asynchronous lifecycle race, only a possible unobserved-exception hardening opportunity. |
| C028 | OPUS-014 | confirmed-with-changes | low | An undocumented optional Electron field supplements a typed process-id allowlist, creating a low-severity upgrade seam rather than an established trust bypass. |
| C029 | OPUS-015 | plausible | low | The layout path repeats two traversals, but realistic cost is unproven and likely shallow; retain as a low-severity profiling candidate. |
| C030 | OPUS-017 | refuted | none | Configuration changes intentionally affect the next hosted-workbench restoration; the policy is not specified or implemented as a live resident-set mutation. |
| C031 | OPUS-018 | refuted | none | Activation is bundled into a private visible-workspace dispatch helper, and all current callers either target or already use the active workspace. |
| C032 | OPUS-019 | refuted | none | Only Meta+V is specially rerouted; Ctrl+V is deliberately left to the hosted renderer rather than being blocked. |
| C033 | OPUS-020 | refuted | none | Late lifecycle callbacks no-op while ordinary commands reject invalid targets; the distinction is intentional and appropriate to teardown races. |
| C034 | OPUS-022 | confirmed | low | Release checksums are published without independent authenticity |
| C035 | OPUS-023 | out-of-scope | none | CI mode intentionally replaces keychain state on ephemeral GitHub-hosted runners; the supported local mode preserves caller state. Missing restoration matters only for currently unsupported persistent-runner or local-CI-mode use. |
| C036 | OPUS-024 | refuted | none | The model intentionally and testably resolves normalized path collisions; current controllers uphold the lifecycle invariant before insertion. |

## Rejected or out-of-scope candidates

### C011 — Web shutdown may reactivate workspaces and rewrite recency

The guard the finding predicted might exist in the unread portion of the file does exist, in exactly the place that matters. removeInstance and activateInstance do indeed lack a shuttingDown check and do mutate in-memory lastActiveAt and the retained catalog during teardown — that part of the reading is accurate. But the retained catalog and resident set are persisted through exactly one call site, persistence.save inside emitState, and that call is wrapped in `if (!this.shuttingDown)`. shutdownWindowWorkspaces sets shuttingDown = true before the teardown loop and it is never reset, so no emitState during or after teardown can write. The material consequence — 'next session restores with C treated as most recently active' — therefore cannot occur: the persisted snapshot is the one written before shutdown began. This is not inference: an existing test asserts it directly by deep-comparing the persistence state before and after shutdownWindowWorkspaces. The residual is purely in-memory churn during teardown (redundant activations and iframe visibility toggles on instances about to be destroyed), which has no observable effect.

### C014 — Reload fallback timer is not cancelled on removal

The 500-millisecond handle is not retained, but the claimed stale reload does not follow. The callback reloads only while the same instance remains in loading state and still has an iframe. Removal first changes the instance state to unloaded, and successful or failed command completion also leaves loading. The discarded timer retains a small object for at most 500 milliseconds but is guarded against the reported effect.

### C026 — Projects API permits state changes without an Origin header

Origin-less requests are accepted, but Origin is a browser CSRF signal rather than authentication for arbitrary non-browser clients. In normal deployments the outer server validates the connection token first. In explicitly token-disabled deployments, accepting unauthenticated non-browser requests is the selected server mode, not a bypass caused by the missing Origin header. Browser cross-origin JSON mutations require a preflight, while simple POST content types are rejected. Requiring Origin would also reject legitimate non-browser callers without creating an authentication boundary.

### C027 — Synchronous controller disposal launches unobserved async teardown

dispose does discard a Promise, but it calls destroyInstance with graceful=false. That path skips the only awaited renderer handshake and executes all teardown synchronously before the async function returns its already-settled Promise. Browser-view destruction, trust removal, view closing, URL disposal, and map removal are synchronous APIs here. The claimed in-flight teardown race therefore does not occur. A synchronous exception would become an unobserved rejected Promise, which is a narrower defensive concern not demonstrated by current code.

### C030 — Hosted restore policy does not react to configuration changes

The setting controls which persisted workbenches are restored immediately during startup; it is not a live policy for unloading or loading the current resident set. The desktop controller accepts policy changes only before restoration begins, and later pushes are intentionally ignored. A configuration subscription after startup would therefore have no effect without redefining the setting. New windows/controllers read the current configuration, so the next restore uses the changed value as described.

### C031 — Workspace message dispatch activates its target implicitly

sendToWorkspace does activate and focus its target, but every current caller requires that behavior. Targeted openFiles first opens/activates the requested workspace; active-workspace openFiles passes the already active instance; action and keybinding forwarding resolve the active instance before dispatch. The helper is private, and there is no current passive-message caller whose target unexpectedly changes. Renaming or parameterizing it could clarify intent but would be speculative hardening.

### C032 — Hosted paste detection uses the macOS modifier on every platform

The special interception is indeed limited to unmodified Meta+V, but the reported Linux/Windows paste failure does not follow. The before-input-event listener prevents default only when isPasteKeyDown returns true. Ctrl+V returns false and therefore continues into the hosted renderer's normal input path. The source and focused test describe a macOS-style native-paste reroute, not a cross-platform replacement for all paste handling.

### C033 — Shell IPC methods disagree on stale-window behavior

The different stale-window behaviors correspond to different lifecycle contracts. Normal state-mutating/query IPC uses getOrCreateController and rejects a non-Omni or destroyed window id. Late readiness notifications and shutdown cleanup use controllers.get and no-op because they can legitimately race teardown and must not recreate a controller. Treating these as one uniform contract would make lifecycle cleanup less safe, not more consistent.

### C035 — macOS signing does not restore the previous keychain list

The implementation does replace the default keychain and user search list in CI mode and deletes the temporary keychain without restoring prior values. The claimed hazard, however, requires a persistent or self-hosted runner. The release matrix uses standard GitHub-hosted macOS runners, repository policy says Hucode workflows should use GitHub-hosted runners by default, and local signing mode is explicitly required not to change the caller's keychain configuration. Restoration would be prudent hardening if reusable runners or CI mode on developer hosts become supported, but it is not a defect in the stated current release scope.

### C036 — Hosted state model silently evicts an impossible duplicate

The replacement branch is not an accidental unreachable leak path; the state-model test explicitly defines normalized path collisions as last-instance-wins and verifies index consistency. Current production callers also guard, reuse, or remove an existing same-path instance before insertion. Replacing the behavior with an assertion would change a tested defensive model contract. There is no current undisposed duplicate and no concrete defect.

