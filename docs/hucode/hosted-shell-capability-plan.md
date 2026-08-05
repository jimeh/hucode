---
title: Hosted Shell Capability Plan
status: proposed
last_updated: 2026-08-05
---

# Hosted Shell Capability Plan

## Document purpose

This document plans a least-authority boundary between Hucode's Omni shell and
hosted workbenches on desktop and serve-web. It records the current exposure,
the proposed shared capability contract, the platform-specific transports, a
reviewable migration sequence, and the evidence required before the legacy
desktop channel can be removed.

The plan is intentionally implementation-oriented so delivery can be reviewed
against an explicit contract instead of reconstructing architectural decisions
from chat history.

## Scope

This plan covers:

- restricting what a desktop hosted workbench can ask the Omni shell to do;
- replacing caller-supplied window and instance identity with identity bound
  to an authenticated connection;
- sharing the hosted capability policy, facade, and client between desktop and
  serve-web;
- separating the privileged desktop shell renderer from hosted and ordinary
  workbench renderers;
- removing the complete shell service from the global desktop renderer
  channel; and
- testing the authority boundary, connection lifecycle, and existing user
  behavior.

This plan deliberately does **not** cover:

- theme preview synchronization;
- new Omni features or shell actions;
- redesigning native menu, keybinding, clipboard, or paste forwarding from the
  shell to the active hosted workbench, except where those calls must move to a
  privileged shell connection;
- reimplementing the existing serve-web parent/iframe trust handshake; or
- changing project ownership or catalog reconciliation semantics.

## Independent review corrections

An independent Claude architecture review checked this plan against the
current desktop and web call sites. The following corrections are incorporated
as settled requirements before implementation begins:

- hosted paste is a hosted-to-shell request today and needs a self-scoped
  hosted capability; it must not be moved exclusively to the privileged shell
  connection;
- the privileged shell sometimes performs path-scoped operations across Omni
  windows, notably Open Selected in New Window, so the shell capability needs
  a high-level cross-window operation without accepting arbitrary target
  window or instance IDs;
- hosted navigation must preserve project targeting, normal-window fallback,
  latest-activation-intent supersession, and active/visible caller checks;
- web file-open methods are exposed today but have no confirmed hosted caller;
  audit them and omit them from the new hosted capability unless a real caller
  is demonstrated;
- ordinary desktop workbench dependency injection must remain constructible
  after the global shell service registration is removed;
- the first hardening stage must preserve the legacy serve-web wire shape for
  cached children, with protocol negotiation introduced in the next stage;
- desktop port startup needs an explicit deferred-connection state and must not
  fall back to the broad channel while the port is pending;
- screenshot self-targeting is an intentional semantic change that requires
  characterization and regression coverage; and
- the existing web unload protocol version and the new hosted capability
  protocol version remain separate until there is a demonstrated reason to
  combine them.

## Executive decision

Replace the single renderer-visible `IHucodeShellService` with capabilities
issued according to renderer role:

| Capability | Recipient | Authority |
| --- | --- | --- |
| Shell controller | Exact desktop Omni shell renderer | Administer that shell window and its hosted workbenches |
| Hosted shell | Exact hosted workbench instance | Inspect minimal self-related state, control itself, and request a closed set of shell UI actions |
| Omni open broker | Ordinary trusted workbenches, only if still required | Ask Hucode to open or focus a folder through a high-level operation |
| Shell main service | Main process only | Own the complete controller implementation and authoritative state |

The hosted capability contract and policy will be shared. Desktop and web will
continue to use different connection bootstraps because their trust roots are
different.

The complete desktop improvement is not merely an allowlist on
`runActionInShell`. The global `hucodeShell` channel exposes many privileged
methods, so it must ultimately be removed or reduced to a separately justified
safe broker.

## Current architecture

### Common service

`src/vs/hucode/common/omniWindow.ts` defines `IHucodeShellService`, a single
contract containing several distinct classes of operation:

- shell state reads and mutations;
- hosted workbench creation, activation, suspension, dismissal, and ordering;
- complete project-catalog reconciliation;
- hosted self-lifecycle operations;
- shell-to-workspace native command routing;
- hosted-to-shell action routing;
- layout, overlay, screenshot, devtools, and shutdown operations.

The contract is convenient for implementations but does not express which
caller is allowed to perform which operation.

### Desktop

The main process registers the complete service through
`ProxyChannel.fromService` as the global `hucodeShell` channel. Desktop
workbenches register a renderer-side proxy for that channel.

Electron's validated IPC checks are meaningful mitigation: requests must come
from a VS Code-authority main frame. They prevent arbitrary embedded web
content from using the channel directly. They do not, however, distinguish
these trusted renderer roles:

- the privileged Omni shell renderer;
- one of the shell's hosted `WebContentsView` renderers; or
- an ordinary Hucode workbench renderer.

The generic proxy invokes the requested service method and does not apply a
role-specific facade. Hosted views also inherit the owner window ID, so the
normal IPC context is not an authoritative hosted-instance identity.

For `runActionInShell`, the current path is:

```text
hosted renderer
  -> global hucodeShell proxy
  -> HucodeShellMainService.runActionInShell(windowId, request)
  -> HostedWorkspacesController.runActionInShell(request)
  -> shell renderer vscode:runAction message
```

