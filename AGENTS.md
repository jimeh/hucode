# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Hucode fork notes

Before Hucode-specific code or documentation changes, agents MUST read
[Hucode Agent Instructions](docs/hucode/agent-instructions.md). Treat that file
as the required Hucode instruction set for work in this fork.

- Use [Hucode Docs](docs/hucode/README.md) as the map for architecture, repo
  strategy, roadmap, and upgrade workflow.
- Hucode product identity is applied through the tracked overlay under
  `build/hucode/mixin/stable/`. Keep root `product.json` and upstream resource
  files as VS Code OSS unless a Hucode wrapper command has staged the overlay
  temporarily for a subprocess.
- Hucode's app release version lives in the overlay as `hucodeVersion`. Keep
  upstream `version` for VS Code compatibility and extension checks.
- Before opening or updating a Hucode PR titled with `feat`, `fix`, `perf`,
  `revert`, or a breaking `!` marker, add a matching `.changes/*.md` fragment.
  Once a PR number exists, name it `.changes/<pr-number>-<slug>.md`; the first
  non-empty line must exactly match the PR title's Conventional Commit header.
- Common local commands:
  - `npm run hucode:prepare`: generate the stable mixin overlay into
    `.build/distro/mixin/stable/`.
  - `npm run hucode:validate`: verify the Hucode mixin and generated output.
  - `npm run hucode:compile`: build client, built-in extensions, and extension
    media with Hucode product config.
  - `npm run hucode:watch`: run the incremental Hucode watch flow.
  - `npm run hucode:run`: launch the desktop app through the Hucode wrapper.
  - `npm run hucode:web`: launch the local serve-web development server
    through the Hucode wrapper.
- For VS Code release upgrades, use the project-local
  `hucode-upgrade-vscode` skill and follow
  [Repo Strategy](docs/hucode/repo-strategy.md).

## Repository hygiene notes

- npm is this repository's package manager. Do not run `pnpm` or `yarn`.
  `build/npm/preinstall.ts` rejects yarn by name and refuses npm 12 or newer,
  but it does **not** catch pnpm: pnpm sets a different
  `npm_config_user_agent`, so the version check finds no match, silently does
  nothing, and the install proceeds with the wrong resolver. `.npmrc` also
  carries Electron native-build settings — `runtime`, `target`, `disturl`,
  `build_from_source` — that native modules such as `@vscode/sqlite3` and
  `node-pty` depend on.
- The tracked `pnpm-lock.yaml` at the repository root is upstream debris, not
  a supported alternative. Upstream committed it by accident inside an
  unrelated CSS commit, nothing reads it, and it has not been updated since.
  Running pnpm rewrites that tracked file and leaves an untracked
  `pnpm-workspace.yaml` beside it; restore the lockfile and delete the
  workspace file rather than committing either.
- For code changes, inspect nearby existing tests before considering the work
  complete. Add or extend focused tests for new behavior and regressions when
  an applicable test suite exists. If automated coverage is not practical, say
  why and describe the manual verification performed. Hygiene/precommit checks
  are not a substitute for behavior coverage.
- After editing files, run the same hygiene path as the pre-commit hook before
  considering the work complete. If changes are already staged for a commit,
  run `npm run -s precommit`; otherwise run `npm run -s precommit -- <paths>`
  for the edited files. Do not bypass or ignore hygiene failures; fix them or
  report the blocker.
- The `coderabbit:review` label does not override CodeRabbit's draft-PR skip.
  Mark a PR ready before waiting for a label-triggered CodeRabbit review.
- `changelog.ts check-pr` requires the PR title to match any added `.changes/`
  fragment that the PR owns — an unnumbered one, or one numbered for this PR.
  Fragments already numbered for a *different* PR are ignored, so an
  integration branch carrying several merged PRs, or a branch that merged a
  base which had just gained a fragment, does not fail for carrying them.
- An integration PR merging a batch should use a hidden type such as `chore:`.
  A `feat:`/`fix:` title still requires a fragment of its own, which an
  integration PR has no business adding — its constituents already carry theirs.
- Pushing to a branch while CodeRabbit is mid-review aborts that review with
  "head commit changed during the review". Let a review finish, or re-request
  it afterwards with a new `@coderabbitai review` comment.
