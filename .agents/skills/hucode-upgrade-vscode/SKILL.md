---
name: hucode-upgrade-vscode
description: Upgrade Hucode to a selected upstream VS Code release tag. Use when preparing or executing a Hucode series upgrade, creating versioned upstream, series, or replay branches, replaying Hucode patches onto a new VS Code version, resolving upgrade conflicts, validating Hucode after a VS Code baseline bump, or bumping Hucode overlay release metadata.
---

# Hucode VS Code Upgrade

## Core References

Read `docs/hucode/repo-strategy.md` before planning or editing. Follow
`AGENTS.md` repository rules, especially: do not use `git -C`, do not revert
unrelated user changes, keep root `product.json` as upstream OSS, and keep
Hucode identity in `build/hucode/mixin/stable/`.

Use this branch model:

- `upstream-<version>`: clean branch at the upstream VS Code release tag.
- `series-<version>`: Hucode patch series on top of that upstream branch.
- `series-<version>-replay`: compact replay branch for the completed previous
  series, created during the upgrade as a temporary compaction artifact. It
  should be tree-equivalent to `series-<version>` but with curated topic
  commits.

Push `upstream-<version>` to `origin` after creating the clean baseline. Do
not push `series-<version>` while it still points at the same commit as
`upstream-<version>`. Publish the series branch only after the Hucode patch
stack has been replayed and validated.

## Preflight

1. Confirm target versions and current branch names:

   ```sh
   git status --short --branch
   git log --oneline upstream-<old-version>..series-<old-version> | head
   ```

2. Confirm `series-<old-version>` is pushed and in sync with `origin`.

3. Expect to create `series-<old-version>-replay` as part of the upgrade. The
   replay branch is not maintained continuously and does not need to exist
   before the upgrade starts. If it already exists from an abandoned or previous
   attempt, inspect it before deciding whether to delete, refresh, or reuse it.

4. Keep local generated mixin state out of commits. If root `product.json` or
   `resources/darwin/*` are dirty from Hucode launch/build workflows, identify
   them explicitly and avoid staging them unless the user asks.

## Create The Replay Branch

Only do this from a clean worktree. The replay branch must normally be a fresh
compaction of the final `series-<old-version>` tree, not a preservation of the
old development history. Reusing the existing series commits is an exception,
not the default, and is allowed only when every existing commit already reads
like a durable replay topic and there is no later development churn mixed in.

Before creating or reusing the replay branch, write a short decision note in the
conversation:

```text
Existing series commits: <count>
Disqualifying commits: <list, or none>
Decision: full reconstruction | reuse existing commits
Reason: <why this preserves durable replay topics>
```

If the disqualifying list is non-empty, the decision must be full
reconstruction from the final tree. Do not create a replay branch by
cherry-picking the existing `series-<old-version>` commits one by one unless the
list is empty and the reuse reason is explicit.

Disqualifying commits include:

- Standalone `fix:` follow-ups that repair earlier Hucode topics.
- Historical `chore: bump Hucode version to ...` commits.
- Baseline-documentation commits such as
  `feat(deps): document VS Code baseline upgrade`.
- PR-numbered cleanup or release-parity fixes such as
  `ci: fix Windows release packaging (#58)`.
- Commits that only consume `.changes` fragments, update `CHANGELOG.md`, or
  carry release artifacts.
- Debugging, conflict-resolution, file-move churn, generated-asset churn, or
  other commits whose main purpose is fixing the previous series history.

The default compaction setup is:

```sh
git switch --create series-<old-version>-replay series-<old-version>
git reset --soft upstream-<old-version>
git reset
```

The soft reset moves the complete final Hucode tree from
`series-<old-version>` to the index against the clean upstream baseline. The
plain `git reset` immediately unstages that full diff so the replay can be
built intentionally instead of accidentally committing one giant staged change.

Split that diff into durable topic commits based on the final state only. Use
path-based staging as the starting point, but split individual files with patch
or hunk staging when one file contains changes for more than one replay
boundary. Inspect every commit and pay attention to which area owns each change
so unrelated changes do not get tied together. Shared integration files should
not become catch-all commits; stage their hunks into the commit whose behavior
they belong to. A commit should usually represent one coherent reason to carry a
patch across the next VS Code baseline.

Good replay boundaries include:

- Hucode repo docs and strategy.
- Product overlay, release scripts, generated source assets.
- Marketplace/signature compatibility.
- Platform services and IPC contracts.
- Hosted renderer routing and browser-view support.
- Omni shell bootstrap, layout, resident workbench hosting.
- Projects/worktree UI and commands.
- Command forwarding and extension filtering.
- Release maintenance, release parity, or release artifact refreshes.

Files that wire multiple systems together often need hunk-level staging. Treat
shared files such as `platform.ts`, `native.ts`, `windowActions.ts`,
`desktop.contribution.ts`, and service registration files as integration points,
not as automatic single-topic commits.

