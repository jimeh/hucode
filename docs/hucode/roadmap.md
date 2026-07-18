# Hucode Roadmap

This roadmap is grouped by current status instead of historical phase. Older
phase names are kept as context where useful, but the source of truth is whether
the capability is completed, active, or later.

## Completed

### Fork Baseline

Goal:

- establish the fork as a buildable, branded Hucode baseline

Done:

- Hucode product branding lives in the tracked mixin overlay
- OpenVSX marketplace defaults are configured
- Hucode build, run, release, icon, and validation scripts exist
- repo strategy documents upstream, series, and replay branch workflows
- a project-local `hucode-upgrade-vscode` skill captures the upgrade process

Validation:

- `npm install`
- `npm run hucode:validate`
- `npm run hucode:compile`
- `npm run hucode:run`

### Project Model And Projects Surface

Goal:

- build the project and worktree model and expose it through the Omni Projects
  surface

Done:

- persistent project registry
- main-process git worktree service
- combined Workbenches and Projects UI with retained arbitrary folders
- per-window retained-workbench persistence, unload/dismiss lifecycle, and
  drag-and-drop ordering
- desktop and serve-web startup policy with active/all/none eager restore
- combined quick picker, MRU, and previous/next workbench navigation
- arbitrary folder-open routing into Omni on desktop and serve-web
- Projects UI with projects and nested worktrees
- add, remove, rename, refresh, pin, switch, and unload flows
- shell-owned Projects part for Omni windows

Validation:

- project manager tests under `src/vs/platform/projectManager/test`
- project switcher model tests under `src/vs/hucode/test`
- manual add, remove, rename, refresh, switch, and unload testing

### Omni Shell And Hosted Workspaces

Goal:

- move the project manager outside the workspace workbench and host workspaces
  as native views

Done:

- Hucode Omni renderer entrypoint and shell bootstrap
- Hucode-local shell parts under `src/vs/hucode/browser/`
- hosted workspace creation through Electron `WebContentsView`
- focus handoff between shell and hosted workspace
- shell/workspace command and keybinding forwarding
- native paste routing for hosted workspaces

Validation:

- launch Omni shell on macOS
- switch focus between Projects and hosted workspace
- verify native menu actions and keyboard shortcuts in both scopes
- verify paste works in Projects prompts and hosted editors

### Multi-Workspace Lifecycle

Goal:

- support multiple resident hosted workspaces with explicit lifecycle state

Done:

- active, loading, loaded, and unloaded hosted workspace states
- resident workspaces keyed by worktree path
- restart restore of resident hosted workspaces
- shared in-flight restore to avoid partial startup snapshots
- renderer unload handshake during workspace unload and app quit
- hosted integrated-browser ownership cleanup during unload

Validation:

- manual switching across multiple real projects
- verify hidden workspaces resume quickly
- verify unload frees the hosted workspace without deleting project entries
- verify restart restores one active workspace
- verify app quit flushes hosted workspace state

### Extension And Browser Hardening

Goal:

- keep the Omni shell lightweight and keep integrated browser views usable from
  hosted workspaces

Done:

- centralized Hucode extension enablement policy
- theme-only user extension filtering for the Omni shell
- selected built-in extension suppression for shell startup
- hosted integrated browser views as top-level native siblings
- hosted browser view visibility, z-order, and unload ownership tracking

Validation:

- inspect shell and hosted extension-host logs
- open integrated browser tabs inside hosted workspaces
- switch workspaces while browser tabs are visible
- unload hosted workspaces with browser tabs open

## Active

### Upgrade And Release Discipline

Goal:

- keep Hucode rebases onto upstream VS Code releases repeatable and reviewable

Work:

- keep `repo-strategy.md` and the upgrade skill aligned after each release
- publish `upstream-<version>` and `series-<version>` branches to origin
- create aggressive replay branches from the previous series when useful
- run `npm install` before replaying commits onto a new upstream branch
- keep root `product.json` and upstream resources clean after Hucode commands

Validation:

- `npm run precommit`
- `npm run hucode:validate`
- tree-equivalence checks when creating replay branches
- manual launch smoke test after each upgrade

### Hosted Workspace Reliability

Goal:

- make resident hosted workspaces boring under startup, shutdown, focus changes,
  and native view churn

Work:

- continue hardening restore, unload, and app quit sequencing
- test hidden and restored hosted workspaces with real projects
- keep browser views, devtools, and utility process ownership tied to hosted
  `webContentsId`
- document any new native view gotchas in `agent-instructions.md`

Validation:

- repeated launch, switch, unload, reload, and quit cycles
- integrated browser interaction after workspace switches
- extension host and utility process startup log review

### Documentation Harness

Goal:

- keep future agents pointed at the right Hucode context without overloading
  root instructions

Work:

- keep root `AGENTS.md` as a small loader
- keep Hucode operational rules in `agent-instructions.md`
- update architecture when subsystem ownership changes
- update this roadmap when active work moves to completed

Validation:

- markdown review after Hucode architecture changes
- verify new hard-won gotchas are recorded in `agent-instructions.md`

## Later

Loaded resident workbenches are treated like multiple normal VS Code windows:
users can keep as many open as their machine can reasonably support, and
explicit unload remains the primary resource control.

### CI Production Builds

Goal:

- produce production-ready Hucode builds for every supported platform through
  GitHub Actions

Work:

- define the supported platform matrix for Hucode releases
- wire GitHub Actions jobs for production builds on each supported platform
- publish build artifacts from CI in a consistent layout
- keep release build and archive flows documented around CI entrypoints
- verify OpenVSX signature handling in production builds
- add repeatable smoke checks for packaged CI artifacts

Validation:

- CI runs `npm run hucode:build:production` or the platform-specific release
  wrapper for each supported platform
- CI archives the expected Hucode artifacts for every platform
- packaged app launch and extension install smoke tests pass on supported
  platforms where automation is practical
