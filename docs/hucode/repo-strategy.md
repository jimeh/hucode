# Hucode Repo Strategy

## Upstream Base

Hucode should fork the open-source `microsoft/vscode` repository, not the
Microsoft-branded Visual Studio Code distribution.

That means:

- source comes from `microsoft/vscode`
- branding changes are applied in the Hucode fork
- extension marketplace defaults should point at OpenVSX

## Repo Model

Use a normal Git repo with:

- `origin` for Hucode
- `upstream` for `microsoft/vscode`
- `main` as the Hucode integration branch

Hucode should not need to track `upstream/main` continuously. For now, the
cleaner model is to rebase product planning around selected upstream release
tags.

## Release Tracking

Recommended baseline model:

- choose a VS Code release tag, such as `1.115.0`
- import that tag as the current baseline
- build Hucode changes on top of it
- upgrade by explicitly pulling the next selected release

This keeps the fork stable and avoids unexpected churn from upstream mainline
development.

## Release Branches

Use versioned local branches to make each upgrade explicit:

- `upstream-<version>` points at the unmodified VS Code release tag.
- `series-<version>` starts at the matching `upstream-<version>` commit.
- Hucode changes are replayed onto `series-<version>`.
- `series-<version>-replay` is a compacted replay branch with the same intended
  end state as `series-<version>`, but with churn squashed into stable patches.

For example, the VS Code `1.117.0` baseline is tracked as
`upstream-1.117.0`, and the Hucode patch series for that baseline is tracked
as `series-1.117.0`.

Keep the `upstream-<version>` branches clean. Do not commit Hucode changes to
them; they exist so the fork diff is always inspectable with:

```sh
git diff upstream-<version>..series-<version>
git log --oneline upstream-<version>..series-<version>
```

Publish each `upstream-<version>` branch to `origin` once it is created. Do
not publish `series-<version>` while it still points at the same commit as the
upstream baseline; that branch does not contain Hucode's disabled/customized CI
workflow state yet, so GitHub can run regular upstream VS Code CI jobs. Publish
the matching Hucode series branch only after the Hucode patch stack has been
replayed and validated.

Use the `series-<version>` branch as the working branch for development and
upgrade conflict resolution. When starting the next upgrade, first create or
refresh `series-<version>-replay` from the matching `upstream-<version>` branch
and rebuild the latest Hucode changes as a smaller set of topic commits.

The replay branch should be tree-equivalent to the working series branch unless
the difference is intentional and documented:

```sh
git diff --exit-code series-<version>-replay..series-<version>
git diff --stat upstream-<version>..series-<version>-replay
git log --oneline upstream-<version>..series-<version>-replay
```

Future upgrades should cherry-pick from the previous replay branch, not from
the raw development series branch. This keeps old conflict-resolution churn out
of the patch stream that is replayed onto new VS Code releases.

## Upgrade Procedure

To upgrade from `1.117.0` to `1.118.1`:

1. Verify the worktree is clean:

   ```sh
   git status --short --branch
   ```

2. Create or refresh the compact replay branch for the current series:

   ```sh
   git switch --create series-1.117.0-replay series-1.117.0
   git reset --soft upstream-1.117.0
   ```

   This keeps the final `series-1.117.0` tree in the index while comparing it
   against the clean upstream baseline. Rebuild that staged diff as a curated
   sequence of topic commits. Squash commits that only represent intermediate
   debugging, API adaptation, file moves, generated-asset churn, or
   conflict-resolution fallout.

3. Verify the compact branch before using it as the upgrade source:

   ```sh
   git diff --exit-code series-1.117.0-replay..series-1.117.0
   git log --oneline upstream-1.117.0..series-1.117.0-replay
   npm run hucode:compile
   ```

4. Fetch only the selected upstream release tag:

   ```sh
   git fetch upstream tag 1.118.1
   ```

5. Create the upstream baseline branch from the upstream tag:

   ```sh
   git switch --create upstream-1.118.1 1.118.1
   git push -u origin upstream-1.118.1
   ```