The controller currently accepts an arbitrary command ID and argument array.
Delivery is fire-and-forget: success means the message was sent, not that the
shell command completed successfully.

The main process already tracks trusted hosted process and `webContents` IDs
for file and webview request filtering. That mapping is the right trust root
for a hosted desktop capability, but the global generic proxy does not expose
the authoritative sender to the service method.

### Serve-web

Serve-web has a stronger hosted boundary. The shell establishes a dedicated
`MessagePort` for an iframe instance and exposes an explicit facade over that
port. The facade binds window and instance identity on the server side and
allows only a subset of the complete service.

Hosted shell actions are also checked against an explicit list. This is the
correct trust shape, but the current web implementation still has avoidable
duplication and misleading types:

- the facade is a local `Pick<IHucodeShellService, ...>` rather than a named
  shared capability contract;
- the hosted web client implements the complete service even though the port
  exposes only a subset;
- action authorization is web-local; and
- allowed calls retain the arbitrary command request shape, including caller
  arguments, even though current actions do not require arguments.

### Actual hosted-to-shell needs

The current hosted contributions require a much smaller surface than the
complete shell service:

- observe enough state to know whether the calling instance is active and
  visible and to render Projects navigation affordances;
- notify the shell when the calling workbench is ready;
- close, reload, focus, or reopen the calling instance;
- focus the shell;
- request Projects focus, sidebar toggle, add, refresh, collapse, back, and
  forward actions;
- open or focus a folder through the Omni routing policy; and
- capture the calling desktop hosted view for the existing screenshot
  fallback.

Hosted workbenches do not need complete catalog authority, arbitrary retained
workbench mutation, other instance identities, shell layout control,
shell-wide shutdown, or arbitrary shell command execution.

## Risk framing

This is a least-authority and defense-in-depth issue, not evidence that
arbitrary internet content can currently execute shell commands. Origin,
main-frame, and sandbox boundaries still matter.

The concrete weakness is that a compromised or unintentionally misbehaving
trusted renderer receives substantially more authority than its role requires.
The API also makes future mistakes easy: any newly added method becomes
renderer-visible automatically unless each implementation remembers to add a
separate check.

The target architecture makes authority explicit in types and connection
construction, so widening a capability becomes a deliberate, reviewable
change.

## Target architecture

```mermaid
flowchart LR
    subgraph Desktop
        DS["Omni shell renderer"] -->|"bound privileged port"| DM["Main-process shell authority"]
        DH["Hosted workbench renderer"] -->|"bound instance port"| DM
        DN["Ordinary workbench renderer"] -->|"optional narrow open broker"| DM
    end

    subgraph Web
        WS["Omni shell controller"]
        WH["Hosted iframe"] -->|"existing trusted MessagePort"| WS
    end

    HC["Shared hosted contract, facade, policy, and client"]
    DH --- HC
    WH --- HC
```

### 1. Internal shell authority

Keep a complete main-process implementation for desktop controller ownership,
but stop exposing it as a generic renderer service. It may retain a broad
interface internally because its caller is trusted main-process code.

### 2. Privileged shell controller capability

The desktop shell renderer needs broad, window-scoped control for project
switching, native action forwarding, hosted view layout, overlays, screenshots,
devtools, and shutdown.

Issue this capability only to the exact `BrowserWindow.webContents` registered
as the Omni shell owner. Bind the window ID to the port so methods do not take a
caller-selected `windowId`.

Binding the owner window does not mean every privileged operation is confined
to that window. Existing shell UI can intentionally move a path out of whichever
Omni window currently owns it. Represent such behavior as a high-level,
path-scoped operation such as `openSelectionInStandaloneWindow(selection)`.
Main resolves the current owner and applies the cross-window close itself; the
shell renderer does not submit another window or instance identity.

Serve-web does not require an equivalent remote privileged port: its shell
controller and shell UI already share the trusted parent page.

### 3. Hosted shell capability

Add a common service such as `IHucodeHostedShellService`. Its methods must not
accept window IDs, instance IDs, arbitrary shell command IDs, or complete
project catalogs.

An illustrative contract is:

```ts
interface IHucodeHostedShellService {
	readonly onDidChangeState: Event<IHucodeHostedShellState>;

	getState(): Promise<IHucodeHostedShellState>;
	notifyReady(): Promise<IHucodeHostedReadyResult>;
	closeSelf(): Promise<IHucodeHostedCloseResult>;
	reopenSelfInNormalWindow(): Promise<boolean>;
	reloadSelf(): Promise<void>;
	focusSelf(): Promise<void>;
	focusShell(): Promise<void>;
	requestShellAction(action: HucodeHostedShellAction): Promise<boolean>;
	navigateToFolder(
		request: IHucodeHostedNavigationRequest
	): Promise<IHucodeHostedNavigationResult>;
	triggerPasteInSelf(): Promise<boolean>;
	captureSelfScreenshot(
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
}
```

The exact return types should describe observable protocol outcomes rather
than leaking the complete controller state.

### 4. Optional ordinary-workbench broker

Some non-shell workbench integration may still need to ask whether a path is
already hosted or to open it in Omni. Preserve that product behavior through a
small application-level broker rather than the complete shell controller.

