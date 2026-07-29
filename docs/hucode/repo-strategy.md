# Hucode Repository Strategy

Hucode is a source fork of the open-source `microsoft/vscode` repository. It is
not a wrapper around the Microsoft-branded Visual Studio Code distribution and
does not download a source tarball at build time.

The fork uses selected VS Code release tags as stable baselines. Hucode changes
are replayed onto each new baseline deliberately instead of continuously
tracking upstream development.

## Remotes and Branches

- `origin` is `jimeh/hucode`.
- A second remote points at `microsoft/vscode`. Its name is not fixed; local
  checkouts use `upstream`, `vscode`, or something else. Resolve it by URL
  rather than assuming a name:

  ```sh
  git remote -v | awk '
    $3 != "(fetch)" { next }
    $2 ~ /^https:\/\/github\.com\/microsoft\/vscode(\.git)?$/ ||
    $2 ~ /^ssh:\/\/git@github\.com\/microsoft\/vscode(\.git)?$/ ||
    $2 ~ /^git@github\.com:microsoft\/vscode(\.git)?$/ { print $1; exit }'
  ```

  Match the whole URL field rather than a substring, so a mirror or proxy
  whose path merely contains `github.com/microsoft/vscode` is not accepted
  as the upstream baseline source.

- `upstream-<version>` points to an unmodified selected VS Code release tag.
- `series-<version>` contains the Hucode patch series on that baseline.
- `series-<version>-replay` is a temporary curated replay of a completed Hucode
  series, used as the input to the next upgrade.

The active `series-*` branch is both the development branch and the GitHub
default branch. When Hucode moves to a new VS Code baseline, the repository
default moves to the validated new series branch. There is no persistent
`main` integration branch today.

This means branch-sensitive links and automation must not assume `main`.
Prefer GitHub's `HEAD` alias for links that should follow the current default,
and query the repository's live default branch when a concrete branch name is
required.

## Baseline and Series Invariants

Keep every `upstream-<version>` branch clean. It exists so the entire Hucode
patch can be inspected with:

```sh
git diff upstream-<version>..series-<version>
git log --oneline upstream-<version>..series-<version>
```

Publish the upstream baseline branch once it is created. Do not publish the new
series branch while it still points at the unmodified upstream commit: at that
point it does not contain Hucode's workflow changes, and GitHub may run the
upstream VS Code CI configuration.

Publish the series branch only after the Hucode patch stack has been replayed
and validated. Once it becomes the active development line, make it the GitHub
default branch.

Do not rewrite an older completed series while preparing an upgrade. Its tree
and history are evidence for the release line that used it.

## Replay Branches

Development branches accumulate upgrade conflict fixes, generated-asset churn,
and intermediate commits that should not be carried forever. Before an
upgrade, create `series-<version>-replay` from the matching clean baseline and
rebuild the final Hucode diff as a smaller sequence of stable topic commits.

The replay branch should be tree-equivalent to the completed series unless a
difference is intentional and documented:

```sh
git diff --exit-code series-<version>-replay..series-<version>
git diff --stat upstream-<version>..series-<version>-replay
git log --oneline upstream-<version>..series-<version>-replay
```

The next series cherry-picks from this curated replay branch, not from the raw
development history. Replay branches are upgrade working material rather than
the repository default branch. Treat one as completed history once it has been
used for a newer upgrade.

## Upgrade Outline

The project-local
[`hucode-upgrade-vscode`](../../.agents/skills/hucode-upgrade-vscode/SKILL.md)
skill is the source of truth for the executable upgrade procedure. At a high
level, an upgrade is:

1. Verify the current series is clean and buildable.
2. Curate and verify its tree-equivalent replay branch.
3. Fetch only the selected upstream release tag.
4. Create and publish the clean `upstream-<new-version>` baseline.
5. Compare the new baseline with the fork provenance inventory.
6. Create `series-<new-version>` locally at that baseline.
7. Run `npm install` for the new upstream dependency set.
8. Cherry-pick the previous curated patch series and resolve each conflict
   against the new upstream API.
