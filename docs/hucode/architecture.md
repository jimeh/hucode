# Hucode Architecture

## Product Goal

Hucode is a VS Code fork with a persistent project manager shell around one or
more hosted workspaces. The shell owns global navigation, project/worktree
state, and workspace lifecycle. Individual workspaces continue to run as mostly
normal VS Code desktop workbenches.

The core user experience is:

- one native Omni window
- a serve-web Omni shell at `/omni`, optionally also at `/`
- a left-side Projects surface
- saved projects with nested git worktrees
- fast switching between resident workspaces
- explicit active, loaded, loading, unloaded, and crashed workspace states

## Runtime Shape

### Omni Shell Renderer

The Omni shell is a Hucode-owned renderer and workbench bootstrap. It owns:

- shell layout and Hucode-local workbench parts
- Projects UI and project/worktree commands
- shell-level command routing
- hosted-workspace state display
- focus handoff between Projects and the active hosted workspace

The shell lives primarily under `src/vs/hucode/browser/`,
`src/vs/hucode/electron-browser/`, and `src/vs/hucode/omni.desktop.main.ts`.
Shared shell contracts live under `src/vs/hucode/common/`. Hucode-specific
shell parts should stay in Hucode-owned files rather than layering behavior
onto `src/vs/sessions/browser/*`.

### Hosted Workspace Renderers

Each loaded desktop workspace runs in its own Electron `WebContentsView`. A
hosted workspace loads the normal workbench HTML and boots the standard desktop
workbench bundle, not a special Omni-only bundle. Hosted-only services or
contributions must be imported into the standard desktop path when they need to
run inside embedded workspaces.

Serve-web hosts workspaces in same-origin browser iframes instead of Electron
views. The iframe URL targets the dedicated `/omni/workbench` route, which
boots a normal web workbench plus the hosted Omni bridge modules; the regular
`/workbench` route never loads them. Browser overlays use normal DOM stacking
above the iframe surface; the desktop screenshot-overlay fallback is not used
on web.

The shell treats each workspace as a hosted unit with:

- worktree identity
- native view bounds
- visibility and z-order
- focus state
- lifecycle state
- unload and shutdown handshake state

Desktop and web share `HostedWorkspaceStateModel` for path indexing, active
selection, ready transitions, sidebar state, and public state projection. The
desktop `ResidentHostedWorkspacesController` injects Electron view behavior;
the web `WebHucodeShellController` injects iframe, timer, and browser-message
behavior. Keep controller orchestration changes in sync across both adapters
unless the difference is explicitly platform-specific.

The shell service contract is shared as `IHucodeShellService`. Desktop exposes
it through IPC to the main-process controller. Web implements the same contract
in the renderer and communicates with hosted iframes through same-origin
`postMessage` plus source/origin checks.

### Serve-Web Routing

All Hucode web routes and the Projects API are gated on the `--omni` flag
(`--hucode-web-omni-root` on the inner server). Without it, serve-web keeps
upstream behavior: the regular workbench at `/` and nothing else. With it:

- `/` loads the Omni Projects shell
- `/omni` also loads the Omni Projects shell
- `/workbench` loads the regular workbench
- `/omni/workbench` loads the hosted workbench used by shell iframes
- trailing-slash aliases of those routes redirect to the canonical path while
  preserving query parameters

Hucode route selection lives in `src/vs/server/node/hucodeWebOmniRoutes.ts` and
`src/vs/server/node/hucodeWebClientServerIntegration.ts`. Keep
`webClientServer.ts` as a thin integration point that delegates routing and
Hucode workbench configuration into those companions.

### Main-Process Services

The project manager and hosted workspace controller are main-process services.
They coordinate shared state across the Omni shell and hosted workbench
renderers.

Key services:

- `src/vs/platform/projectManager/node/projectManagerMainService.ts`
  owns project records and worktree orchestration.
- `src/vs/platform/projectManager/node/gitWorktreeService.ts` wraps
  git worktree operations.
- `src/vs/hucode/electron-main/shellMainService.ts` owns hosted workspace
  creation, restore, focus, shutdown, and command forwarding.
- `src/vs/platform/browserView/electron-main/browserViewMainService.ts` owns
  integrated browser views and hosted-workspace browser ownership.

The `projectManager` and `hucodeShell` channels are registered from the main
process so the Omni shell and hosted desktop workbenches can share these
services.

Serve-web reuses the project manager service from the shared `node` layer
through `HucodeWebProjectManagerServer`. The HTTP/SSE adapter stores its data
under the server user-data path and is only active when serve-web runs with
`--omni`. Browser requests must be same-origin (cross-origin `Origin` headers
are rejected and POST bodies must be JSON) so the mutating API stays safe even
with `--without-connection-token`. User settings/state remain the existing
browser-side serve-web concern.

