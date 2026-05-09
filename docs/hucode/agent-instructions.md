# Hucode Agent Instructions

These instructions capture Hucode-specific conventions and gotchas. Read this
file before changing Hucode code, Hucode docs, Hucode build scripts, or shared
VS Code code that Hucode customizes.

## Product Identity And Release Overlay

- A shallow import of a VS Code release tag is not enough for the first push to
  `origin`. Before publishing the repo, fetch enough history for the selected
  release line and fetch reachable Git LFS objects, or GitHub may reject the
  push with missing object errors.
- Hucode product identity is applied through the tracked overlay under
  `build/hucode/mixin/stable/` and staged into the working tree only for
  Hucode-specific wrapper commands. Keep root `product.json` as upstream OSS.
- Hucode macOS app icons are sourced from `build/hucode/icons/darwin/` and
  generated into the stable mixin overlay. Keep `resources/darwin/code.icns`
  upstream OSS; run `npm run hucode:generate-icons` to refresh Hucode
  `code.icns` and `Assets.car`. The legacy-inset `code.icns` comes from
  `actool`'s generated compatibility ICNS.
- Hucode's app release version lives in the overlay as `hucodeVersion`. Keep
  upstream `version` for VS Code compatibility and extension checks.
- Hucode uses OpenVSX for its extension gallery. OpenVSX `VsixSignature`
  archives are not valid Microsoft `vsce-sign` signatures; release builds need
  `node-ovsx-sign` available in production dependencies to verify them.

## Local Workflow

- `npm run hucode:prepare` generates the Hucode mixin overlay.
- `npm run hucode:validate` verifies the Hucode mixin and generated output.
- In a clean worktree, run `npm run hucode:prepare` before
  `npm run hucode:validate`; validation reads the generated files under
  `.build/distro/mixin/stable/`.
- `npm run hucode:run` prepares the Hucode mixin overlay and launches existing
  compiled output.
- Run `npm run hucode:watch` for incremental rebuilds while developing, or
  `npm run hucode:compile` before launch for a full one-shot rebuild.
- `npm run hucode:compile` must build the client, built-in extension outputs,
  and extension media. Using only `transpile-client` cleans `out/` but leaves
  files like `extensions/git-base/out/extension.js` and `codicon.ttf` missing.
- When launching `npm run hucode:run` from an integrated Hucode extension-host
  terminal, clear inherited Electron/VS Code process env such as
  `ELECTRON_RUN_AS_NODE` and `VSCODE_ESM_ENTRYPOINT`; otherwise the app binary
  can run as Node and fail before the Electron main process starts.

## CI Workflow

- Hucode GitHub Actions should use only standard GitHub-hosted runner labels by
  default. Do not reintroduce upstream VS Code self-hosted `1ES.Pool` runners or
  larger macOS runners such as `macos-14-xlarge` unless the cost and need are
  explicitly accepted.
- Keep disabled upstream VS Code workflows in `.github/workflows.disabled/`
  with their contents unchanged where practical. Only Hucode-owned workflows
  should live in `.github/workflows/` by default.
- Keep PR CI Hucode-focused: product mixin validation, compile/hygiene/lint/type
  gates, Node unit tests, and targeted Hucode Electron tests. Treat full
  upstream VS Code electron/browser/remote/integration/smoke matrices as a
  separate deliberate decision, not the default fork baseline.
- Hucode warms Linux x64 `node_modules` archives through
  `.github/workflows/hucode-node-modules-cache.yml` on trusted branch pushes or
  manual dispatch. PR CI should restore those archives but not save them; keep
  cache writes out of untrusted pull-request execution.
- Keep heavyweight CI gates as separate workflow steps. Running `core-ci`,
  `hygiene`, eslint, and TypeScript checks in one parallel `npm-run-all2` step
  can leave GitHub Actions showing only a generic cancellation line and hide the
  failing check. Run hygiene before `core-ci`; the compile step can generate
  `extensions/*/tsconfig.tsbuildinfo`, which hygiene flags as missing copyright
  headers if it runs afterward.
- The initial Hucode CI baseline intentionally omits `tsec-compile-check`.
  Existing Omni import-map bootstrap code trips VS Code's Trusted Types tsec
  rules; re-enable this gate only after that code has been reviewed, fixed, or
  explicitly exempted.
