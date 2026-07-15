# Hucode Agent Instructions

These instructions capture Hucode-specific conventions and gotchas. Read this
file before changing Hucode code, Hucode docs, Hucode build scripts, or shared
VS Code code that Hucode customizes.

## Product Identity And Release Overlay

- Hucode's current tree does not require Git LFS. Older reachable commits may
  still contain upstream Copilot simulation cache LFS pointers; publishing or
  replaying that history to a new remote can require the corresponding LFS
  objects unless the history is rewritten first.
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
- Hucode update responses use `productVersion` for the underlying VS Code
  compatibility version and `hucodeVersion` for the app release version. macOS
  Squirrel update events can drop extra update JSON fields and report the feed
  `name` as `productVersion`, so keep Hucode-specific update display/merge
  behavior in
  `src/vs/platform/update/common/hucodeUpdateVersion.ts`.
- Hucode uses OpenVSX for its extension gallery. OpenVSX `VsixSignature`
  archives are not valid Microsoft `vsce-sign` signatures; release builds need
  `node-ovsx-sign` available in production dependencies to verify them.

## Local Workflow

- `npm run hucode:prepare` generates the Hucode mixin overlay.
- `npm run hucode:validate` verifies the Hucode mixin and generated output.
- `npm run hucode:prepare-release -- --version <version>` consumes
  `.changes/*.md` fragments, updates `CHANGELOG.md`, and bumps
  `build/hucode/mixin/stable/product.json` `hucodeVersion`.
- `npm run hucode:run` prepares the Hucode mixin overlay and launches existing
  compiled output.
- `npm run hucode:web` prepares the Hucode mixin overlay and launches the
  local serve-web development server from existing compiled output.
- Run `npm run hucode:watch` for incremental rebuilds while developing, or
  `npm run hucode:compile` before launch for a full one-shot rebuild.
- `npm run hucode:compile` must build the client, built-in extension outputs,
  and extension media. Using only `transpile-client` cleans `out/` but leaves
  files like `extensions/git-base/out/extension.js` and `codicon.ttf` missing.
- When launching `npm run hucode:run` from an integrated Hucode extension-host
  terminal, clear inherited Electron/VS Code process env such as
  `ELECTRON_RUN_AS_NODE` and `VSCODE_ESM_ENTRYPOINT`; otherwise the app binary
  can run as Node and fail before the Electron main process starts.

## Code Documentation

- Add concise JSDoc for new Hucode-owned exported functions, interfaces, enums,
  and classes, especially when extracting helpers out of upstream-heavy files.
  Keep comments focused on behavior and contracts so automated docstring review
  checks do not flag avoidable omissions.

## Upstream Patch Boundaries And Tests

- Keep upstream VS Code files as thin integration points for Hucode behavior.
  When extracting Hucode behavior out of an upstream-owned file, move the
  decision-making and error/result mapping into Hucode-owned helpers, services,
  or clearly named `hucode*` companions, leaving the upstream file with imports,
  service injection, feature checks, and delegation calls only where practical.
- Prefer `src/vs/hucode/` for Hucode-owned logic when layer rules allow it. If
  VS Code import restrictions block a `src/vs/hucode/` dependency, place a
  clearly named `hucode*` companion beside the upstream integration point and
  keep the upstream patch small.
- Preserve or improve focused test coverage when moving behavior. Put tests
  near the code they exercise: `src/vs/hucode/test/...` for Hucode-owned modules
  under `src/vs/hucode/`, and the matching subsystem's `test/...` tree for
  layer-compatible `hucode*` companion files.
- Prefer new Hucode-named test files for Hucode-specific coverage instead of
  adding tests to existing upstream VS Code test files. Use names such as
  `hucode*.test.ts` and keep upstream test files unchanged unless the test is a
  narrow integration assertion that depends heavily on upstream fixtures.
- For Hucode behavior changes, assume tests are required unless they are not
  practical or would be lower value than manual verification. Before finalizing
  or committing, inspect nearby test suites and either add focused automated
  coverage for new state, command, routing, persistence, or lifecycle behavior,
  or explicitly state why no reasonable automated coverage was added.