## Core Subsystems

### Project Manager

The project manager stores the user-defined project list and worktrees. It is a
single main-process service exposed to the Omni shell and hosted workbench
renderers through the `projectManager` channel.

Responsibilities:

- add and remove saved projects
- discover and refresh git worktrees
- create and remove worktrees through git
- persist ordering, labels, pinned state, and last active worktree
- share project/worktree watchers globally instead of duplicating them per
  renderer

### Projects Surface

The Omni Projects surface is shell-owned under
`src/vs/hucode/browser/parts/projectsPart.ts`. It is not a normal registered
workbench view/container in the Omni sidebar.

This keeps Explorer, Search, SCM, and other standard sidebar behavior from
leaking into the Omni shell. Hosted workbenches can still deregister redundant
views in their own renderer context without affecting normal desktop windows.

### Hosted Workspace Controller

Resident hosted workspaces are keyed by worktree path. Hidden workspaces stay
loaded and can become active again without being recreated.

Important lifecycle rules:

- restore must share one in-flight restore promise
- restore must choose one active workspace, including older state without an
  explicit active entry
- a workspace becomes loaded or active only after the child workbench reports
  `LifecyclePhase.Restored`
- unload and app quit must run the normal renderer unload handshake before a
  hosted `WebContentsView` is destroyed
- hosted browser views owned by a workspace must be destroyed separately
- the service contract still has a `dormant` state, but current resource
  policy treats hidden resident workbenches as normal loaded workbenches rather
  than applying LRU or dormant-state heuristics

### Integrated Browser Views

Integrated browser `WebContentsView`s inside hosted Omni workbenches are
top-level `contentView` siblings, not children of the hosted workspace view.
The hosted view is used to calculate offsets and synchronize visibility and
z-order.

This avoids native hit-testing failures where browser contents are visible but
not interactive.

### Command And Focus Routing

The Omni shell receives native menu/action IPC in the shell renderer. Projects
actions stay local to the shell. Workspace-level actions and keybindings are
forwarded to the active hosted workspace.

Routing policy should stay command-id based and close to the layer that consumes
it. Generic workbench files may import same-layer `hucode*` helpers or lower
platform helpers, but should not import from `src/vs/hucode/*`.

Native replies and utility-process startup can target either the owning window
or a hosted workspace `webContents`. Hucode-specific renderer reply-target
helpers live under `src/vs/platform/window/` so shared window and IPC code does
not need to depend on `src/vs/hucode/*`.

### Extension Filtering

The Omni shell does not need the full user extension set for project/worktree
management. Hucode filters user extensions for the shell through
`src/vs/workbench/services/extensions/common/hucodeExtensionEnablementPolicy.ts`.

Keep this policy centralized so upstream extension scanner and enablement
service changes stay thin during VS Code upgrades.

## Product Identity

Hucode product identity is applied through the tracked mixin overlay under
`build/hucode/mixin/stable/`. Root `product.json` and upstream resource files
should remain VS Code OSS in committed source.

Hucode's app release version lives in overlay `hucodeVersion`; upstream
`version` remains the VS Code compatibility version.

## Relevant Upstream Areas

Hucode work most often intersects with:

- `src/vs/code/electron-main`
- `src/vs/platform/browserView`
- `src/vs/platform/projectManager`
- `src/vs/platform/window`
- `src/vs/workbench/electron-browser`
- `src/vs/workbench/contrib/browserView`
- `src/vs/workbench/services/browserView`
- `src/vs/workbench/services/extensions`
- `src/vs/workbench/workbench.desktop.main.ts`
- `src/vs/base/parts/ipc`

Prefer additive seams and Hucode-local files where possible. When shared
upstream files need changes, keep them thin and route policy into Hucode-named
helpers.

## Validation

Use the narrowest validation that covers the change:

- product overlay changes: `npm run hucode:validate`
- Hucode TypeScript changes: `npm run hucode:compile`
- incremental UI work: `npm run hucode:watch` plus `npm run hucode:run`
- serve-web UI work: `npm run hucode:watch` plus `npm run hucode:web`
- project/worktree model changes: run the related `src/vs/hucode/test` or
  `src/vs/platform/projectManager/test` suites when practical

## Design Principles

- keep the shell small and explicit
- preserve upstream workbench behavior inside each hosted workspace
- keep destructive git actions intentional and well-labeled
- prefer additive seams over deep rewrites
- keep Hucode policy in Hucode-named helpers close to the consuming layer