- Linux Electron tests on GitHub-hosted runners need Chromium sandbox setup:
  enable unprivileged user namespaces for Ubuntu runners, install
  `bubblewrap`/`socat`, set `.build/electron/chrome-sandbox` to root-owned
  mode `4755`, and run `scripts/test.sh` with `VSCODE_SKIP_PRELAUNCH=1` so the
  prelaunch step does not replace the prepared sandbox binary.

## Omni Shell Boundaries

- Hucode macOS desktop workbenches default `window.menuStyle` to `native`
  through `src/vs/workbench/electron-browser/hucodeConfiguration.contribution.ts`.
  Hosted Omni workbenches boot the standard desktop bundle, so keep this
  contribution imported from `workbench.desktop.main.ts` as well as Omni.
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
- The Omni shell now owns its forked workbench and pane parts under
  `src/vs/hucode/browser/`. When changing Omni titlebar/sidebar/panel layout,
  prefer the Hucode-local shell files over the sessions equivalents.
- Omni should not depend on `src/vs/sessions/browser/*` shell files anymore.
  If a change still needs sessions code, prefer shared services/context keys or
  fork the UI piece into `src/vs/hucode/browser/` instead of layering CSS hacks
  onto the sessions shell.
- The Omni right-hand workspace surface should be a dedicated Hucode `Part`,
  not a `ViewContainerLocation.ChatBar` pane-composite. Reusing the chatbar
  scaffold leaks sessions/chat title menus and secondary-sidebar affordances
  into the Omni shell.
- Omni shell controls that need to appear beside the macOS traffic lights
  should be anchored in the sidebar title toolbar, not a body-level overlay or
  the right-hand titlebar part. The top-left traffic-light strip behaves
  differently enough that floating controls there are brittle.
- Omni Projects title controls mirror the workbench titlebar's optional
  `titleBar.border`; that border reduces the titlebar content height by 1px in
  themes such as Dark 2026 and changes toolbar icon centering.
- The Omni Projects sidebar should keep a real minimum width. Letting it shrink
  too far effectively hides it and strands the macOS traffic-light area.

## Projects And Worktrees

- The project manager is a single Electron main-process service exposed to
  Omni and hosted workbench renderers through the `projectManager` channel.
  Put project/worktree watchers in that service so they are shared globally
  instead of duplicated per renderer.
- Workbench `TreeView` selection/reveal paths operate on the live `ITreeItem`
  instances in the tree model, not synthetic `{ handle }` placeholders. Cache
  and reuse the provider-produced items when restoring selection.
- Omni sidebar startup should open `workbench.hucode.projectSwitcher`
  directly. Restoring the generic default sidebar container can briefly render
  Explorer/"No Folder Opened" before Projects replaces it.
- Omni Projects is shell-owned under
  `src/vs/hucode/browser/parts/projectsPart.ts`, not a registered workbench
  view/container. Keep Explorer/SCM/Search out of the Omni sidebar by routing
  Projects focus through the shell part and leaving sidebar pane-composite
  opens as no-ops in the Omni pane-composite service.
- View and view-container registries are renderer-local. For hosted Omni
  workbenches, suppress redundant UI by deregistering the view/container in the
  hosted renderer instead of persisting hidden state, or regular workbench
  windows can lose the view too.

## Hosted Workspace Lifecycle

- Hosted Omni workbenches must identify themselves as child renderers, not just
  by the owning window id. Extension-host and utility-process startup replies
  need the hosted `webContentsId`, or they will route their message ports back
  to the Omni shell renderer.
- Omni resident workbenches are keyed by worktree path. Hidden workbenches stay
  loaded and switch back to `active` instead of being recreated on each
  selection change.
- Omni resident-workspace restore must always choose one active workspace, even
  for older restore entries without an explicit `active` state. Shell-to-workspace
  action forwarding should wait for restore before looking up the active hosted
  workbench.
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
- Hidden resident hosted workbenches should be removed from the window
  `contentView`, not just `setVisible(false)`. Invisible Electron view siblings
  can still disturb native hit testing when several workbenches restore at
  startup.
- Hosted Omni workspaces should only transition from `loading` to `loaded` or
  `active` after the child workbench reports `LifecyclePhase.Restored`. An
  Electron `loadURL()` completion only means the renderer document loaded.
- Hosted Omni workspace restore must share one in-flight restore promise.
  `getWindowState()` is called by multiple shell parts during startup, and a
  partial restore snapshot makes Projects miss loaded worktrees and unload
  actions.