- For Omni shell and resident-workbench changes, prefer stable coverage
  boundaries over brittle DOM assertions: main-process controller state tests,
  command routing/forwarding tests, then browser component/DOM tests only when
  the behavior cannot be covered at a lower layer. Cover empty-window,
  no-workbench, last-workbench close/unload/crash, command-palette, keybinding,
  and context-key transitions when touched.
- Resident Omni hosted-workbench visibility is reconciled centrally in
  `ResidentHostedWorkspacesController`. Keep the invariant that only the active,
  requested-visible, non-occluded live hosted workbench may be attached and
  visible; owned integrated browser views must be hidden before their host is
  detached and shown only after the host is attached.
- When splitting an upstream patch, keep high-level integration tests in the
  upstream subsystem focused on verifier/adapter selection and routing, and move
  detailed Hucode behavior tests with the extracted Hucode helper.
- `npm run test-node -- --run <file>` accepts one test file per invocation.
  Run focused Node tests separately; extra positional paths are passed through
  to Mocha and can load from `src/` instead of compiled `out/`.

## CI Workflow

- Hucode PR titles must use Conventional Commit format with commitlint's
  conventional types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
  `refactor`, `revert`, `style`, or `test`.
- Before opening or updating a Hucode PR titled with `feat`, `fix`, `perf`,
  `revert`, or a breaking `!` marker, add the matching `.changes` fragment in
  the same branch. Do this even for small fixes; the changelog CI enforces it.
- For PRs titled with `feat`, `fix`, `perf`, `revert`, or any breaking `!`
  marker, add a matching `.changes/<pr-number>-<slug>.md` fragment. Hidden
  types such as `build`, `chore`, `ci`, `docs`, `refactor`, `style`, and
  `test` may still add a fragment when the change should appear in release
  notes. The fragment's first non-empty line must match the PR title's type,
  scope, breaking marker, and subject. Do not invent a PR number; if the PR does
  not exist yet, use an unnumbered `.changes/<slug>.md` fragment and rename it
  later only if a numbered fragment is desired.
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
- When adding, moving, or modifying Hucode-specific tests, update
  `.github/workflows/hucode-ci.yml` so the relevant Node/common and
  Electron/browser tests run in CI. Keep tests in the runner environment they
  expect; for example, Node-only path/env tests should stay in `npm run
  test-node`, while Electron-main/browser tests should stay in the targeted
  `scripts/test.sh` pass.
- Hucode warms Linux x64 `node_modules` archives through
  `.github/workflows/hucode-node-modules-cache.yml` on trusted branch pushes or
  manual dispatch. PR CI should restore those archives but not save them; keep
  cache writes out of untrusted pull-request execution.
- Hucode release packaging keeps upstream app output directories such as
  `../VSCode-linux-x64` in place by default so follow-on gulp packaging tasks
  can build archives, DMGs, DEB, RPM, and setup artifacts. Use
  `--move-to-dist` only for local build commands that should relocate the app
  directory into the configured output directory, `dist/` by default.
- `build/hucode/release-build.ts --phase build` creates the final unsigned app
  output under `../VSCode-<platform>-<arch>`. This phase must include every app
  payload mutation needed before packaging, including Copilot target ripgrep
  shims and the Hucode Rust CLI. `--phase package` consumes that existing app
  output and must not rebuild or mutate the app payload before signing or
  producing release assets. Do not combine `--phase build` with
  `--move-to-dist`; package phase expects the app output to stay in its upstream
  `../VSCode-<platform>-<arch>` handoff location. The default `--phase all`
  preserves the combined local flow.
- Keep `build/hucode/release-build.ts` as TypeScript without a parallel
  hand-written `.d.ts`; `cd build && npm run typecheck` should validate its
  exported helpers directly.
- Hucode local release packaging strips source maps by default by running the
  upstream gulp build with `GITHUB_WORKSPACE` set for that subprocess. Pass
  `--include-source-maps` to `build/hucode/release-build.ts` only when a local
  package needs debuggable bundled source maps.
