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
- [x] Run focused tests for changed files.
- [x] Run required Hucode hygiene checks.
