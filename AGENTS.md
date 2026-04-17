# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Hucode fork notes

- A shallow import of a VS Code release tag is not enough for the first push to
  `origin`. Before publishing the repo, fetch enough history for the selected
  release line and fetch reachable Git LFS objects, or GitHub may reject the
  push with missing object errors.
- Hucode product identity is applied through the tracked overlay under
  `build/hucode/mixin/stable/` and staged into the working tree only for
  Hucode-specific wrapper commands. Keep root `product.json` as upstream OSS.
- Workbench `TreeView` selection/reveal paths operate on the live `ITreeItem`
  instances in the tree model, not synthetic `{ handle }` placeholders. Cache
  and reuse the provider-produced items when restoring selection.
- Omni shell controls that need to appear beside the macOS traffic lights
  should be anchored in the sidebar title toolbar, not a body-level overlay or
  the right-hand titlebar part. The top-left traffic-light strip behaves
  differently enough that floating controls there are brittle.
- The Omni Projects sidebar should keep a real minimum width. Letting it shrink
  too far effectively hides it and strands the macOS traffic-light area.
- The Omni shell now owns its forked workbench and pane parts under
  `src/vs/hucode/browser/`. When changing Omni titlebar/sidebar/panel layout,
  prefer the Hucode-local shell files over the sessions equivalents.
- Omni should not depend on `src/vs/sessions/browser/*` shell files anymore.
  If a change still needs sessions code, prefer shared services/context keys or
  fork the UI piece into `src/vs/hucode/browser/` instead of layering CSS hacks
  onto the sessions shell.
- View and view-container registries are renderer-local. For hosted Omni
  workbenches, suppress redundant UI by deregistering the view/container in the
  hosted renderer instead of persisting hidden state, or regular workbench
  windows can lose the view too.
- Hosted Omni workbenches must identify themselves as child renderers, not just
  by the owning window id. Extension-host and utility-process startup replies
  need the hosted `webContentsId`, or they will route their message ports back
  to the Omni shell renderer.
- Omni resident workbenches are keyed by worktree path. Hidden workbenches stay
  loaded and switch back to `active` instead of being recreated on each
  selection change.
- Omni windows cannot be implemented as a normal workbench contribution overlay.
  They need their own renderer entrypoint and shell bootstrap, otherwise the
  standard workbench still renders underneath any custom DOM.
- Omni windows also must not import `sessions.desktop.main.ts` wholesale. If
  they need the sessions shell layout, wire only the required shell pieces and
  explicitly override `IPaneCompositePartService`.
- Hosted Omni workspaces run in their own `WebContentsView`, so Electron's
  `vscode-file://` and `vscode-webview://` request filters will block the
  nested workbench unless that hosted renderer is explicitly added to the
  trusted internal allowlist before `loadURL()`.
- `getSingleFolderWorkspaceIdentifier()` returns `undefined` for local folders
  unless you pass a real `fs.Stats`. For hosted/local single-folder workspaces,
  resolve the stat first or the workbench will boot as "No Folder Opened".
