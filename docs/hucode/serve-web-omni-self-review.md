# Serve Web Omni Self-Review Follow-Up

This checklist tracks the self-review findings for the serve-web Omni shell PR.
Keep this file current while fixing the branch so another agent can see which
items remain open.

## Findings

- [x] P1: Extract shared hosted-workspace orchestration.
  - Web currently owns hosted iframe lifecycle, active instance selection,
    sidebar state, navigation state, command dispatch, unload handling, and
    state emission independently from the desktop resident-workspaces
    controller.
  - Shared hosted-workspace indexing, active selection, sidebar state,
    navigation state, ready transitions, and public state projection now live
    in `HostedWorkspaceStateModel`; desktop and web keep platform-specific
    WebContentsView/iframe behavior in their adapters.

- [x] P1: Fix web hosted-workspace path identity.
  - Web lowercases every folder path before indexing hosted instances, which
    can collapse distinct case-sensitive Linux paths.
  - Target: use a shared path identity/comparison helper that matches the
    server/project-manager path semantics.

- [x] P2: Do not mark hosted iframes ready on iframe `load`.
  - The iframe load event is transport-level loading, not hosted workbench
    readiness.
  - Target: transition to ready only after the hosted workbench sends
    `notifyHostedWorkspaceReady`.

- [x] P2: Move Hucode hosted-Omni workbench entrypoint decisions out of
  upstream workbench bootstrap.
  - `src/vs/code/browser/workbench/workbench.ts` currently parses Hucode
    payload shape inline.
  - Hucode entrypoint decisions now live in a Hucode-named companion beside the
    upstream workbench bootstrap; the bootstrap itself is a thin call site.

- [x] P3: Thin the Hucode route/config integration in `webClientServer.ts`.
  - The Hucode route matrix and shell HTML live in Hucode-owned companions, but
    the upstream server still owns a fair amount of Hucode route orchestration.
  - Target: move the remaining Hucode route/config decision-making into a
    Hucode-owned integration helper where practical.

- [x] P2: Restore web file-open forwarding parity.
  - `WebHucodeShellService` opened or activated the target iframe but always
    returned `false` for `openFilesInWorkspace` and
    `openFilesInActiveWorkspace`.
  - Web now waits for hosted workbench readiness through the shared hosted
    workspace helper and forwards `vscode:openFiles` to the iframe; the hosted
    web bridge handles that command with the browser editor services.

- [x] P3: Share hosted-workspace readiness waiting.
  - Desktop and web should not each own their own pending-ready timeout loop.
  - Readiness availability and timeout waiting now live in
    `waitForHostedWorkspaceReady`, with platform adapters supplying only their
    state-change event and unavailable-instance predicate.

- [x] P2: Do not reuse crashed hosted iframes in the web shell.
  - Web now uses the shared hosted-workspace availability predicate when
    opening a worktree and removes terminal iframe instances before creating a
    replacement.
  - Browser coverage simulates a failed hosted iframe and verifies reopening
    the same worktree creates a new instance.

- [x] P3: Extract hosted web open-file handling out of the iframe bridge.
  - `HostedOmniWebBridgeContribution` now delegates `vscode:openFiles` to a
    Hucode-owned helper that owns path-to-editor conversion, diff/merge editor
    construction, and wait-marker cleanup.
  - Focused helper tests cover normal, diff, and merge editor input creation.

- [x] P3: Add direct web shell adapter coverage.
  - `src/vs/hucode/test/browser/webShellService.test.ts` covers the
    iframe-specific crashed-instance reopen path through the public shell
    service API.

- [x] P2: Treat terminal hosted iframes as unavailable across web shell APIs.
  - Web `find`, `focus`, readiness, reopen, active command, paste/keybinding,
    and reload paths now use the shared availability predicate or ignore late
    terminal iframe messages.
  - Browser coverage verifies crashed iframes are not surfaced as existing
    hosted workspaces and cannot be revived by late readiness messages.

- [x] P2: Reopen hosted web workspaces as normal workbench URLs.
  - Web `reopenWorkspaceInNormalWindow` now delegates through the shared
    Hucode reopen helper and opens `/workbench?folder=...` without hosted
    iframe payload when no normal window is already focused.
  - Browser coverage verifies the hosted iframe is closed and the opened URL is
    a plain workbench URL.

- [x] P2: Propagate serve-web project-manager changes across clients.
  - The serve-web project manager now supplies a Node metadata watcher to the
    shared `ProjectManagerMainService` and exposes project changes through an
    SSE endpoint.
  - The browser project manager subscribes to those events, keeping Omni shells
    in sync when another request or shell changes project metadata.

## Second Review Findings