- For release app size work, read
  [Release Build Size Analysis](release-build-size-analysis.md). Upstream VS
  Code strips core source maps in CI, prunes production `node_modules` through
  `.moduleignore`, and injects Copilot from a separately built VSIX. Hucode's
  release workflow builds a Copilot VSIX once, uploads it as
  `hucode-copilot-vsix`, downloads it in each platform job, and passes
  `--copilot-vsix` to `build/hucode/release-build.ts`. Local release builds
  without `--copilot-vsix` still package Copilot from source and can ship a much
  larger `extensions/copilot/node_modules` tree. The release wrapper rejects a
  VSIX that already contains platform-specific Copilot executable packages or
  ripgrep binaries; the target-specific ripgrep shim is injected by the
  `vscode-*-min-ci` package task and validated afterward.
- Hucode release CI runs `build/hucode/release-size-report.js` after packaging
  each target. The report writes JSON and Markdown into the release artifact
  directory, appends the Markdown to the GitHub step summary, and currently
  warns when `extensions/copilot/node_modules` exceeds `100 MiB`. Treat this as
  a guardrail baseline until post-VSIX release artifacts establish tighter
  thresholds.
- Hucode release packaging must mix the Rust CLI into desktop outputs before
  archives, DMGs, DEB, RPM, or Windows setup artifacts are produced. Linux
  dependency generation expects `bin/<tunnelApplicationName>` to exist in
  `../VSCode-linux-*`. Hucode's Linux DEB/RPM prepare tasks run upstream
  dependency generation in warn-only mode because the added CLI can change the
  generated package dependencies; the generated dependency list is still used in
  the package metadata. The release wrapper patches generated DEB/RPM metadata
  after upstream prepare tasks so package versions come from Hucode's
  `hucodeVersion`, not upstream VS Code's `package.json` version.
- Standalone CLI release archives are packaged from the CLI already mixed into
  the assembled desktop output, not from a second Cargo build during packaging.
  Archives contain exactly one root executable named `hucode` or `hucode.exe`;
  Linux uses `.tar.gz`, while macOS and Windows use ZIP.
- Hucode macOS release builds must compile the Rust CLI against the downloaded
  `@vscode/openssl-prebuilt` macOS libraries. Do not let `hucode-tunnel` link
  Homebrew OpenSSL from `/opt/homebrew` or `/usr/local`; hardened runtime rejects
  those unsigned external dylibs inside the signed app.
- Hucode release builds publish platform-specific
  `hucode-server-<platform>-<arch>-web.zip` archives for macOS, Linux, and
  Windows x64/arm64. These archives are consumed by `hucode serve-web` via the
  `hucode-updates` update service and are built in the app-build job while the
  minified server-web inputs are available. Linux armhf has an embedded CLI
  build but no standalone CLI or server-web archive because Node.js no longer
  supports arm32.
- `hucode serve-web` starts the downloaded server through the Rust CLI's
  `tunnelServerQualities` product metadata. Keep that map aligned with
  `serverApplicationName`; otherwise the CLI can download a valid archive and
  then try to spawn the upstream `code-server-oss` entrypoint.
- The server-web archive build must stage the Hucode product mixin while
  running the `vscode-reh-web-*-min-ci` gulp task. If it packages root
  `product.json` as Code OSS while the browser bundle uses Hucode product
  metadata, `/stable-<commit>/vscode-remote-resource` requests can 404 even
  when the files exist in the extracted archive.
- Stable and insider Windows app builds expect per-arch `win32ContextMenu`
  CLSIDs in the generated product config for AppX manifest generation. Keep
  those Hucode-specific CLSIDs in `build/hucode/mixin/stable/product.json`.
- Windows release app builds run upstream `patchWin32DependenciesTask`, which
  shells out to `signtool.exe` to strip invalidated Authenticode signatures
  before `rcedit`. GitHub-hosted Windows runners can have the Windows SDK
  installed without SDK tools on PATH, so release CI must add the SDK tools
  directory before `build/hucode/release-build.ts --phase build`.