- Hosted Omni workbench unload must explicitly destroy integrated browser
  views owned by that hosted `webContentsId`; those views are top-level
  siblings, so removing the workbench view will not remove them.

## Integrated Browser Views

- Integrated browser `WebContentsView`s inside hosted Omni workbenches should
  stay top-level `contentView` siblings, not children of the hosted workbench
  `WebContentsView`. Use the hosted view only to calculate offsets and sync
  visibility/z-order from the Omni shell; nested parenting can leave browser
  contents visible but not hit-testable.

## Command, Menu, And Clipboard Routing

- Omni shell native menu/action IPC arrives in the shell renderer. Keep
  Projects-tree actions in the shell, and forward other `vscode:runAction` and
  `vscode:runKeybinding` payloads from `NativeWindow` to the active hosted
  workspace instead of routing them from the main-process menubar.
- Native menu accelerator IPC can arrive at the Omni shell while the focused
  hosted `WebContentsView` also receives the physical keydown. Do not inject a
  synthetic `vscode:runKeybinding` into an already-focused hosted workspace.
- Keep Omni command-forwarding policy in Hucode-named helpers near the layer
  that consumes them. Generic workbench files can import same-layer `hucode*`
  helpers or lower-layer platform helpers, but should not import from
  `src/vs/hucode/*`.
- Omni shell DOM keybindings do not use the native menu IPC path. When Projects
  has focus, the shell renderer resolves shortcuts locally and calls
  `ICommandService.executeCommand`, so shortcut forwarding needs an Omni-local
  command service route as well as the native `vscode:runKeybinding` handler.
- Keep Omni command forwarding command-id based. Native menu accelerators can
  arrive as user-settings labels, but label allowlists do not track user
  keybinding customizations; forward those labels to the active workspace first.
- Omni shell commands that should prefer the active hosted workbench but still
  work with no loaded workspace should self-forward through
  `IHucodeShellService.runActionInWorkspace()` and fall back locally when it
  returns `false`.
- Keep the Omni command-service route scoped to Projects focus. Shell QuickInput
  widgets are renderer-local; forwarding their `quickInput.accept` or clipboard
  commands breaks project rename and other shell prompts.
- Hosted Omni paste cannot rely on `targetWindowId` alone:
  `NativeHostMainService.triggerPaste()` resolves that id to the shell
  `BrowserWindow.webContents`. Use the Hucode shell service to trigger native
  paste on the active hosted `WebContentsView`.
- Do not catch shell `Cmd+V` in Electron `before-input-event`. That runs before
  the renderer can inspect focused DOM and will steal paste from shell
  QuickInput prompts. Let renderer keybinding/clipboard routing decide when
  Projects focus should forward paste.

## Extension Filtering

- The Omni Projects shell does not need VS Code's extension-host Git
  integration for project/worktree lists. Those flows use the main-process
  `GitWorktreeService`, so shell startup can suppress non-theme user extensions
  and selected Git/GitHub, debug, task, terminal, and tunnel built-ins without
  breaking Projects.
- `enableExtensions` does not override `disableExtensions: true`. If Omni
  needs selected user extensions available, use the explicit Hucode extension
  enablement policy instead of blanket disabling all installed extensions.
- Omni shell user-extension filtering is controlled by
  `hucodeExtensionEnablementPolicy`, not `isOmniWindow` alone. Shell and hosted
  workbench extension-host logs can share `windowN/` paths, so verify resident
  hosted workspace state before assuming a `windowN/exthost` entry is from an
  embedded workspace.
- The Omni shell's local extension host can receive extensions from the cached
  scanner before later enablement checks are visible in logs. Keep the
  theme-only user-extension policy enforced at scan time as well as enablement
  time.
- Keep Omni shell extension-filtering policy in
  `src/vs/workbench/services/extensions/common/hucodeExtensionEnablementPolicy.ts`
  so upstream extension scanner and enablement service edits stay thin.

## Other Hucode Gotchas

- Keep high-volume `ILocalPtyService` stream events lazy when exposing the
  main-process `localPty` channel through `ProxyChannel.fromService`. Desktop
  workbenches consume terminal data through `PtyHostWindow`, and eager buffering
  of `onProcessData`, `onProcessReady`, or `onDidChangeProperty` can trigger
  dev-mode `Event.buffer` leak warnings with no renderer listener attached.
