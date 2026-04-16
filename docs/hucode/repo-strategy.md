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
- fetch reachable Git LFS objects for that history

Without that, GitHub may reject the first push because required objects are
missing.

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