- Stable and insider Windows release app artifacts need the AppX sidecar created
  in the app-build job before upload. Run
  `node build/win32/explorer-dll-fetcher.ts .build/win32/appx` before the build
  so the Explorer command DLL is copied into the app output, then run `makeappx
  pack` against `../VSCode-win32-*/appx/manifest` after the build and remove the
  raw manifest directory before the app tarball is uploaded.
- Hucode's macOS DMG volume title comes from the overlay field
  `darwinDmgTitle`. Keep the field in the Hucode product mixin rather than
  changing upstream VS Code's stable/insider/exploration title defaults.
- Hucode macOS release signing is enabled with
  `build/hucode/release-build.ts --sign`. Signing must happen after every app
  payload mutation, including Copilot VSIX packaging, target-specific ripgrep
  shims, native modules, resources, and the mixed-in Rust CLI. Release CI ships
  macOS DMGs for manual installs and ZIPs for Squirrel.Mac auto-updates. For
  DMGs, create the DMG from the signed app before app notarization/stapling,
  sign the DMG, notarize the DMG, then staple and validate the DMG. For ZIP
  artifacts, notarize a temporary app ZIP, staple the app, then create the
  public ZIP from the stapled app. Package the standalone CLI from the signed
  app payload and submit its ZIP separately for notarization.
- Hucode's `darwin-x64` release app build uses the Intel macOS runner, but its
  package job should run on the standard arm64 `macos-15` runner. GitHub-hosted
  Intel macOS runners have repeatedly hung in `codesign --timestamp` while
  signing the x64 DMG; package phase consumes the prebuilt app artifact and
  does not need to execute target-architecture binaries.
- macOS signing CI must make the temporary signing keychain the default user
  keychain and the active user keychain search list before running
  `@electron/osx-sign`; matching upstream VS Code's keychain setup avoids
  `codesign` failures even when `security find-identity` sees the imported
  Developer ID identity. Keep that behavior behind `--signing-mode ci`; the
  default `--signing-mode local` must use the caller's existing keychain search
  list and must not change the default keychain or search list.
- `@electron/osx-sign` treats binary-looking `.wasm` files as signing
  candidates. Keep WebAssembly payloads ignored during macOS signing; they are
  not Mach-O code and cannot be signed by `codesign`.
- Hucode release CI signs macOS tag builds by default and also signs manual
  `workflow_dispatch` builds unless the dispatch input disables signing. The
  required GitHub secrets are `APPLE_NOTARIZATION_KEY_P8_BASE64`,
  `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`, and
  `MACOS_DEVELOPER_ID_APPLICATION_P12_PASSWORD`; the required GitHub variables
  are `APPLE_NOTARIZATION_ISSUER_ID`, `APPLE_NOTARIZATION_KEY_ID`, and
  `APPLE_TEAM_ID`.
- Hucode release CI publishes GitHub Releases from tag builds and uses the
  matching `CHANGELOG.md` version section as release notes. Public assets
  include macOS desktop DMG/ZIP files, Linux x64/arm64 desktop ZIP/DEB/RPM
  files, and standalone CLI and server-web archives for macOS, Linux, and
  Windows x64/arm64. Linux armhf and Windows desktop packages remain workflow
  artifacts rather than public release assets. Keep the required asset contract
  and checksums in `build/hucode/release-assets.ts`.
- Hucode stable builds use `https://updates.hucode.dev` as the built-in update
  feed. Keep `quality`, `updateUrl`, `downloadUrl`,
  `hucodeReleaseNotesUrlTemplate`, and `releaseNotesUrl` in the Hucode product
  mixin and covered by `npm run hucode:validate`; the updater disables itself
  without `updateUrl`, `commit`, and product quality.
- Hucode macOS DMGs are manual install assets. ZIPs are the Squirrel.Mac
  auto-update assets returned by the update service. Builds released before the
  product mixin includes `updateUrl` cannot discover updates automatically.
- Hucode Linux desktop updates are notification-only. The update action must
  open the latest GitHub Release for manual package selection and must not infer
  the installed package format or install an update automatically.