Prefer one high-level operation, such as `navigateToFolderInOmni`, over a
sequence of low-level discovery, focus, open, and activate calls. The
authoritative side can then resolve project ownership, normal-window fallback,
target window, and activation atomically while preserving the current latest
activation intent.

If the final call-site audit proves ordinary workbenches do not need this
broker, omit it.

## Shared hosted capability contract

### Semantic shell actions

Replace arbitrary shell command requests with a closed semantic union:

```ts
type HucodeHostedShellAction =
	| 'toggleProjectsSidebar'
	| 'addProject'
	| 'refreshProjects'
	| 'collapseProjects'
	| 'navigateBack'
	| 'navigateForward';
```

The authoritative facade maps these values to concrete command IDs and builds
the invocation request itself. Hosted callers cannot provide command IDs,
arguments, or `from` metadata.

The current `runActionInShell` census is exactly these six actions. Focus
Projects is deliberately outside this union: serve-web already routes it
through the dedicated `focusShell` capability rather than the generic action
wire. Keep that distinction explicit so a lifecycle/focus operation cannot
silently broaden the hosted action policy.

Do not reuse `isHucodeOmniShellAction` as the authorization check. That helper
contains namespace-prefix routing intended for trusted local command routing;
it is not a closed security policy. Adding a new routed shell command must not
silently grant it to hosted workbenches.

### State projection

Define a minimal hosted projection, expected to contain only:

- Projects sidebar visibility;
- Projects back and forward availability;
- the calling instance's lifecycle state;
- whether the calling instance is active and visible; and
- any coarse availability flag demonstrably required by existing titlebar
  behavior.

Do not expose:

- other instance IDs or paths;
- process or `webContents` IDs;
- complete project catalogs;
- retained workbench records; or
- controller generations unrelated to protocol freshness.

`notifyReady` should return enough information for readiness retry and
verification so the hosted client does not need to inspect the full window
state afterward.

### Bound facade

Build one platform-neutral facade factory around an authoritative delegate:

```ts
createBoundHostedShellFacade({
	windowId,
	instanceId,
	connectionGeneration,
}, delegate);
```

The binding is captured in the closure and never reconstructed from caller
arguments. The facade owns:

- method exposure;
- action validation and mapping;
- state projection and event filtering;
- self-targeting;
- active/visible policy for shell UI actions, navigation, paste, and
  screenshots;
- stale-generation rejection; and
- consistent outcome and error semantics.

Desktop main and the web shell controller provide different delegates but use
the same facade and tests.

### Authorization rules

- Shell UI actions are accepted only from the currently active and visible
  hosted instance.
- Ready notification is accepted only for the bound current generation.
- Close, reload, and reopen target only the bound instance. Whether each is
  allowed while inactive follows existing product behavior and is tested
  explicitly.
- Focus-self cannot select an arbitrary sibling instance.
- Navigation requires the bound instance to be active and visible when the
  request is accepted. It must preserve project targeting, normal-window
  fallback, and latest-activation-intent supersession across asynchronous
  preflight so an older hidden caller cannot steal activation back.
- Navigation input must be a valid supported URI. Project and destination
  resolution are authoritative-side responsibilities; any supplied project ID
  is a hint validated against authoritative catalog state.
- Paste targets the bound active and visible instance. A rejected or stale
  request must not fall through to pasting into the owner shell window.
- Screenshot capture targets the bound instance rather than whichever instance
  happens to be active. Hidden callers are rejected unless characterization
  demonstrates a legitimate hidden-self capture requirement.
- File-open routing is not added to the hosted capability unless the call-site
  audit identifies a concrete hosted-origin caller. Main/shell delivery of
  files into a hosted workbench remains an authoritative opposite-direction
  operation.
- A disposed, superseded, crashed, or stale connection fails closed.

### Response semantics

Do not conflate message delivery with command completion.

For shell actions, the first protocol may preserve the current behavior where
`true` means that an authorized action was accepted and delivered to the shell
renderer. Document that it is not proof of command completion. A future
shell-renderer RPC may strengthen this without changing the action union.

Connection failures should be logged and reflected as unavailable controls or
failed operations. There must be no fallback from the narrow hosted capability
to the global full-service channel.

### Protocol versioning

Give the hosted capability protocol an explicit version and capability set.

- Desktop is normally same-build and may fail closed on mismatch, prompting a
  renderer reload.
- Serve-web can encounter old page assets during deployment or caching, so it
  needs a deliberate compatibility window.
- The first action-hardening stage keeps the existing command-request wire
  shape. New callers map semantic actions to legacy command IDs, while the
  authoritative side enforces a closed command-ID set and discards caller
  arguments. The typed hosted wire protocol begins in the following stage.
- Keep a legacy web adapter only for an explicitly selected compatibility
  period; do not widen the new facade to match the old full service.
- Keep the existing `HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION` separate from the
  hosted capability version. They describe different lifecycle and service
  contracts and may evolve independently.
- Connection replacement increments a generation so late replies and old
  ports cannot affect a reloaded child.

## Desktop transport design

Use Electron `MessagePort` infrastructure already present in VS Code rather
than changing the generic IPC server or preload security model.

### Hosted connection bootstrap

