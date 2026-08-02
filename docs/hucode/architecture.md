# Hucode Architecture

## Product Goal

Hucode is a VS Code fork with a persistent project manager shell around one or
more hosted workspaces. The shell owns global navigation, project/worktree
state, and workspace lifecycle. Individual workspaces continue to run as mostly
normal VS Code workbenches, hosted in Electron on desktop or iframes on web.

The core user experience is:

- one or more native Omni windows
- a serve-web Omni shell at `/`, with `/omni` as its explicit route
- a left-side Projects surface
- saved projects with nested git worktrees
- fast switching between resident workspaces
- explicit restore-pending, loading, active, loaded, dormant, unloaded,
  missing, and crashed workspace states

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
in the shell renderer and serves it to hosted iframes over per-instance
`MessagePort` channels (`vs/base/parts/ipc` + `ProxyChannel`), so both call
directions are statically typed against the shared interfaces. Same-origin
window `postMessage` is only used for the bootstrap handshake: `Ready` and
`Focus` from the iframe, and the `Port` transfer from the shell.

### Serve-Web Routing

Hucode serve-web enables its web routes and Projects API by default through the
inner server's `--hucode-web-omni-root` argument. Pass `--no-omni` to keep
upstream behavior instead: the regular workbench at `/` and no Hucode web
routes. By default:

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

### Desktop Main-Process and Web Server Services

On desktop, the project manager and hosted workspace controller are
main-process services. They coordinate shared state across the Omni shell and
hosted workbench renderers.

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
under the server user-data path and is active unless serve-web runs with
`--no-omni`. Browser requests must be same-origin (cross-origin `Origin`
headers are rejected and POST bodies must be JSON) so the mutating API stays
safe even with `--without-connection-token`.

Serve-web user data has two startup modes. `browser`, the default, retains the
upstream IndexedDB/local-storage ownership. `server` makes the separate
`<server-data-dir>/data/WebUser` namespace authoritative for profile files,
the web profile catalog, and application/profile/workspace state. The Rust CLI
selects the mode with `--user-data-storage`, and the Node server injects that
trusted choice into every regular, Omni-shell, and hosted-workbench route.
Before `BrowserMain` constructs profile or storage services, the Hucode web
entrypoint initializes the versioned server manifest or offers to migrate
known logical browser resources through a staged, generation-checked API.

The server exposes `WebUser/User` through the existing remote file provider,
a dedicated web-profile channel, and Node-hosted SQLite databases under
`WebUser/State` through the common storage protocol. This namespace is not the
remote extension host's `data/User` tree. Browser mode never registers or uses
these authorities. In server mode, the browser IndexedDB provider remains only
as the migration and rollback source; there is no live mirror or merge.
Workspace identifiers are hashed, profile identifiers and migration paths are
validated, state writes are serialized per database, and cross-client changes
are broadcast for every storage scope.

Secret storage, authentication sessions, cookies, and connection credentials
remain browser-local in both modes and are excluded from migration. Settings
files may themselves contain sensitive values, so selecting server mode means
trusting and backing up the server data directory. A server-mode bootstrap or
persistence failure is surfaced to the user and never falls back silently to
browser authority. The Reset User Data action warns that server mode erases
shared non-secret data for every connected browser; it does not erase the
browser migration copy or browser-local secrets and sign-ins.

## Core Subsystems

### Project Manager

The project manager stores the user-defined project list and worktrees. Desktop
exposes one main-process service to the Omni shell and hosted workbench
renderers through the `projectManager` channel. Serve-web hosts the same shared
Node service behind its HTTP/SSE adapter.

Responsibilities:

- add and remove saved projects
- discover and refresh git worktrees
- create and remove worktrees through git
- persist ordering, labels, pinned state, and last active worktree
- share project/worktree watchers globally instead of duplicating them per
  renderer

### Workbenches And Projects Surface

The Omni sidebar surface is shell-owned under
`src/vs/hucode/browser/parts/projectsPart.ts`. It is not a normal registered
workbench view/container in the Omni sidebar.

It combines a per-window catalog of arbitrary folder workbenches with the
global project manager. Arbitrary entries persist independently of hosted
renderer instances: unload removes the instance but retains the entry, while
dismiss removes the entry after a successful unload. When a retained path
becomes a project worktree, the project record becomes authoritative and the
catalog entry is removed.

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
- desired-loaded workbenches not selected for eager startup are represented as
  `dormant` without creating a renderer; activation materializes them on demand

The `hucode.omni.restoreHostedWorkbenches` setting controls eager startup on
desktop and serve-web. `active` (the default) restores the last selected
workbench and leaves the rest dormant, `all` restores every desired-loaded
workbench, and `none` leaves every desired-loaded workbench dormant.

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
platform helpers, and should not import from `src/vs/hucode/*`.

**With one deliberate exception, enforced rather than assumed.**
`src/vs/platform/windows/electron-main/windowsMainService.ts` does import from
`src/vs/hucode/electron-main/`. `eslint.config.js` allow-lists
`vs/hucode/common/**` and `vs/hucode/electron-main/**` in its `hasNode` block,
which covers the `node`, `electron-utility`, and `electron-main` layers, so the
import is checked rather than merely tolerated.

The reason is a platform mechanic, not history: an external `hucode <file>`
launch never reaches a renderer. It enters `WindowsMainService` directly, so
CLI file and folder routing has to make its Omni decision in main-process code.
Moving those helpers behind an indirection would relocate the dependency
without removing it, and the review that examined this found it would not
materially reduce the upgrade conflict surface.

Treat the allow-list as the definition of the exception. Anything not in it
still follows the rule, and widening it needs the same kind of justification —
a specific mechanic that makes the import unavoidable.

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

Two filters apply, and the platforms enforce them at different points:

| Filter | Desktop | Web |
| --- | --- | --- |
| Theme-only user extensions | `hucodeExtensionEnablementPolicy` | same |
| Shell-irrelevant built-ins | `skipBuiltinExtensions`, at scan | enablement |

`skipBuiltinExtensions` is an `INativeEnvironmentService` setting read by
`extensionsScannerService`, which under `serve-web` runs on the server with no
per-route flag. Web therefore cannot skip the scan and disables at enablement
instead, which is enough: `abstractExtensionService` filters by enablement
before the registry delta, so a disabled extension never reaches an extension
host and never activates. The web shell is still *sent* these extensions; it
simply never registers them.

The route distinction is the safety property. `/` and `/omni` are the shell;
`/workbench` and the `/omni/workbench` hosted iframes are ordinary workbenches
and keep normal extension behavior.

Both filters gate on `isOmniShellWindow`, **not** on
`isOmniWindow && !isHostedOmniWorkspace`. Those two flags are readable from the
web client's `payload` URL parameter, which is fine for the UI routing that
consumes them but would let `/workbench?payload=[["isOmniWindow","true"]]` strip
a workbench's extensions and let the shell opt back into loading them.
`isOmniShellWindow` is derived from the server-injected page configuration on
web and from the main-process window configuration on desktop, so the page
cannot set it.

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