- [x] P1: Verify hosted iframe message source before dispatch.
  - `WebHucodeShellService` currently accepts same-origin child messages by
    `instanceId` alone. It should also require `event.source` to match the
    owning iframe's `contentWindow`.

- [x] P1: Scope hosted iframe self-requests to the sender instance.
  - `closeWorkspace`, `reopenWorkspaceInNormalWindow`, and
    `notifyHostedWorkspaceReady` should use the sender iframe instance id, not
    an instance id supplied in request arguments.

- [x] P1: Bound serve-web Project Manager JSON request bodies.
  - `HucodeWebProjectManagerServer.readJson()` buffers request bodies without a
    size limit.

- [x] P2: Fetch initial projects before committing SSE response headers.
  - `handleEvents()` writes event-stream headers before `getProjects()` can
    fail, which prevents normal JSON error responses.

- [x] P2: Always acknowledge hosted iframe unload requests.
  - Hosted web workbenches should send `UnloadReady` even when
    `lifecycleService.shutdown()` rejects.

- [x] P2: Move active/loaded state transitions into shared hosted state.
  - `HostedWorkspaceStateModel.activateInstance()` should promote/demote ready
    instances so desktop and web adapters do not each own that core state
    reconciliation.

- [x] P2: Fix shared readiness wait cleanup for synchronous events.
  - `waitForHostedWorkspaceReady()` should not close over listener/timeout
    bindings before they are initialized.

- [x] P2: Use platform-aware path identity for desktop hosted workspaces.
  - Desktop `HostedWorkspaceStateModel` path keys should be case-insensitive on
    non-Linux platforms.

- [x] P2: Resolve relative custom worktree paths before creation.
  - `GitWorktreeService.createWorktree()` should store and return the same
    absolute path that Git creates.

- [x] P2: Align web Omni titlebar visibility with the web layout.
  - Web Omni hides the titlebar in the grid descriptor but `isVisible()` still
    reports the titlebar as visible.

- [x] P3: Reject nested project DELETE routes.
  - `DELETE /_hucode/projects/<id>/anything` should not remove `<id>`.

- [x] P3: Deep-clone nested persisted project state.
  - `loadStoredProjectManagerState()` shallow-copies project records but leaves
    nested persisted collections aliased.

- [x] P3: Treat self-move requests as no-ops.
  - `moveProject()` and `moveWorktree()` should return early when source and
    target identify the same item.

- [x] P3: Complete `OmniHostPart.dispose()` cleanup.
  - Dispose should stop screenshot refresh and clear overlay/screenshot state
    before unregistering the web host surface.

- [x] P3: Catch detached wait-marker cleanup failures.
  - Fire-and-forget wait-marker cleanup in `hostedOmniOpenFiles` should not
    leak unhandled rejections.

- [x] P3: Broaden Project Switcher row identity test snapshots.
  - The row identity test should use distinct project/worktree object graphs
    across refreshes.

- [x] P3: Localize Project Manager client fallback errors.
  - Browser Project Manager fallback request errors should use `nls.localize`.

- [x] P3: Add focused `WebProjectManagerService` client tests.
  - Cover request shape, response revival, and SSE event emission from the
    browser client adapter.

- [x] P3: Relax `readProjectEvent()` input type.
  - The EventSource listener receives `Event`; parsing should narrow to a
    message-like event before reading `data`.

## Third Review Findings

- [x] P2: Add `WebProjectManagerService` browser coverage to Hucode CI.
  - The new browser test now runs in the targeted `scripts/test.sh` browser
    pass.

- [x] P2: Test web-only command-routing exceptions.
  - `WebHucodeShellService` now has focused coverage for iframe focus handoff
    with browser-limited keybinding/paste behavior, plus desktop-only screenshot
    and devtools API results.

- [x] P3: Remove the local desktop ready-state ternary.
  - Desktop readiness handling now uses the shared
    `getReadyHostedWorkspaceState()` helper before applying
    `markInstanceReady()`.

## Verification

- [x] Add or update focused tests for changed shared hosted-workspace behavior.
- [x] Add or update focused tests for path identity and readiness behavior.
  - Path identity has helper coverage in
    `src/vs/platform/projectManager/test/common/projectManagerState.test.ts`.
  - Readiness and shared shell state have lower-level coverage in
    `src/vs/hucode/test/common/hostedWorkspaceState.test.ts`.
- [x] Add focused coverage for Hucode web workbench entrypoint selection.
- [x] Add focused coverage for Hucode server-web route/config integration.
- [x] Add focused coverage for shared hosted-workspace readiness waiting.
- [x] Add focused browser coverage for hosted web open-file handling.
- [x] Add focused browser coverage for the web shell iframe adapter.
- [x] Add focused server coverage for serve-web project-manager events.
- [x] Run focused tests for changed files.
- [x] Run required Hucode hygiene checks.