1. A hosted renderer requests the Hucode hosted-shell response port.
2. Validated IPC supplies the authoritative `event.sender.id`.
3. Main resolves that `webContents` against the hosted controller's trusted
   instance mapping.
4. Main rejects unknown, destroyed, normal-workbench, or shell senders.
5. Main creates a `MessageChannelMain` and binds the authoritative window,
   instance, and current connection generation to its server port.
6. Main transfers the client port only to the requesting renderer.
7. Reload replaces and disposes the previous connection.
8. View crash, unload, removal, window destruction, and controller disposal
   release the connection idempotently.

The request/response nonce provides correlation, not authentication. The
authoritative sender-to-instance lookup provides authentication and scope.

The renderer-side client begins in an explicit connecting state and queues or
declines operations according to their semantics. Ready notification retries
after connection, while user operations surface temporary unavailability.
Slow acquisition, reload during acquisition, and shutdown before acquisition
completes are tested. The client never falls back to the global shell channel.

### Shell connection bootstrap

Issue a separate privileged port only to the registered Omni shell
`BrowserWindow.webContents`. Bind the owning window ID and reject hosted or
ordinary renderers.

Move existing shell-to-active-workspace operations onto this connection
without changing their behavior:

- native action, keybinding, and shell-originated clipboard forwarding;
- active hosted view focus and layout;
- overlays and screenshots;
- devtools and reload controls; and
- shell-wide hosted shutdown.

Hosted-origin paste uses the hosted instance capability instead. Intentional
cross-window shell operations use high-level path-scoped methods whose targets
are resolved by main rather than caller-supplied window and instance IDs.

### Avoiding upstream IPC churn

Do not teach `ProxyChannel` about Hucode renderer roles. That would modify a
generic upstream subsystem, create upgrade conflict, and still couple security
to a broadly reusable mechanism.

Prefer Hucode-owned port servers and clients, with the smallest unavoidable
registration hooks in existing Electron startup code.

## Serve-web transport design

Keep the existing same-origin parent/iframe handshake and per-instance
`MessagePort`. It already binds a child connection to a shell-owned instance.

Refactor connection setup to expose the shared bound facade and register the
shared hosted client. Web-specific code remains responsible for:

- iframe source and origin checks;
- parent/child port transfer;
- DOM focus notifications;
- iframe reload and teardown; and
- delegation to the web controller.

After migration, remove the web-local hosted-service `Pick`, duplicated action
allowlist, and hosted client that pretends to implement the complete
`IHucodeShellService`.

## Delivery topology

Deliver one combined pull request to mainline, while using five focused pull
requests against a temporary integration branch to make implementation and
review tractable.

At execution start:

1. Resolve and record the live remote default/mainline branch. It is currently
   `series-1.131.0`.
2. Create `series-1.131.0-hosted-shell-capability` from the exact recorded
   mainline head. This is the integration branch and the head of the eventual
   mainline PR. Its `series-*` name deliberately keeps normal Hucode pull-
   request CI and changelog workflows active for staging PRs.
3. Create each stage branch from the current integration head and target its PR
   at `series-1.131.0-hosted-shell-capability`.
4. Give each stage its focused implementation evidence and independent review,
   then merge it into the integration branch before starting the dependent
   stage.
5. Refresh the integration branch from the recorded mainline at deliberate
   checkpoints without force-pushing reviewed history. Resolve base drift and
   rerun affected evidence before the final review.
6. After all five stages are merged, open one integration PR from
   `series-1.131.0-hosted-shell-capability` to the recorded mainline branch.

The final PR is not a rubber stamp. Stage reviews establish local correctness;
the combined PR receives fresh exact-head CI, a complete branch-diff review,
and runtime verification of interactions between stages. Its review must cover
the whole changeset rather than relying only on approvals from the five staging
PRs.

### Staging PR workflow and merge authority

Run each staging PR through the repository's `ship-feature-pr` workflow as an
independent delivery against the integration branch. Each stage therefore has:

- its own settled stage scope and closure matrix derived from this plan;
- focused implementation evidence and an evidence ledger;
- a draft PR targeting `series-1.131.0-hosted-shell-capability`;
- fresh independent Codex and Claude reviews;
- a bounded correction cycle with risk-proportional re-review;
- normal automatic Hucode CI and changelog checks, because the target branch
  matches `series-*`; and
- an exact-head ready gate before merge.

The user explicitly authorizes the orchestrator to merge each of the five
staging PRs into the integration branch after its required reviews are
non-blocking, required CI is green on the intended head, local delivery is
complete, and the PR is ready. This authorization does not extend to the final
integration PR into mainline.

Use the repository's normal merge method for staging PRs. After each merge,
verify the integration head contains the intended PR result, refresh the local
integration checkout, and branch the next dependent stage from that new head.
Do not merge a staging PR merely because its local portion works if a required
review, CI check, or documented stage acceptance criterion remains open.

Run the final combined PR through the same delivery gates at whole-branch scope:
fresh dual review, final-head local and runtime evidence, and automatic CI on
the exact combined head. The orchestrator may open it, update it, reconcile
review feedback, and mark it ready, but must never merge it. The user retains
the sole authority to merge the integration branch into mainline.

### Selected CodeRabbit reviews

Use CodeRabbit intentionally on the three staging PRs where an additional
external perspective is proportionate:

| Staging PR | Risk | CodeRabbit | Reason |
| --- | --- | --- | --- |
| PR 1 — legacy-wire action hardening | Low to medium | No | Small closed policy and compatibility change; focused characterization, dual internal review, and CI are the stronger evidence |
| PR 2 — shared web capability | Medium, security-sensitive | **Required** | Establishes the shared authority contract, facade, version compatibility, navigation policy, and method-surface boundary |
| PR 3 — desktop hosted capability | Medium to high | **Required** | Introduces sender-authenticated Electron ports, stale-generation handling, startup latching, disposal, paste, and screenshot targeting |
| PR 4 — privileged shell migration | High | **Required** | Migrates the broadest consumer surface, role-aware dependency injection, cross-window behavior, and privileged shell authority |
| PR 5 — global channel removal | Medium, mostly deletion | No by default | Static audit and focused startup tests close the local risk, and the immediately following combined CodeRabbit review covers the final deletion in full context |

Escalate PR 5 to its own CodeRabbit review if it grows beyond mechanical
removal, static enforcement, and documentation or introduces new production
behavior to resolve a missed consumer.

For PRs 2, 3, and 4, request one explicit incremental review with a top-level
`@coderabbitai review` comment on the internally accepted candidate head. Do not
use the `coderabbit:review` label and do not push while a review is active.
Because CodeRabbit skips draft PRs in this repository, mark the internally
accepted candidate ready before triggering it, but keep the merge gate closed
until the CodeRabbit review covers that exact SHA, findings are reconciled, all
valid concerns are fixed, required re-review is complete, unresolved threads
are closed with evidence, and the resulting review state is non-blocking. The
user explicitly authorizes the orchestrator to resolve CodeRabbit threads that
CodeRabbit leaves open after independently verifying that the finding is fixed,
already satisfied, or invalid. Reply with concise evidence or reasoning when
useful. Leave valid unresolved or uncertain concerns open and return them for
correction. This authority does not permit dismissing a blocking review.

The final integration PR also requires a CodeRabbit review over the complete
combined diff, as selected by the user. That review does not replace the three
scoped reviews, and their results do not replace it. Corrections from any
CodeRabbit review use the same bounded `ship-feature-pr` correction budget and
risk-based internal re-review policy.

Behavioral staging PRs use honest Conventional Commit titles and carry their
own numbered `.changes/` fragments when required. Those fragments travel with
the integration branch. The final batch-integration PR uses a hidden title such
as `chore(omni): integrate hosted shell capability hardening`, so it does not
invent a duplicate fragment for work already described by its constituent
PRs.

## Implementation sequence

The five staging PRs form one release-level migration. Temporary adapters and
the global channel may exist between staging PRs on the integration branch,
but the integration branch is not ready for mainline until PR 5 removes them.

### PR 1 — Legacy-wire action policy and immediate hardening

**Objective.** Remove arbitrary hosted shell action execution without breaking
cached serve-web children or changing transport.

**Work.**

- Complete an action census across desktop and web, distinguishing dedicated
  lifecycle commands from actions actually sent through `runActionInShell`.
- Freeze the `runActionInShell` set at toggle sidebar, add, refresh, collapse,
  back, and forward; cover Focus Projects separately through its existing
  dedicated capability.
- Introduce `HucodeHostedShellAction`, its runtime validator, and common mapping
  to the existing command IDs.
- Change current-source callers to request semantic actions through a helper,
  while retaining the legacy command-request wire shape.
- Enforce a closed command-ID set in the existing desktop and web receiving
  paths and discard caller-supplied arguments and `from` metadata.
- Log rejected action kinds and connection context without logging arbitrary
  arguments.
- Add characterization tests for every required action and a stale cached-web-
  child compatibility test using the old wire request.

**Acceptance criteria.**

- Every action demonstrated by the census works on desktop and web.
- Unknown actions and command namespace lookalikes are rejected.
- No hosted input reaches a shell command argument array.
- An old web child using the legacy request shape remains functional for the
  closed allowed set.
- Shell-to-workspace arbitrary command routing remains unchanged.

**Risk.** Low to medium. The behavioral surface is small, but desktop action
delivery and old-asset web compatibility must remain intact.

### PR 2 — Shared hosted capability on serve-web

**Objective.** Establish the final typed contract and shared policy using the
already mature web `MessagePort` transport.

**Work.**

- Add the hosted capability interface, projected state, bound facade factory,
  common client, capability version, and negotiated capability set.
- Keep the new capability version distinct from the existing unload protocol
  version.
- Refactor the web shell connection to expose the shared facade.
- Migrate cross-platform hosted contributions to the narrow service.
- Replace full-state readiness verification with a self-scoped result.
- Preserve `navigateToFolder` project targeting, normal-window fallback,
  active/visible authorization, and latest-activation-intent semantics.
- Audit the currently exposed web file-open methods. Add them to the hosted
  contract only if a concrete hosted-origin caller and least-authority shape are
  demonstrated.
- Retain a narrowly documented compatibility adapter for the selected
  serve-web old-asset window.

**Acceptance criteria.**

- Hosted web code cannot name another window or instance.
- Hidden or superseded web children cannot navigate or drive shell UI.
- The remote method surface exactly matches the hosted capability interface.
- Old and new capability versions follow the documented compatibility policy.
- Existing web authority, navigation, and lifecycle tests remain green.
- A static/conformance test prevents accidental facade widening.

