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