- Build-script changelog tests create temporary Git commits and inherit global
  `commit.gpgSign`. On hosts with signing enabled, run the suite with
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgSign`
  `GIT_CONFIG_VALUE_0=false npm run test-build-scripts` so test commits do not
  require an interactive pinentry.
- Release app packaging downloads Electron through `@electron/get` before the
  platform package task can start. Keep the retrying
  `build/hucode/electron-prefetch.ts` step after dependency installation and
  before `Build release app`, and set `HUCODE_ELECTRON_PREFETCHED=1` only on
  that build step. The flag makes packaging serve pinned checksums locally and
  reject an Electron artifact cache miss instead of returning to the network;
  the downstream `@vscode/gulp-electron` retry classifier does not recognize
  all native-fetch/Undici timeout codes.
- If `npm ci` retries after an Electron header download fails with
  `ECONNRESET`, remove only the matching `~/.cache/node-gyp/<target>/`
  directory first. The failed attempt can leave that target incomplete, and
  node-gyp will otherwise reuse it and fail because `common.gypi` is missing.
- `windowsMainService.getPathsToOpen()` selects the default fallback window
  before initial-startup untitled workspaces and empty-window backups are
  appended in `open()`. When changing default startup-window behavior, account
  for those later restores or the app can open an extra fallback window.
- `npm run test-build-scripts -- --test-name-pattern <pattern>` does not work:
  the build package test script places the test glob before forwarded args, so
  Node treats the pattern as another test file. For filtered build-script tests,
  run `cd build && node --test --test-name-pattern <pattern> \
  '{lib,next}/**/*.test.ts'`.
- TOML files cannot carry VS Code's standard block copyright header. Keep
  `*.toml` and TOML-formatted lockfiles such as `mise.lock` excluded from
  copyright hygiene rather than adding invalid TOML.
- Do not run `npm run test-node -- --run ...` concurrently with
  `npm run gulp compile-client`; the compile task cleans `out/`, which can make
  the test runner fail to resolve freshly built modules.
- Do not run multiple `./scripts/test.sh` invocations concurrently. They share
  the same `.build/electron` app preparation path and can race while creating
  framework symlinks.
- The esbuild `out/` transpile (used by dev compiles and CI unit tests since
  VS Code 1.126.0) lowers classes with static fields to renamed const
  bindings (e.g. `_ChatRequestTextPart`), so tests must not assert
  `constructor.name`. Upstream fixed its ChatService tests in
  microsoft/vscode@d416fdd194 (#322698), backported here; write new tests
  against stable discriminators such as `kind` instead.
- IDE-integrated shells can inherit extension-host variables such as
  `ELECTRON_RUN_AS_NODE=1` and `VSCODE_ESM_ENTRYPOINT`. Before running
  `./scripts/test.sh`, unset `ELECTRON_RUN_AS_NODE` and inherited `VSCODE_*`
  variables or Electron unit tests may start in Node mode before loading tests.
- Local `./scripts/test.sh` runs need `ELECTRON_DISABLE_SANDBOX=1`, because
  `.build/electron/chrome-sandbox` must be root-owned with mode 4755 and only
  CI does that (`sudo chown root` / `sudo chmod 4755`). Without it the runner
  aborts with `FATAL:setuid_sandbox_host.cc`. On headless hosts also wrap the
  call in `xvfb-run`, and set `VSCODE_SKIP_PRELAUNCH=1` to avoid re-running
  `npm run electron` on every invocation:

  ```sh
  VSCODE_SKIP_PRELAUNCH=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run \
    ./scripts/test.sh --run <test-file>
  ```
- That `VSCODE_SKIP_PRELAUNCH=1` also skips the build, and the Electron runner
  executes compiled `out/`. Editing a `.ts` file and re-running therefore tests
  the *previous* build. This matters most when deliberately breaking code to
  confirm a test catches it: the run passes, which reads as "the test does not
  detect this" when the truth is the change was never compiled. Run
  `npm run gulp compile-client` after every source edit, and confirm the change
  reached `out/` before drawing any conclusion from the result. Note esbuild
  strips comments, so verify against the compiled behaviour rather than a
  marker comment.
- CI suite lists are generated, not hand-maintained.
  `build/hucode/test-suites.ts` resolves them and
  `.github/workflows/hucode-ci.yml` calls it per runner. A new suite under
  `src/vs/hucode/`, or any `hucode*.test.ts` anywhere, is picked up with no
  workflow edit. Do not paste suite paths back into the workflow; a test
  asserts there are none.
- The resolved lists are committed to
  `build/hucode/test-suites.snapshot.json` so a pull request still shows what
  CI will run. Adding a suite changes that file — regenerate with
  `npm run hucode:test-suites -- --write-snapshot` and commit it, or
  `npm run hucode:check-test-suites` fails.
- An upstream-named suite Hucode runs because it patched the subject cannot be
  found by any rule. Those live in `UPSTREAM_SUITES` with a reason each.
  Forgetting to add one is still invisible — that gap closes with H1's
  provenance map, not before.
- Runner assignment is not derivable from the layer alone. An explicit `--run`
  argument bypasses the Node runner's layer exclusions, and two Electron-layer
  suites (`hucodeLinuxUpdate.test.ts`, `hucodeOmniFileDialog.test.ts`) run
  under `npm run test-node` on purpose; they are `NODE_RUNNER_OVERRIDES`.
  Everything else in `browser`, `electron-browser`, `electron-main`, or
  `electron-utility` goes to the Electron runner, and everything else again is
  enumerated by the bare `npm run test-node` pass. Naming an already-enumerated
  suite explicitly just runs it twice.
- The Electron runner does accept a glob (`--runGlob`/`--glob`), but it takes a
  single pattern, is mutually exclusive with `--run`, and matches compiled
  `out/` paths — and a glob matching nothing fails silently. That is why the
  list is computed in TypeScript and passed as repeated `--run=` arguments
  rather than handed to the runner as a pattern.
- Web Omni hosted-command forwarding has a bounded response timeout. Keep
  interactive commands such as project and worktree renames in the web shell;
  otherwise a slow Quick Input can time out and trigger a duplicate fallback.
- Serve-web project SSE snapshots must wait for the corresponding project-state
  write generation, including hydration and background refresh. A disconnected
  request may cancel queued work and active read-only Git commands, but once a
  worktree create/remove starts, finish that irreversible mutation and its
  state flush. If post-create discovery fails, return a stale record for the
  created path while the normal refresh retry recovers authoritative metadata.
  Once discovery commits a current worktree snapshot, any remaining watcher
  recovery is service-owned and must outlive the initiating request.
  Node's `IncomingMessage` `close` event also fires after normal request
  completion; use request `aborted` or response `close` before
  `writableFinished` to detect a real disconnect.
  Server disposal must reject waiting work immediately but keep the project
  manager and server-lifetime consumers alive until every admitted read and
  mutation has settled; join both admission queues and dispose the manager
  before releasing the final lease. A canceled read response can settle before
  its admitted Git operation, so tests must join the read queue before teardown.
  Route project-list GETs and initial SSE hydration through that same read
  admission path. Operation leases end when the underlying work settles, while
  response leases remain through response `finish`, premature `close`, or
  `error`; long-lived SSE responses retain theirs until disconnect.
  The shared `Limiter` and `Queue` retain canceled waiting factories, and their
  disposal clears waiting work without settling its returned promises; do not
  use them for request admission that must release canceled or disposed work.
- `npm run hucode:compile` does **not** build `extensions/copilot/dist`; that
  needs `npm run compile-copilot` (CI has a separate "Copilot VSIX" job). A dev
  `serve-web` therefore runs with Copilot Chat entirely absent, which silently
  invalidated a runtime measurement that appeared to pass.
- Keep Omni web shell registrations in `omniWeb.contribution.ts`, imported by
  both `omni.web.main.ts` and `omniWebUserData.factory.ts`. The latter is the
  default root entrypoint under server-side user-data storage; omitting shared
  registrations leaves the page blank before the workbench renders.
- CSS imported by route-specific Hucode web entrypoints is flattened into the
  shared stylesheet in minified server-web builds, even when a development
  dynamic import never executes. Scope Omni-only selectors under
  `.hucode-omni-workbench` and validate the bundled CSS rather than relying on
  `npm run hucode:web` alone.
- Extension *enablement* state is per-browser (localStorage), so
  enablement-dependent behaviour can only be measured in a browser holding the
  real profile state. A control run from a different browser profile proves
  nothing.
- Native `IProjectManagerService` calls cross a generic `ProxyChannel`, which
  does not support `CancellationToken` method arguments. Keep request tokens
  web-only, or replace the generic proxy with a cancellation-aware channel
  before adding them to the shared service contract.
- `environmentService.isOmniWindow` and `isHostedOmniWorkspace` are **not
  trusted** on web. `WorkspaceProvider.create` parses the `payload` query
  parameter straight out of the page URL, so any page can set either flag.
  They carry no trust on their own. A consumer is safe only because something
  else does the real gating — either `isOmniShellWindow`, which comes from the
  server-injected page configuration on web and the main-process window
  configuration on desktop, or an independent check. `hostedOmniWorkspace.web`
  is the case to learn from: it exposes a channel that runs arbitrary workbench
  commands, and two of its three conditions are URL-settable. What protects it
  is the third — a same-origin `MessagePort` handshake in
  `hostedOmniWebConnection.ts`. Anything deciding what a window is *allowed* to
  do needs one of those two, not the flags.
- A trusted hosted-workbench `MessagePort` authenticates the connection, not
  caller-supplied method arguments. Expose an explicit least-authority channel
  facade, bind window and instance identity to the port server-side, and use a
  closed hosted-action allowlist rather than the broad
  `isHucodeOmniShellAction` namespace classifier; keep legacy wire parameters
  only for version-skew compatibility.
- Complete project-catalog reconciliation is shell authority. Hosted
  workbenches may read combined state through `getWindowState`, but must not
  submit a supposedly complete catalog over their connection facade.
- Hosted navigation authorities also own last-active-worktree persistence.
  Resolve the canonical project worktree server-side, record it only after an
  accepted navigation, and keep the bounded legacy web facade's self state
  populated with its real `worktreePath` for cached clients.
- Web shell restoration can block on remote folder checks. Page shutdown must
  cancel restoration without awaiting initialization, and restoration must
  check cancellation after each asynchronous preflight before attaching an
  iframe.
- Shell controller ownership ends when its host fires `onDidClose`, even if a
  later global window-destroy event also arrives. Release on both signals
  idempotently so a closed host cannot retain controller state.
- Electron exposes hosted `WebContentsView` workbenches as Playwright pages over
  CDP. Identify them through
  `window.vscode.context.resolveConfiguration()` — their URLs are identical.
  To crash one in a smoke test, subscribe to the page's `crash` event, fire
  `Page.crash` without awaiting its response, and await the event instead; the
  command response never arrives after the target dies, and the crashed page
  remains in `context.pages()` until recovery destroys the crashed view.
- Editor copy and cut commands synchronously emit nested document clipboard
  events. Local Omni clipboard fallback must keep those nested events inside the
  per-window forwarding-disabled scope or it can cancel and re-forward itself.
- A timed-out hosted clipboard request has ambiguous delivery. Treat copy and
  cut as consumed after the request starts rather than retrying locally: this
  preserves at-most-once behavior, with a documented risk that a genuinely lost
  request leaves the operation unapplied.
- Native terminal shutdown preparation can finish before other lifecycle vetoes
  settle. Keep persistence suppression reversible until `onWillShutdown`,
  invalidate late preparation completions on `onShutdownVeto` and
  `onBeforeShutdownError`, and leave the web preflight side-effect free.
- A hosted web unload commit is already irreversible from the shell's
  perspective. Internal commit failures must reject so the shell takes its
  remove-anyway path; `false` is reserved for an explicit protocol refusal
  before the commit begins.
- A late protocol-v1 hosted unload success means that legacy workbench already
  shut down. Remove it only when the exact instance still uses the connection
  captured by the timed-out request, so an old reply cannot remove a reloaded
  child.
- Web shell-wide shutdown is currently contract-only and called only by an
  explicit host. Ordinary browser lifecycle shutdown cannot await it and uses
  per-workbench hosted unload instead. Any future awaited shell-close path must
  add admission guards that reject workbenches opened after its shutdown
  snapshot.