- After publishing GitHub Release assets, release CI must trigger
  `jimeh/hucode-updates` with repository dispatch event
  `hucode-release-published` so update metadata is refreshed for older commits.
- Do not add upstream `build/darwin/patch-dmg.py` to Hucode release packaging
  unless a Hucode `disk.icns` volume icon exists. The script only injects a
  custom Finder volume icon into an already-created DMG; it is unrelated to app
  signing or notarization and must run before DMG signing if ever enabled.
- Hucode's release wrapper cleans `.build/extensions` directly before packaging
  with an external Copilot VSIX. Upstream defines `clean-extensions-build` as an
  internal task object but does not register it as a public gulp task.
- The wrapper also runs `build/hucode/esbuild-bundle.js` directly instead of
  invoking `esbuild-bundle-<platform>-<arch>-min`; those esbuild bundle tasks
  are internal task objects, not public gulp tasks.
- The public `@vscode/openssl-prebuilt` package extracts libraries under
  `out/<arch>/`, so Linux and Windows release CI must export OpenSSL paths from
  that nested directory before building the Rust CLI. Windows uses the
  `*-windows-static` prebuilt directories, sets `OPENSSL_STATIC=1`, and builds
  the standalone CLI with a static CRT plus the matching x64/arm64 control-flow
  guard flags from upstream's CLI pipeline. Do not add Ubuntu's `armhf` foreign
  architecture for the armhf release job; the cross-compiler packages install
  without it, and Noble's default security apt source does not serve armhf
  indexes.
- VS Code's downloaded Linux sysroot toolchains are x64-hosted. They are useful
  for x64 and armhf release builds on x64 runners, but native arm64 GitHub
  runners cannot execute the arm64 sysroot compiler binary. Build the GNU
  arm64 CLI in the dedicated x64-hosted cross-build job, verify that it requires
  no newer than GLIBC 2.28, then pass it to the x64-hosted arm64 app cross-build
  through `--prebuilt-cli`. That app build runs on `ubuntu-latest` and uses QEMU
  for CLI smoke tests. Linux server-web archives must pass the matching GLIBC
  and GLIBCXX runtime-requirements audit before upload.
- Before sourcing `build/azure-pipelines/linux/setup-env.sh` in a clean release
  job, install the `build/` package dependencies. The Linux x64 setup invokes
  `build/linux/libcxx-fetcher.ts`, which imports packages such as `debug` from
  `build/node_modules` before the root `npm ci` can install them.
- GitHub's macOS release runners execute `shell: bash` steps with Bash 3.2.
  Under `set -u`, expanding an empty array raises an unbound-variable error, so
  construct commands with optional arguments using `set --` and `"$@"`.
- The initial Hucode CI baseline intentionally omits `tsec-compile-check`.
  Existing Omni import-map bootstrap code trips VS Code's Trusted Types tsec
  rules; re-enable this gate only after that code has been reviewed, fixed, or
  explicitly exempted.
- Hucode CI splits core compile into `Core Compile Checks` and separate
  desktop, server, and server-web bundle jobs through `build/hucode/core-ci.ts`.
  Keep that orchestration in Hucode-owned workflow/script files; running those
  bundles in parallel inside one GitHub-hosted Linux runner can exhaust runner
  resources and surface as a generic "operation was canceled" failure.
- The split bundle jobs intentionally prepare bundle inputs on each runner
  instead of consuming a prep artifact. `build/next/index.ts bundle` reads
  source-tree-generated inputs such as `src/.../codicon.ttf` in addition to
  `.build/extensions`, so cross-runner artifact boundaries are easy to make
  incomplete.
- Linux Electron tests on GitHub-hosted runners need Chromium sandbox setup:
  enable unprivileged user namespaces for Ubuntu runners, install
  `bubblewrap`/`socat`, set `.build/electron/chrome-sandbox` to root-owned
  mode `4755`, and run `scripts/test.sh` with `VSCODE_SKIP_PRELAUNCH=1` so the
  prelaunch step does not replace the prepared sandbox binary.
- GitHub-hosted macOS runners use Homebrew Python as an externally managed
  environment. Direct `python3 -m pip install --user ...` calls can fail with
  PEP 668; use `--break-system-packages` with `--user` for runner-local build
  tool installs, or use a dedicated Python environment.