Squash intermediate debugging, file-move churn, generated-asset churn,
historical Hucode version bumps, refactors caused by later tests, and
conflict-resolution fallout. Hucode feature development history remains on the
previous `series-<old-version>` branch. The replay branch exists to make the
next cherry-pick easy to reason about and as conflict-free as possible, so favor
clear final-state topic commits over chronological fidelity.

Do not preserve historical `chore: bump Hucode version to ...` commits in the
compact replay stack. Fold their source edits into the owning topic when they
are just part of that feature or fix. If the old series contains consumed
release fragments, `CHANGELOG.md` updates, and the final
`build/hucode/mixin/stable/product.json` `hucodeVersion`, collect that final
state into one release-maintenance commit such as
`chore(release): carry <old-version> release artifacts`. The commit should make
the old series tree-equivalent without replaying every patch-version bump as a
separate commit.

Verify replay equivalence before upgrading:

```sh
git diff --exit-code series-<old-version>-replay..series-<old-version>
git log --oneline upstream-<old-version>..series-<old-version>-replay
git diff --stat upstream-<old-version>..series-<old-version>-replay
npm run hucode:compile
```

If equivalence fails, either fix the replay branch or document intentional
differences before using it as the upgrade source.

Audit the replay log before upgrading. Unless explicitly documented as a durable
topic, `git log --oneline upstream-<old-version>..series-<old-version>-replay`
should not contain standalone fix commits, historical Hucode version-bump
commits, baseline-documentation commits, release-fragment consumption commits,
or cleanup commits whose purpose is to repair earlier series history.

The replay branch is only needed as the source for this upgrade's
cherry-pick. Do not push it by default; the new `series-<new-version>` branch
is the branch that carries the upgraded Hucode patch series forward.

## Create The New Baseline

Fetch only the selected tag:

```sh
git fetch upstream tag <new-version>
git switch --create upstream-<new-version> <new-version>
git push -u origin upstream-<new-version>
```

Create the new series branch locally:

```sh
git switch --create series-<new-version> upstream-<new-version>
```

Do not push the new series branch yet. At this point it is still an unmodified
upstream VS Code branch, so GitHub would run the regular upstream VS Code CI
workflows instead of Hucode's disabled/customized workflow set. That can fail
and spend CI minutes unnecessarily. The first push of
`series-<new-version>` must happen only after the replayed Hucode commits are
present, including the Hucode workflow customizations.

Before cherry-picking the replay series, refresh dependencies on the new
baseline/series so hooks and build tooling match the upgraded VS Code version:

```sh
npm install
```

Do this before conflict resolution. Avoid bypassing hooks just because
`node_modules` is stale; rerun `npm install` first. If `npm install` fails
while `node-gyp` is fetching Electron or Node headers with transient network
errors such as `ECONNRESET`, retry before treating the failure as an upgrade
blocker.

## Replay Onto The New Series

Cherry-pick the compact old replay stack:

```sh
git cherry-pick upstream-<old-version>..series-<old-version>-replay
```

Resolve conflicts commit-by-commit. Prefer adapting Hucode patches to current
upstream APIs over preserving old compatibility paths. When resolving:

- Use upstream `1.<new>` code as the base mental model.
- Keep Hucode-local code under established Hucode locations when possible.
- Preserve upstream lifecycle and safety fixes unless there is a clear Hucode
  reason to override them.
- Preserve upstream signature and API changes, then adapt Hucode behavior to
  them unless the Hucode behavior explicitly requires a different contract.
- When upstream renames or replaces a workflow, disable the current upstream
  workflow file instead of resurrecting an old deleted workflow name.
- If a replay conflict reveals stale Hucode assumptions, fix the replayed patch
  in the new series and consider later backporting or documenting the lesson.
- Do not use `--no-verify` for normal conflict commits. If a hook fails, fix
  the dependency/tooling issue first, usually with `npm install`.

If compile or tests reveal small replay-adaptation fixes after cherry-picking,
commit them as `fixup! <topic>` against the relevant replay commit. Before final
validation, run an autosquash rebase so the upgraded series does not retain
generic "fix conflict" or "fix compile" commits.

Useful conflict checks:

```sh
rg -n '^(<{7}|>{7})( |$)' <conflicted-files>
git diff --check
git status --short
```

For a final changed-file scan after replay, avoid searching for `=======`
globally: VS Code has many legitimate separators and fixtures. A real Git
conflict hunk always has line-start start and end markers (`<<<<<<<` and
`>>>>>>>`), so scanning for those markers over changed files catches unresolved
conflicts without the separator noise:

```sh
while IFS= read -r -d '' file; do
	rg -n '^(<{7}|>{7})( |$)' -- "$file" || true
done < <(git diff --name-only --diff-filter=ACMRT -z upstream-<new-version>..series-<new-version>)
```

