# Hucode Omni

Omni is Hucode's persistent outer shell. It keeps project navigation and
workbench lifecycle separate from the VS Code workbench running for any one
folder. Switching folders can therefore reuse an already loaded workbench
instead of opening another application window.

## Projects, Worktrees, and Workbenches

The Projects sidebar combines two related catalogs:

- A **project** is a saved git repository. Hucode discovers its git worktrees
  and nests them beneath the project.
- A **worktree** is one checkout belonging to a project. Selecting it opens or
  activates a hosted VS Code workbench for that checkout.
- A **workbench** is an arbitrary saved folder that is not currently represented
  by a project worktree. It remains in the Workbenches section when unloaded.

If an arbitrary workbench later becomes a known project worktree, the project
record becomes authoritative and Hucode removes the duplicate catalog entry.

A common workflow is:

1. Add an existing repository as a project.
2. Create or discover worktrees beneath that project.
3. Select worktrees to load them as needed.
4. Suspend or unload workbenches that should release resources.

Use **Add Workbench** when a folder does not need project or git-worktree
management.

The sidebar monitors Git metadata directly without activating the full VS Code
Git extension. Project worktrees show their branch, and arbitrary workbenches
show the current branch (or `Detached`) when their folder is inside a Git
worktree. Non-Git workbenches continue to show only their name and path.
Serve-web binds these ephemeral observations to the sidebar event-stream
session, releases them when that client disconnects, and re-registers the
current target set after EventSource reconnects. Each serve-web registration
accepts at most 128 target folders, and Git discovery runs through a bounded
worker pool.

Compact project-worktree rows show the name followed by branch/status, while
compact arbitrary-workbench rows show the name followed by path. The secondary
field truncates before the name. Two-line project-worktree rows place the name
and optional path on the first line with branch/status below. Two-line arbitrary
workbenches place the name and optional branch/status on the first line and keep
the path on the second line. Project paths and the compact inline metadata
icons can be hidden independently in settings.

## Workbench Lifecycle

Omni tracks the desired and actual state of each hosted workbench:

| State | Meaning |
| --- | --- |
| `restore-pending` | Selected for startup restoration but not loading yet. |
| `loading` | Its hosted VS Code workbench is starting. |
| `active` | Loaded, visible, and receiving workbench commands. |
| `loaded` | Loaded in memory but currently hidden. |
| `dormant` | Intended to remain loaded, but no renderer exists yet. Activating it materializes the workbench. |
| `unloaded` | Explicitly released and not selected for eager restoration. |
| `missing` | Its saved folder is currently unavailable. |
| `crashed` | Its hosted renderer exited unexpectedly. |

The related actions have deliberately different meanings:

- **Suspend** releases a live renderer while retaining the intent to keep that
  workbench available. It becomes dormant and remains eligible for restoration.
- **Unload** releases the renderer and marks the workbench as explicitly
  unloaded. Its project or catalog entry remains available.
- **Dismiss** unloads an arbitrary workbench and removes its Workbenches entry.
- **Remove Worktree** is a separate git operation that can delete a checkout.
  Its confirmation dialog previews uncommitted paths: clean worktrees offer
  **Delete**, while dirty worktrees require **Force Delete** and discard the
  listed changes. Very large previews show at most 1,000 paths plus the number
  omitted. Treat it as destructive; it is not a synonym for unload or dismiss.

Hidden loaded workbenches still use memory and processes. Suspend or unload
them when fast switching is less important than resource use.

## Startup Restoration

`hucode.omni.restoreHostedWorkbenches` controls which previously desired-loaded
workbenches start immediately:

- `active` restores only the last active workbench and leaves the rest dormant.
  This is the default.
- `all` restores every desired-loaded workbench.
- `none` leaves all desired-loaded workbenches dormant until selected.

This setting applies to both desktop Omni and serve-web Omni.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `hucode.omni.restoreHostedWorkbenches` | `active` | Choose `active`, `all`, or `none` for eager startup restoration. |
| `hucode.omni.treeIndent` | `8` | Set Projects tree indentation from 4 to 40 pixels. |
| `hucode.omni.workbenchItemLayout` | `twoLine` | Use `compact` or `twoLine` rows for arbitrary workbenches. |
| `hucode.omni.worktreeItemLayout` | `twoLine` | Use `compact` or `twoLine` rows for project worktrees. |
| `hucode.omni.showWorktreePaths` | `true` | Show paths for root and linked project worktrees. Arbitrary workbench paths remain visible. |
| `hucode.omni.showInlineIcons` | `true` | Show compact branch and folder icons beside row metadata. |
| `hucode.omni.titleBar.projectControls.enabled` | `true` | Show project controls in the custom title bar when the Projects sidebar is hidden. |

## Desktop and Serve-Web

Desktop Omni hosts each workbench in an Electron `WebContentsView` within one
native window. Serve-web Omni provides the same shell model in the browser and
hosts workbenches in same-origin iframes.

Start the web shell with:

```sh
hucode serve-web
```

Hucode-specific web routes are enabled by default. Pass `--no-omni` to keep
upstream behavior instead: `/` is the regular workbench and the Omni routes do
not exist. By default, routes beneath the configured server base path are:

| Route | Surface |
| --- | --- |
| `/` | Omni shell |
| `/omni` | Omni shell alias |
| `/workbench` | Regular standalone web workbench |
| `/omni/workbench` | Hosted workbench used by Omni iframes |

Browser limitations still apply. A web shell cannot focus an existing browser
tab in the same way the desktop app can focus a native view.

## Current Scope

Omni's hosted-workbench path is centered on single-folder workbenches. VS Code
workspace files, multi-root workspaces, remote-authority windows, and empty
workbenches continue through standalone workbench behavior rather than being
fully managed as hosted Omni entries.

For implementation details and invariants, see
[Hucode Architecture](architecture.md).