**Risk.** Medium. The transport is proven, but state projection and navigation
may reveal hidden dependencies in hosted titlebar and workbench integration.

### PR 3 — Desktop per-instance hosted capability

**Objective.** Give each desktop hosted view the same narrow service through an
authoritatively bound connection.

**Work.**

- Add main-process hosted-port acquisition and sender validation.
- Extend the existing trusted hosted `webContents` mapping with authoritative
  window, instance, and generation lookup.
- Instantiate the shared bound facade per connection.
- Register the shared hosted client in hosted desktop workbenches with an
  explicit deferred-connection state and no broad-channel fallback.
- Migrate hosted state, readiness, lifecycle, focus, navigation, action,
  self-scoped paste, and screenshot calls.
- Characterize and test the intentional screenshot change from active-instance
  capture to bound-self capture.
- Dispose or replace ports on slow startup, reload, crash, unload, removal,
  shutdown, and window destruction.

**Acceptance criteria.**

- A hosted renderer can control only itself and the finite shell UI surface.
- Paste targets only the bound active and visible hosted instance and cannot
  fall through into the shell.
- Hidden or superseded hosted renderers cannot navigate or regain activation.
- Unknown and non-hosted renderers cannot acquire the capability.
- Slow acquisition and shutdown-before-acquisition settle without leaks or a
  broad-channel fallback.
- A stale port cannot affect a reloaded replacement.
- Desktop and web pass the same capability conformance suite.

**Risk.** Medium to high. The principal risks are Electron connection
lifecycle, reload recovery, startup latching, and accidentally tying disposal
to only one hosted-view teardown signal.

### PR 4 — Privileged shell port and role-aware consumer migration

**Objective.** Move every legitimate privileged desktop consumer off the
global channel while retaining it temporarily as a removal audit target.

**Work.**

- Add the shell-renderer privileged connection bound to its exact
  `BrowserWindow.webContents` and owner window.
- Move shell administration and shell-to-workspace routing onto that
  connection.
- Replace caller-selected cross-window IDs with high-level path-scoped
  operations, including Open Selected in New Window.
- Add the high-level ordinary-workbench open broker if the final audit proves
  it is needed.
- Refactor workbench host and native-host construction so ordinary desktop
  windows receive a role-appropriate local service and remain constructible
  without the global full-service registration.
- Split or rename service decorators so authority is visible at each injection
  site.
- Migrate raw channel consumers in workbench command forwarding, clipboard,
  devtools, host focus/screenshot integration, and Omni open routing.

**Acceptance criteria.**

- Privileged calls originate only from the bound shell renderer.
- Cross-window standalone-open behavior works without caller-supplied target
  window or instance identity.
- Hosted, shell, and ordinary workbench startup constructs the intended service
  graph.
- No legitimate consumer requires the full global channel; the remaining raw
  references are only the registration/removal seams scheduled for PR 5.
- Shell-to-workspace forwarding, lifecycle, layout, devtools, overlays,
  screenshots, shutdown, and folder routing remain functional.

**Risk.** High but bounded. This is the broadest call-site migration, but it is
reviewed before the irreversible cleanup step.

### PR 5 — Remove the global channel and finish the authority boundary

**Objective.** Delete the compatibility escape hatch and prove the final
least-authority architecture is complete.

**Work.**

- Stop registering the complete `IHucodeShellService` through the global
  `hucodeShell` proxy.
- Make the complete desktop shell service main-process-internal.
- Delete temporary adapters and obsolete full-service renderer clients.
- Audit and remove every raw `getChannel('hucodeShell')` access.
- Add a static regression check that prevents the global privileged channel or
  an equivalent broad facade from returning silently.
- Update current architecture documentation and archive this plan after the
  final mainline delivery lands.

**Acceptance criteria.**

- No renderer can reach the complete main service.
- Hosted, shell, and ordinary-workbench roles have disjoint documented
  capability surfaces.
- No compatibility fallback restores the global channel.
- All focused and aggregate authority, lifecycle, integration, and runtime
  evidence passes on the exact integration head.

**Risk.** Medium. Deletion is mechanically smaller than PR 4, but it is the
point at which any missed consumer becomes visible and the security improvement
becomes complete.

## Verification strategy

Authority tests must inspect the actual target and delivered operation, not
only a returned boolean.

### Shared contract tests

- Every defined action maps to exactly one expected shell command.
- Unknown values and namespace lookalikes are rejected.
- Hosted caller arguments are structurally impossible and rejected at runtime
  if malformed wire data bypasses TypeScript.
- The facade binds window and instance identity from construction.
- Self operations always target the bound instance.
- Shell UI actions require the calling instance to be active and visible.
- Navigation requires an active visible caller and loses to a newer activation
  intent after any asynchronous preflight.
- Paste targets the bound active visible instance and cannot fall through to
  the shell window on rejection.
- State projection omits paths, other IDs, process identity, and catalogs.
- Stale connection generations fail closed.
- The exposed method list is exact, so adding a method to a broader service
  cannot widen the hosted facade implicitly.

### Desktop tests

- Shell, hosted, normal, unknown, and destroyed senders receive only their
  intended capability or a rejection.