No output is expected from that scan. Deleted files are excluded because they
cannot contain unresolved markers in the final worktree.

## Validate The Upgraded Series

Run at least:

```sh
git log --oneline upstream-<new-version>..series-<new-version>
git diff --stat upstream-<new-version>..series-<new-version>
npm run precommit
npm run hucode:compile
```

Also run the build package tests on upgrade branches. They cover Hucode release
tooling and entrypoint-drift contracts that normal TypeScript compilation can
miss:

```sh
cd build && node --test "{lib,next}/**/*.test.ts"
```

This `node --test` glob form requires Node v21 or later.

Run targeted tests for touched Hucode areas when available. A broader
`npm run test-node` pass is valuable after platform, browser-view, IPC,
extension-host, or utility-process changes.

For Hucode mixin validation:

```sh
npm run hucode:prepare
npm run hucode:validate
```

`hucode:validate` expects root `product.json` to remain upstream `Code - OSS`.
If it fails because root `product.json` is mixed to Hucode, treat that as local
generated runtime state, not source state to commit.

### Entrypoint And Runtime Smoke Checks

Compile success is not enough for forked workbench entrypoints. Side-effect
imports and service registrations can fail only when the Omni shell starts.

If the replay touches `omni.common.main.ts`, `omni.desktop.main.ts`,
`workbench.common.main.ts`, `workbench.desktop.main.ts`, or Omni/workbench HTML
entrypoints, explicitly check for entrypoint drift:

- Compare Omni Trusted Types policy directives with upstream
  `workbench.html` and `workbench-dev.html`.
- Audit new common-workbench imports for required side-effect service
  registrations. Prefer registering the minimal required service in Omni over
  importing broad contributions that Omni intentionally omits.
- Re-run the `Hucode Omni common entrypoint` build test after entrypoint or CSP
  changes.

After `npm run hucode:compile`, run a short Omni startup smoke with inherited
extension-host environment cleared:

```sh
env -u ELECTRON_RUN_AS_NODE \
	-u VSCODE_CODE_CACHE_PATH \
	-u VSCODE_CRASH_REPORTER_PROCESS_TYPE \
	-u VSCODE_CWD \
	-u VSCODE_ESM_ENTRYPOINT \
	-u VSCODE_HANDLES_UNCAUGHT_ERRORS \
	-u VSCODE_IPC_HOOK \
	-u VSCODE_NLS_CONFIG \
	-u VSCODE_PID \
	npm run hucode:run
```

Let startup settle, then stop the dev app. Inspect the startup log for
runtime-only failures such as Trusted Types policy errors, `NOT registered`
service errors, `Cannot instantiate named customer`, and `Missing proxy
instance`. Extension deprecation warnings and managed-account fallback messages
are not upgrade blockers by themselves, but do not ignore new `ERR` lines
without tracing them.

## Version And Release Metadata

Keep VS Code's root `version` aligned with upstream. Do not bump Hucode's own
release version as part of the VS Code upgrade. Hucode release version bumps
should happen later, after the upgraded branch has been manually tested and is
ready for release.

```text
build/hucode/mixin/stable/product.json
```

Use `hucodeVersion` only for Hucode patch releases. After bumping it, ensure
`build/hucode/validate-mixin.js` validates against the source overlay value
rather than a stale hardcoded version.

Instead of a version bump, add a `.changes` fragment for the underlying VS Code
baseline upgrade, such as:

```text
.changes/upgrade-vscode-1-122-0.md
```

The first non-empty line should be a Conventional Commit header matching the
eventual PR title, for example:

```text
feat(deps): upgrade VS Code baseline to 1.122.0
```

If a PR number already exists, the numbered fragment form is also valid:
`.changes/<pr-number>-upgrade-vscode-1-122-0.md`.

After the replayed Hucode patch stack, compatibility fixes, validation updates,
and baseline `.changes` fragment are all committed, push the completed series
branch:

```sh
git push -u origin series-<new-version>
```

## Final Checks

Before handing off:

```sh
git status --short --branch
git log --oneline upstream-<new-version>..series-<new-version>
node -e "const p=require('./package.json'); const h=require('./build/hucode/mixin/stable/product.json'); console.log({ vscode:p.version, hucode:h.hucodeVersion })"
```

Report:

- New upstream and series branch names.
- Whether both branches were pushed to `origin`.
- Replay source branch and commit count. The replay branch normally remains
  local unless the user explicitly asks to publish it.
- Conflict areas and important decisions.
- Validation commands and outcomes.
- Any remaining dirty generated mixin state that was deliberately left alone.
  `hucode:prepare`, `hucode:compile`, and launch workflows can dirty root
  `product.json` and `resources/darwin/*`; distinguish that generated runtime
  state from source edits and do not push it as part of the upgraded series.
