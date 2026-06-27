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

## Verification

- [x] Add or update focused tests for changed shared hosted-workspace behavior.
- [x] Add or update focused tests for path identity and readiness behavior.
  - Path identity has helper coverage in
    `src/vs/platform/projectManager/test/common/projectManagerState.test.ts`.
  - Readiness and shared shell state have lower-level coverage in
    `src/vs/hucode/test/common/hostedWorkspaceState.test.ts`.
- [x] Add focused coverage for Hucode web workbench entrypoint selection.
- [x] Add focused coverage for Hucode server-web route/config integration.
- [x] Run focused tests for changed files.
- [x] Run required Hucode hygiene checks.