- Caller-provided nonce reuse cannot change the authoritative sender binding.
- Slow connection establishment exposes a bounded connecting state; readiness
  recovers after connection without broad-channel fallback.
- Reload replaces the connection and invalidates the old port.
- Crash, removal, unload, shutdown-before-connect, controller close, and window
  destruction dispose connections exactly once.
- A hidden hosted instance cannot drive shell UI actions, navigate, paste, or
  capture an unrelated active instance.
- Intended self-lifecycle operations behave correctly while inactive.
- Only server-constructed action requests reach the shell renderer.
- Open Selected in New Window preserves cross-window behavior through an
  authoritative path-scoped operation.
- Hosted, shell, and ordinary workbench service graphs construct without the
  global full-service registration.
- The old global privileged methods are unavailable after removal.

### Serve-web tests

- Existing origin, source-window, and port-handshake checks remain effective.
- A child cannot select another instance through arguments.
- A cached old child can use the bounded legacy action wire during the selected
  compatibility window.
- Replaced and stale iframe connections are rejected.
- Protocol version mismatch follows the documented compatibility policy.
- Web and desktop expose the same hosted capability surface and action policy.

### Integration and runtime tests

- The six hosted shell actions: toggle sidebar, add, refresh, collapse, back,
  and forward; plus Focus Projects through its separate dedicated capability.
- Hosted ready notification, focus, close, reopen, and reload.
- Hosted navigation and ordinary-workbench folder routing, including project
  targeting, normal-window fallback, supersession, and hidden-caller rejection.
- Open Selected in New Window when the path is owned by another Omni window.
- Multi-workbench activation with one active and multiple hidden instances.
- Desktop hosted view crash and reload recovery.
- Slow desktop capability connection and shutdown during connection.
- Native menu and keybinding forwarding from shell to active workbench.
- Clipboard copy/cut and paste behavior, including existing at-most-once
  timeout semantics.
- Bound-self screenshot behavior versus the previous active-instance behavior.
- Ordinary desktop workbench startup after global channel removal.
- Devtools, overlay occlusion, layout, and shell shutdown, including shutdown
  ordering while privileged and hosted ports are disposing.

### Repository validation

Use proportionate focused suites during each PR, then the relevant aggregate
Hucode validation before delivery. Repeat final aggregate and runtime evidence
on the exact integration head after all five staging PRs and mainline drift are
combined:

- `npm run gulp compile-client` after TypeScript source edits;
- focused Node and Electron suites for each changed layer;
- focused browser/web shell suites;
- `npm run hucode:test-suites -- --write-snapshot` if new Hucode suites change
  the generated inventory;
- `npm run hucode:check-test-suites`;
- `npm run typecheck-client` where the touched service graph warrants it;
- `npm run -s precommit -- <edited paths>` before staging, or the staged
  precommit path when appropriate; and
- desktop and serve-web smoke runs for the interaction matrix above.

Do not run multiple Electron test harnesses concurrently. Recompile after
source edits before interpreting `VSCODE_SKIP_PRELAUNCH=1` test results.

## Complexity and maintenance assessment

### Upfront complexity

**Medium to high.** The semantic action restriction is straightforward. Most
complexity comes from:

- binding and disposing desktop ports across reload, crash, unload, and window
  lifecycle;
- teasing apart current service consumers by renderer role;
- projecting enough state without retaining accidental dependencies on the
  complete window state; and
- preserving serve-web compatibility during asset version skew.

### Ongoing maintenance

**Low to medium, and lower than maintaining parallel policies.** The end state
has:

- one hosted contract;
- one action policy and mapping;
- one bound-facade implementation;
- one hosted client and conformance suite; and
- small desktop and web connection adapters.

Adding a hosted capability becomes intentionally explicit: update the narrow
interface, authoritative delegate, both transport conformance tests, and the
security rationale. This is maintenance friction by design and prevents
unrelated shell methods from becoming remotely callable automatically.

### VS Code upgrade burden

Keep generic IPC, preload, and upstream workbench changes minimal. Hucode-owned
port servers, clients, and contracts should live under `src/vs/hucode/` where
possible. The desktop startup registration and a handful of workbench
integration seams are likely unavoidable, but the design should not alter
`ProxyChannel` or the core IPC context format.

This structure should be easier to replay across upstream upgrades than a
custom role-aware fork of VS Code's generic IPC system.

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Hidden hosted dependency on complete state | Characterize call sites first, add projected-state tests, and migrate web before desktop |
| Stale renderer controls a replacement | Bind a connection generation and fail closed after replacement |
| Port leak across lifecycle paths | Central idempotent disposal; tests for reload, crash, unload, host close, and global destruction |
| New action is accidentally authorized | Closed semantic union; never reuse namespace routing as authorization |
| Desktop and web drift again | Shared facade/client/policy plus cross-platform conformance suite |
| Serve-web old/new asset mismatch | Preserve the legacy action wire in PR 1, then use an explicit capability version and bounded adapter |
| Hidden child steals navigation | Active/visible authorization plus latest-activation-intent checks after asynchronous preflight |
| Hosted paste reaches the shell | Self-bound paste capability with no shell-window fallback |
| Slow desktop connection regresses startup | Explicit connecting state, bounded behavior, and shutdown-during-connect tests |
| Cross-window shell behavior is lost | High-level path-scoped operations resolved authoritatively in main |
| Ordinary workbench DI breaks | Role-aware service registration and startup-construction tests before global channel removal |
| Migration silently restores broad access | No runtime fallback to global full service; static raw-channel audit |
| Shell renderer loses legitimate authority | Separate privileged shell capability, migrated and tested before deleting the global channel |
| Upstream merge burden grows | Avoid core IPC changes and keep platform adapters Hucode-owned |

