# Hucode Architecture

## Product Goal

Hucode is a VS Code fork with a persistent project manager shell around one or
more hosted workspaces. The shell owns global navigation, project state, and
workspace lifecycle. Individual workspaces continue to run as VS Code
workbenches.

The core user experience is:

- one native window
- a left-side project switcher
- saved projects with nested git worktrees
- fast switching between workspaces
- explicit loaded, dormant, and unloaded workspace states

## Why A Shell

VS Code's normal workbench assumes one workspace per renderer. Hucode should
keep that assumption inside each hosted workspace instead of trying to force
multiple workspaces into one workbench DOM tree.

That means the project manager should live in a Hucode-owned shell, with
workspace UIs hosted beside it through Electron `WebContentsView`.

## Runtime Shape

### Hucode shell

The shell is responsible for:

- the project switcher UI
- project and worktree persistence
- commands that operate above a single workspace
- deciding which workspaces are loaded
- layout, focus, and handoff between hosted workspaces

### Workspace renderer

Each loaded workspace remains a mostly normal VS Code desktop workbench with
its own renderer process and extension host behavior.

The Hucode shell should treat a workspace as a hosted unit with:

- identity
- bounds
- visibility
- focus state
- lifecycle state
- crash and reload handling

## Relevant Upstream Areas

These upstream areas are likely the main seams for Hucode work:

- `src/vs/code/electron-main`
- `src/vs/platform/browserView/electron-main`
- `src/vs/workbench/contrib/browserView/electron-browser`
- `src/vs/workbench/electron-browser`
- `src/vs/workbench/workbench.desktop.main.ts`

The existing `browserView` implementation in VS Code is the strongest starting
point for hosted workspace views. It already deals with native view attachment,
visibility, layout, focus, screenshots, and DOM overlays.

## Core Hucode Subsystems

### Project registry

Stores the user-defined list of projects and their worktrees.

Suggested responsibilities:

- add or remove saved projects
- discover worktrees under each project
- persist ordering, labels, and pinned state
- remember the last active workspace per project

Suggested model:

- `ProjectRecord`
- `WorktreeRecord`
- `WorkspaceHandle`

### Git worktree service

Wraps git operations needed by the project manager.

Suggested responsibilities:

- list worktrees
- create worktrees
- remove worktrees
- validate git state before destructive operations
- surface branch and path metadata to the UI

This should live in the main process or a privileged backend layer, not inside
renderer-only code.

### Workspace host service

Owns hosted workspace instances and transitions between them.

Suggested states:

- `unloaded`
- `loading`
- `active`
- `loaded`
- `dormant`
- `crashed`

Suggested responsibilities:

- create and destroy hosted workspace views
- show and hide views
- warm-switch between loaded workspaces
- unload on demand
- enforce memory policy later

### Shell UI

Provides the persistent left-side project switcher.

Suggested UI behavior:

- projects render as top-level items
- worktrees render as nested items
- active workspace is visually obvious
- loaded but hidden workspaces have a distinct state
- unload is separate from remove

The shell UI should be deliberately separate from the workspace's own activity
bar and side bar.

## Suggested Code Placement

Initial additive structure:

- `src/vs/platform/projectManager/common`
- `src/vs/platform/projectManager/electron-main`
- `src/vs/workbench/contrib/projectSwitcher`
- `src/vs/hucode`

Use the existing VS Code layering where possible:

- `common` for contracts and models
- `electron-main` for privileged process work
- `electron-browser` for desktop renderer integrations

## Main Risks

- focus and keyboard routing across hosted native views
- command routing between shell scope and active workspace scope
- notification, quick pick, dialog, and titlebar ownership
- extension host memory cost when multiple workspaces stay loaded
- backup, restore, and crash recovery per workspace instance

## Non-Goals For The First Cut

- sharing one renderer across multiple workspaces
- deep extension host virtualization
- perfect memory management from day one
- replacing the internals of the VS Code workbench