## Omni Shell Boundaries

- Keep upstream VS Code files as thin integration points for Hucode behavior.
  If a Hucode change needs substantial logic, put that logic in a Hucode-owned
  file under `src/vs/hucode/` where layering allows it. If VS Code layer rules
  block importing `src/vs/hucode/`, use a nearby companion file with an explicit
  `hucode*` name and keep the upstream file change to minimal wiring such as an
  import, service injection, and a delegation call.
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
- The Omni Projects sidebar should keep a real minimum width. Letting it shrink
  too far effectively hides it and strands the macOS traffic-light area.

## Learnings

- In a clean worktree, run `npm run hucode:prepare` before
  `npm run hucode:validate`. Validation reads generated files under
  `.build/distro/mixin/stable/`, so prepare must run first.
- Avoid replacing GitHub's `hashFiles('.build/packagelockhash')` cache key with
  a shell hash. The values differ, so shared setup actions must use the same
  `hashFiles()` expression as the node_modules cache warmer or PR CI will miss
  warmed caches.
- Keep heavyweight CI gates as separate workflow jobs or steps. Running
  `core-ci`, `hygiene`, eslint, and TypeScript checks in one parallel
  `npm-run-all2` step can leave GitHub Actions showing only a generic
  cancellation line and hide the failing check. In Hucode CI, keep the cyclic
  dependency check with `core-ci` because it consumes `out-build`.
- Local dependency bootstrap should use `npm install`. `npm run hucode:run`
  reaches `build/lib/preLaunch.ts`, which runs `npm ci` only when the root
  `node_modules` directory is absent. Seeding root `node_modules` before launch
  avoids that fallback.
- Hucode uses npm 11.1 for `min-release-age`; repo npm configs set a 3-day
  package age gate, and CI setup upgrades to pinned npm 11.1 before dependency
  installs. VS Code's preinstall guard currently rejects npm 11.2.0 and newer.
- For parallel local git worktrees, dependency state is per worktree because
  VS Code's install hash lives under root `node_modules`. Use
  `npm run hucode:seed-worktree-node-modules` to copy every `node_modules` tree
  listed by `build/npm/dirs.ts` from a matching, already-installed worktree.
  Set `HUCODE_NODE_MODULES_SOURCE` to force the source worktree. Then run
  `node build/npm/fast-install.ts` or `npm install` to verify the install hash.
- New worktree paths can require `mise trust <worktree>/mise.toml` before
  `node`/`npm` shims work, because mise trusts config files by path.
- Omni Projects title controls mirror the workbench titlebar's optional
  `titleBar.border`. When present, such as in Dark 2026, that border reduces
  the effective titlebar content height by 1px and changes toolbar icon
  centering.

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
- Projects quick-switch MRU has two clocks: hosted workspace `lastActiveAt` is
  the live ordering source for loaded worktrees, while project-manager
  `lastVisitedAt` is the persisted fallback. Sidebar open paths must call
  `setLastActiveWorktree` immediately instead of relying on later sidebar sync.
- Omni Projects must keep resident hosted workbenches reachable when Git stops
  reporting their worktree but the project record still exists. Render those
  hosted instances as missing worktree rows under the project and avoid
  git-worktree management actions for them; unloading the resident workbench
  remains valid.
- Generic folder/workspace opens from an Omni shell or hosted Omni workbench
  must not reuse the Omni window for unknown paths. Known project worktrees
  should route through the shell; unknown folders/workspaces should open in a
  new normal workbench window.
- External `hucode <file>` CLI launches bypass renderer `IHostService`
  routing and enter the main-process `WindowsMainService` path directly.
  Keep CLI file routing in main-process code; otherwise upstream fallback can
  target the Omni shell as an empty last-active window, where `vscode:openFiles`
  is not handled by a normal editor workbench.

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
- Host-layer Omni integrations keep a local shell-service subset in
  `src/vs/workbench/services/host/electron-browser/hucodeHostedOmniHost.ts`.
  When adding shell IPC methods used by native host integration, update that
  subset along with `src/vs/hucode/common/omniWindow.ts`.
