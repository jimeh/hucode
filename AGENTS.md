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
- Hucode's app release version lives in the overlay as `hucodeVersion`.
  Keep upstream `version` for VS Code compatibility and extension checks.
- Workbench `TreeView` selection/reveal paths operate on the live `ITreeItem`
  instances in the tree model, not synthetic `{ handle }` placeholders. Cache
  and reuse the provider-produced items when restoring selection.
- Omni shell controls that need to appear beside the macOS traffic lights
  should be anchored in the sidebar title toolbar, not a body-level overlay or
  the right-hand titlebar part. The top-left traffic-light strip behaves
  differently enough that floating controls there are brittle.
- The Omni right-hand workspace surface should be a dedicated Hucode `Part`,
  not a `ViewContainerLocation.ChatBar` pane-composite. Reusing the chatbar
  scaffold leaks sessions/chat title menus and secondary-sidebar affordances
  into the Omni shell.
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
- Omni shell should stay close to a real workbench window bootstrap.
  Suppressing unsupported shell affordances like Settings belongs at the
  command/menu/keybinding layer, not by replacing core window, layout, or
  editor services with shell-only stubs.
- Hosted Omni workbenches need the normal renderer unload handshake before
  their `WebContentsView` is destroyed. If you tear them down directly from the
  shell main process without sending `vscode:onBeforeUnload` /
  `vscode:onWillUnload`, workspace UI state can reopen from stale storage.
- Omni window close and app quit need to join hosted-workspace shutdown from
  the shell renderer's own `onWillShutdown` path. If the shell only destroys
  hosted `WebContentsView`s after the window starts going away, the child
  workbenches can miss their final state flush.
- Hosted Omni workspaces run in their own `WebContentsView`, so Electron's
  `vscode-file://` and `vscode-webview://` request filters will block the
  nested workbench unless that hosted renderer is explicitly added to the
  trusted internal allowlist before `loadURL()`.
- `getSingleFolderWorkspaceIdentifier()` returns `undefined` for local folders
  unless you pass a real `fs.Stats`. For hosted/local single-folder workspaces,
  resolve the stat first or the workbench will boot as "No Folder Opened".
- Hosted Omni workspaces currently boot through
  `vs/workbench/workbench.desktop.main.js`, not `vs/hucode/omni.desktop.main.js`.
  Hosted-only commands or services must be imported into the standard desktop
  workbench bundle if they need to appear inside the embedded workspace.
- Hosted Omni workspace `WebContentsView`s are deliberately laid out from
  `y: 0` so their own titlebars are visible. Keep shell titlebar drag regions
  pointer-transparent over the hosted surface and re-add the active hosted view
  when showing, laying out, or focusing it so Electron keeps it topmost.
  Otherwise hosted titlebar controls can turn into shell window-drag hit areas.
- Omni sidebar startup should open `workbench.hucode.projectSwitcher`
  directly. Restoring the generic default sidebar container can briefly render
  Explorer/"No Folder Opened" before Projects replaces it.
- Omni Projects is shell-owned under `src/vs/hucode/browser/parts/projectsPart.ts`,
  not a registered workbench view/container. Keep Explorer/SCM/Search out of the
  Omni sidebar by routing Projects focus through the shell part and leaving
  sidebar pane-composite opens as no-ops in the Omni pane-composite service.
- Hosted Omni workspaces should only transition from `loading` to `loaded` or
  `active` after the child workbench reports `LifecyclePhase.Restored`. An
  Electron `loadURL()` completion only means the renderer document loaded.
- Integrated browser `WebContentsView`s inside hosted Omni workbenches should
  stay top-level `contentView` siblings, not children of the hosted workbench
  `WebContentsView`. Use the hosted view only to calculate offsets and sync
  visibility/z-order from the Omni shell; nested parenting can leave browser
  contents visible but not hit-testable.
- Omni shell native menu/action IPC arrives in the shell renderer. Keep
  Projects-tree actions in the shell, and forward other `vscode:runAction` and
  `vscode:runKeybinding` payloads from `NativeWindow` to the active hosted
  workspace instead of routing them from the main-process menubar.
- Hosted Omni paste cannot rely on `targetWindowId` alone:
  `NativeHostMainService.triggerPaste()` resolves that id to the shell
  `BrowserWindow.webContents`. Use the Hucode shell service to trigger native
  paste on the active hosted `WebContentsView`.
- Hucode uses OpenVSX for its extension gallery. OpenVSX `VsixSignature`
  archives are not valid Microsoft `vsce-sign` signatures; release builds need
  `node-ovsx-sign` available in production dependencies to verify them.
