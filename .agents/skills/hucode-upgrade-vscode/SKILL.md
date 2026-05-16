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

Push both `upstream-<version>` and `series-<version>` to `origin` so the remote
has the clean baseline and Hucode series branch available.

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

Only do this from a clean worktree. The preferred compaction setup is:

```sh
git switch --create series-<old-version>-replay series-<old-version>
git reset --soft upstream-<old-version>
```

This leaves the final Hucode tree from `series-<old-version>` staged against
the clean upstream baseline. Split that diff into durable topic commits. Use
path-based staging and inspect every commit. Good replay boundaries include:

- Hucode repo docs and strategy.
- Product overlay, release scripts, generated source assets.
- Marketplace/signature compatibility.
- Platform services and IPC contracts.
- Hosted renderer routing and browser-view support.
- Omni shell bootstrap, layout, resident workbench hosting.
- Projects/worktree UI and commands.
- Command forwarding and extension filtering.
- Small release/about/version fixes.

Prefer squashing intermediate debugging, file-move churn, generated-asset churn,
and conflict-resolution fallout. Hucode feature development history remains on
the previous `series-<old-version>` branch.

Verify replay equivalence before upgrading:

```sh
git diff --exit-code series-<old-version>-replay..series-<old-version>
git log --oneline upstream-<old-version>..series-<old-version>-replay
git diff --stat upstream-<old-version>..series-<old-version>-replay
npm run hucode:compile
```

If equivalence fails, either fix the replay branch or document intentional
differences before using it as the upgrade source.

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

Create and publish the new series branch:

```sh
git switch --create series-<new-version> upstream-<new-version>
git push -u origin series-<new-version>
```

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
- If a replay conflict reveals stale Hucode assumptions, fix the replayed patch
  in the new series and consider later backporting or documenting the lesson.
- Do not use `--no-verify` for normal conflict commits. If a hook fails, fix
  the dependency/tooling issue first, usually with `npm install`.

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

Also run targeted tests for touched Hucode areas when available. A broader
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

## Version And Release Metadata

Keep VS Code's root `version` aligned with upstream. Bump Hucode's own release
version only in:

```text
build/hucode/mixin/stable/product.json
```

Use `hucodeVersion` for Hucode patch releases. After bumping it, ensure
`build/hucode/validate-mixin.js` validates against the source overlay value
rather than a stale hardcoded version.

Commit the version bump separately from replay/conflict-resolution commits.

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