- Hosted Omni workspace `WebContentsView`s are deliberately laid out from
  `y: 0` so their own titlebars are visible. Keep shell titlebar drag regions
  pointer-transparent over the hosted surface and re-add the active hosted view
  when showing, laying out, or focusing it so Electron keeps it topmost.
  Otherwise hosted titlebar controls can turn into shell window-drag hit areas.
- Hidden resident hosted workbenches should be removed from the window
  `contentView`, not just `setVisible(false)`. Invisible Electron view siblings
  can still disturb native hit testing when several workbenches restore at
  startup.
- Omni shell screenshot-overlay fallback uses the same detach/attach visibility
  path as resident workspace hiding. When a hidden active hosted workbench is
  shown again, force a repaint so the restored `WebContentsView` does not stay
  blank after the screenshot overlay is removed.
- Detached hidden resident workbenches can still finish loading and report
  readiness, but multi-workbench startup may leave them in `loading` briefly.
  Treat `loading` as resident/switchable UI state, not as unloaded.
- Resident restore entries are surfaced as `restore-pending` before their
  `WebContentsView` exists. Projects UI should render that state like
  `loading`, while main promotes it to `loading` when the serialized restore
  loop starts attaching the workbench.
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
- Hosted workspace `webContents.destroyed` fires after Electron has already
  invalidated the object. Capture ids before registering the handler and avoid
  calling visibility, focus, bounds, or process APIs from that path.
- Hosted workspace unload relies on renderer storage close waiting for
  main-process storage IPC writes to flush. If `updateItems` replies before the
  `IStorageMain.set()` / `delete()` promises settle, app quit can destroy child
  workbenches while `@vscode/sqlite3` statements are still finalizing.
- Once main-process shutdown starts, late-created profile/workspace storage must
  stay in-memory for normal `QUIT` as well as abnormal `KILL`. Hosted renderer
  unload can still issue storage IPC after the shutdown joiner snapshot; opening
  a new sqlite DB in that window can leave native `exec()` callbacks racing app
  teardown.

## Integrated Browser Views

- Integrated browser `WebContentsView`s inside hosted Omni workbenches should
  stay top-level `contentView` siblings, not children of the hosted workbench
  `WebContentsView`. Use the hosted view only to calculate offsets and sync
  visibility/z-order from the Omni shell; nested parenting can leave browser
  contents visible but not hit-testable.
- Browser editor layout can arrive while a resident hosted workbench is hidden
  and detached from the window `contentView`. Re-resolve the hosted
  `WebContentsView` bounds when showing or raising its browser views so stale
  window-relative fallback coordinates do not overlay the Omni sidebar.

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

- Do not null out or remove `defaultChatAgent` from the product configuration
  served to web clients. Upstream account and chat entitlement services
  dereference it unconditionally during workbench startup, so removing it
  breaks boot with a blank page and no logged error. To disable Copilot chat
  surfaces on web, target narrower keys such as
  `builtInExtensionsEnabledWithAutoUpdates`.
- Hucode serve-web self-hosts webview bootstrap assets: the server injects a
  same-origin `webviewEndpoint`, the client entrypoint absolutizes it, and
  `src/vs/workbench/contrib/webview/browser/pre/index.html` carries a Hucode
  patch accepting a same-origin parent. That page pins its inline module
  script with a CSP sha256 hash; any edit to the script must recompute the
  hash in the CSP meta or the module is silently blocked and all webviews
  break. `src/vs/workbench/test/node/hucodeWebviewPreCsp.test.ts` guards both
  the hash and the patch across upstream upgrades.

- Keep high-volume `ILocalPtyService` stream events lazy when exposing the
  main-process `localPty` channel through `ProxyChannel.fromService`. Desktop
  workbenches consume terminal data through `PtyHostWindow`, and eager buffering
  of `onProcessData`, `onProcessReady`, or `onDidChangeProperty` can trigger
  dev-mode `Event.buffer` leak warnings with no renderer listener attached.