## Quality bar

The work is complete only when all of the following are true:

- hosted authority is represented by a narrow named type, not documentation
  around a broad service;
- window and instance identity are connection-bound on both platforms;
- arbitrary shell command IDs and arguments cannot cross the hosted boundary;
- desktop sender identity is derived from authoritative `webContents` state;
- stale and disposed connections fail closed;
- hidden or superseded hosted renderers cannot navigate, paste, or drive shell
  UI;
- self-scoped paste and screenshot behavior targets the bound instance;
- cross-window shell workflows use authoritative high-level operations rather
  than caller-supplied target IDs;
- ordinary desktop workbenches construct without a privileged remote service;
- the desktop shell renderer has a separately bound privileged capability;
- the complete shell main service is no longer globally renderer-visible;
- desktop and web share policy, facade, client, and conformance tests;
- there is no broad compatibility fallback;
- negative authority tests verify denied operations and actual targets;
- existing user-facing Omni behavior passes focused automated and runtime
  verification; and
- current architecture documentation describes the resulting authority model.

Stopping after the semantic allowlist or per-instance hosted port would be a
useful intermediate hardening step, but it would not meet this final quality
bar while the complete global desktop channel remains reachable.

## Review decisions

The recommended defaults for implementation are:

1. Use semantic hosted actions, never arbitrary command IDs.
2. Permit shell UI actions only from the active visible hosted instance.
3. Bind all self operations to the connection's instance.
4. Resolve hosted navigation and intentional cross-window shell operations
   authoritatively through high-level path-scoped methods.
5. Share contract, facade, policy, client, and conformance tests.
6. Keep only transport bootstrap and host mechanics platform-specific.
7. Preserve the legacy serve-web action wire for PR 1, then version the new
   hosted capability separately from the unload protocol.
8. Deliver five focused `ship-feature-pr` staging PRs into
   `series-1.131.0-hosted-shell-capability`, followed by one holistic PR from
   that branch to mainline.
9. Treat staging reviews as focused evidence, not a substitute for fresh
   exact-head review of the combined mainline PR.
10. Merge staging PRs only after their ready gates pass; never merge the final
    integration PR, whose merge authority remains exclusively with the user.
11. Remove the complete global desktop channel as the terminal condition.

## Source map

- `src/vs/hucode/common/omniWindow.ts` — current complete service contract.
- `src/vs/code/electron-main/app.ts` — desktop global channel registration.
- `src/vs/hucode/electron-browser/omniWindowService.ts` — desktop renderer
  remote-service registration.
- `src/vs/hucode/electron-main/shellMainService.ts` — main service delegation.
- `src/vs/hucode/electron-main/hostedWorkspacesController.ts` — hosted view
  ownership, trust tracking, and shell action delivery.
- `src/vs/hucode/browser/webShellService.ts` — serve-web controller and current
  bound hosted facade.
- `src/vs/hucode/browser/hostedOmniWebConnection.ts` — hosted web `MessagePort`
  bootstrap.
- `src/vs/hucode/browser/hostedOmniWebShellService.ts` — current hosted web
  client adapter.
- `src/vs/hucode/browser/hostedOmniWorkspace.contribution.ts` — shared hosted
  readiness, actions, and lifecycle consumers.
- `src/vs/hucode/browser/omniSelectionOpen.ts` — path-scoped standalone-window
  flow that can intentionally cross Omni window ownership.
- `src/vs/hucode/browser/projectSwitcher/openProjectSwitcherTarget.ts` — hosted
  navigation, normal-window fallback, and activation-intent consumer.
- `src/vs/workbench/services/host/electron-browser/hucodeHostedOmniHost.ts` —
  desktop hosted focus, state, and screenshot integration.
- `src/vs/workbench/services/host/electron-browser/nativeHostService.ts` —
  ordinary and hosted desktop service construction.
- `src/vs/workbench/services/host/electron-browser/hucodeOmniOpen.ts` — desktop
  workbench folder routing.
- `src/vs/workbench/services/clipboard/electron-browser/clipboardService.ts` —
  hosted-origin native paste routing.
- `src/vs/workbench/electron-browser/hucodeOmniCommandForwarding.ts` — shell-to-
  hosted action, keybinding, and clipboard forwarding.
- `src/vs/workbench/electron-browser/hucodeHostedDevTools.ts` — hosted devtools
  raw-channel consumer.
- `src/vs/platform/window/common/hucodeOmniCommandRouting.ts` — trusted command
  routing classifier, which must remain separate from hosted authorization.
- `src/vs/base/parts/ipc/electron-browser/ipc.mp.ts` and
  `src/vs/base/parts/ipc/electron-main/ipc.mp.ts` — existing Electron
  `MessagePort` infrastructure.
