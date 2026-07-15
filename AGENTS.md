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
- For VS Code release upgrades, use the project-local
  `hucode-upgrade-vscode` skill and follow
  [Repo Strategy](docs/hucode/repo-strategy.md).

## Repository hygiene notes

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