6. Create the Hucode series branch at the same baseline commit:

   ```sh
   git switch --create series-1.118.1 upstream-1.118.1
   ```

   Keep this branch local until after the Hucode changes have been replayed.
   Pushing it at the bare upstream baseline can trigger upstream VS Code CI
   instead of Hucode's customized CI workflow set.

7. Refresh dependencies on the new baseline before replaying Hucode patches:

   ```sh
   npm install
   ```

   VS Code upgrades can change lint, TypeScript, or hook dependencies. Run
   `npm install` before conflict resolution so commit hooks and local
   validation use the new release's dependency set. Avoid bypassing hooks just
   because `node_modules` is stale.

8. Replay the compacted Hucode patch series onto the new baseline:

   ```sh
   git cherry-pick upstream-1.117.0..series-1.117.0-replay
   ```

   Resolve conflicts commit-by-commit. Prefer adapting each patch to the new
   upstream API over adding compatibility shims for old VS Code code paths.

9. Verify the resulting branch:

   ```sh
   git log --oneline upstream-1.118.1..series-1.118.1
   git diff --stat upstream-1.118.1..series-1.118.1
   npm run precommit
   npm run hucode:compile
   ```

10. Update Hucode release metadata only after the replay is coherent. Keep the
   root VS Code `version` aligned with upstream; Hucode's own release version
   belongs in the stable overlay as `hucodeVersion`.

   After changing `hucodeVersion`, run:

   ```sh
   npm run hucode:prepare
   npm run hucode:validate
   ```

   The validator should compare the generated mixin output against the source
   overlay value, not a hardcoded historical Hucode version. Root `product.json`
   should remain upstream OSS; if validation fails because it is mixed to
   Hucode, restore or ignore that local generated runtime state before treating
   validation as meaningful.

11. Publish the completed Hucode series branch only after the replayed patch
    stack, validation fixes, and release metadata changes are committed:

   ```sh
   git push -u origin series-1.118.1
   ```

If an upgrade replay has to be abandoned, reset only the new
`series-<version>` branch. Do not rewrite an older completed
`series-<version>` branch while preparing a new upstream release.

If a compaction pass has to be abandoned, reset only the
`series-<version>-replay` branch for the current version. Once a replay branch
has been used as the source for a newer upgrade, treat it as completed history.

## Upstream Fetch Policy

Prefer a narrow upstream fetch strategy:

- do not fetch all upstream tags by default
- do not track all upstream branches locally
- fetch only the release tags or release branches needed for upgrades

Practical effect:

- `main` stays clean and Hucode-owned
- upstream refs do not clutter local branch output
- upgrades happen on purpose, not by accident

## Bootstrap Caveat

A shallow import of a VS Code release tag is useful for quick local setup, but
it is not enough for the first push of a new Hucode repo.

Before the first publish to `origin`, expect to:

- fetch enough history for the chosen release line
- account for any reachable legacy Git LFS pointers in that history

Hucode's current tree does not require Git LFS, but older commits may still
contain upstream Copilot simulation cache LFS pointers. GitHub may reject a
push of that history if referenced LFS objects are missing.

## Keeping The Diff Healthy

To keep upstream merges manageable:

- prefer additive files and services over wide invasive edits
- isolate Hucode-only code under a small set of directories
- keep branding and release plumbing separate from feature code
- document intentional deep patches when they cannot be avoided

Suggested Hucode-heavy areas:

- `src/vs/platform/projectManager`
- `src/vs/workbench/contrib/projectSwitcher`
- `src/vs/hucode`
- `product.json`
- packaging and release scripts under `build/`

## Branding And Marketplace

Expected changes:

- rename product strings to Hucode
- replace icons and bundle assets
- point extension gallery configuration at OpenVSX
- audit update, telemetry, and legal metadata before the first public build

## Why Not A Build-Time Tarball

A wrapper repo that downloads VS Code source at build time works best for
distribution-level changes. Hucode is a product-level fork with planned edits
across `electron-main`, platform services, and workbench code.

For Hucode, a real source fork is better because it preserves:

- normal git history and blame
- normal code search and navigation
- explicit merge conflict resolution
- predictable CI and release builds