9. Run Hucode compile, validation, tests, and a manual launch smoke test.
10. Push the completed series and move the GitHub default branch to it.

Fork and upstream-patch provenance lives in
`build/hucode/upstream-provenance.json`. The ordinary
`npm run hucode:check-upstream-provenance` check validates that inventory
without requiring an upstream branch, so it also works in shallow pull-request
checkouts. During an upgrade, compare the recorded source blobs with the new
clean baseline explicitly:

```sh
npm run hucode:check-upstream-provenance -- \
  --upstream-ref upstream-<new-version>
```

A changed source is an upgrade tripwire, not metadata to refresh blindly.
Reconcile the Hucode fork or patch with the new upstream source first, then
update its `lastSyncedBaseline` and `blob` and rerun the check. New workbench
or shell Part forks need their own provenance entry; the normal CI check fails
when one is missing.

The upgrade also has one manual Electron seam: the hosted-workspace request
filters read an optional, untyped `webContentsId` from Electron request
details. It supplements the tracked renderer process id and therefore fails
closed if Electron removes it. After a baseline bump, verify the field still
identifies hosted renderer requests and keep both trust checks narrow; do not
replace it with a broader window or frame heuristic.

Do not update Hucode release metadata until the replay is coherent. Keep root
`package.json` `version` aligned with upstream and store the Hucode release
version in overlay `hucodeVersion`.

If an upgrade must be abandoned, reset only the new series branch. If replay
curation must be abandoned, reset only the new replay branch. Never repair a
failed upgrade by rewriting the previous release line.

## Upstream Fetch Policy

Prefer narrow upstream fetches:

- fetch only the release tags or branches required for an upgrade
- do not fetch every upstream tag by default
- do not track upstream development branches unless a specific investigation
  needs them

This keeps branch output legible and makes baseline changes intentional.

A shallow release-tag import can help with local setup, but it may not be
enough when publishing history to a new remote. Older reachable VS Code commits
can contain Git LFS pointers for Copilot simulation caches even though Hucode's
current tree does not require Git LFS.

## A Possible Future `main`

A stable `main` branch could make external links and some automation more
conventional, but its history contract must be designed before it is created.
Each Hucode series replays patches onto a new upstream release rather than
continuing as a simple linear descendant of the previous development branch.
Automatically merging every active series into `main` can therefore retain
duplicate patch ancestry, repeated conflict resolutions, and merge-only noise.

Before automating this, decide what `main` would mean:

- a force-updated mirror of the current series tip
- an archive that records one merge per completed series
- a true integration branch with a different, linear upgrade workflow

Those models have different consequences for stable URLs, pull request bases,
bisectability, and contributor expectations. Until one is chosen, the rolling
default `series-*` branch is the repository contract.

## Keeping the Fork Diff Healthy

Prefer additive seams and Hucode-owned modules over wide edits to upstream
files. Hucode-heavy areas currently include:

- `src/vs/hucode`
- `src/vs/platform/projectManager`
- Hucode-named integration helpers beside upstream consumers
- `build/hucode`
- the tracked product overlay under `build/hucode/mixin/stable`

Root `product.json` and upstream resource files are not Hucode-owned branding
surfaces. Wrapper commands stage the overlay temporarily for builds.

Keep branding, release plumbing, and feature code in separate commits where
practical. When a deep upstream patch is unavoidable, document why and route
the Hucode-specific policy into a small named helper so later upgrades have a
clear conflict boundary.

## Why a Source Fork

Hucode changes Electron main-process services, platform services, workbench
entrypoints, and the browser server. A real source fork preserves:

- normal Git history, blame, search, and navigation
- an inspectable diff against each upstream release
- explicit conflict resolution during upgrades
- predictable builds and release packaging

A build-time source tarball would obscure those properties while offering
little benefit for a product-level fork.
