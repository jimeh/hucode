# Hucode macOS Release Build Size Analysis

This document captures the investigation into why Hucode macOS app bundles are
larger than official VS Code bundles, and how upstream VS Code production builds
reduce final app size. It is intended as a handoff for agents working on Hucode
release or build-release workflow fixes.

## Summary

The size gap is mostly packaging shape, not Electron.

Official VS Code production builds do three important things:

- strip local core and dependency source maps during CI packaging
- package app `node_modules` from production dependencies only, then clean them
- build Copilot separately as a production VSIX and inject that VSIX output into
  `.build/extensions/copilot`

Hucode's GitHub Actions release app already benefits from CI source-map
stripping, which explains why it is much smaller than the local app. The
remaining gap is mostly the locally packaged Copilot extension dependency tree.

## Bundles Inspected

The investigation compared these macOS apps:

- local Hucode app:
  `dist/hucode-darwin-arm64/Hucode.app`
- Hucode GitHub Actions app mounted from DMG:
  `/Volumes/VS Code/Hucode.app`
- official VS Code app:
  `/Applications/Visual Studio Code.app`

All inspection was read-only, using `du`, `ls`, `PlistBuddy`, and package JSON
inspection.

## Size Comparison

Expanded bundle sizes:

| Area | Local Hucode | Actions Hucode | Official VS Code |
| --- | ---: | ---: | ---: |
| App total | `1358M` | `903M` | `625M` |
| `Contents/Resources/app` | `1085M` | `630M` | `359M` |
| `app/out` | `320M` | `70M` | `53M` |
| `app/extensions` | `528M` | `347M` | `143M` |
| `app/extensions/copilot` | `423M` | `290M` | `86M` |
| `app/extensions/copilot/node_modules` | `369M` | `236M` | `25M` |
| `app/node_modules` | `238M` | `198M` | `138M` |

The local Hucode app is large primarily because it retains source maps. The
Actions Hucode app strips most of those maps, but still carries a much larger
Copilot dependency tree than official VS Code.

## Source Map Findings

Source-map totals under `Contents/Resources/app`:

| App | Map count | Map size |
| --- | ---: | ---: |
| Local Hucode | `11246` | `506880K` |
| Actions Hucode | `2934` | `24688K` |
| Official VS Code | `530` | `6856K` |

The local app had very large core maps, including:

- `out/vs/workbench/workbench.desktop.main.js.map`
- `out/vs/hucode/omni.desktop.main.js.map`
- `out/vs/sessions/sessions.desktop.main.js.map`

The Actions app has `app/out` at `70M`, close to official VS Code's `53M`.
That means CI source-map stripping is working for the GitHub Actions app.

The local app is different because `build/gulpfile.vscode.ts` only strips maps
when one of the CI-like environment variables is present:

- `CI`
- `BUILD_ARTIFACTSTAGINGDIRECTORY`
- `GITHUB_WORKSPACE`

Relevant code:

- `build/gulpfile.vscode.ts`
  - `sourceMappingURLBase`
  - `isCI`
  - `useCdnSourceMapsForPackagingTasks`
  - `stripSourceMapsInPackagingTasks`
- package source filter:
  `sourceFilterPattern = ['**', '!**/*.{js,css}.map']`
- package dependency filter:
  `depFilterPattern.push('!**/*.{js,css}.map')`

For local Hucode release builds, this means source maps stay in the app unless
the environment looks like CI.

## Upstream VS Code Source Map Flow

Official production builds externalize core source maps to the VS Code CDN.

The source-map URL base is:

```text
https://main.vscode-cdn.net/sourcemaps/<commit>
```

Core minified bundles are emitted with source-map URLs such as:

```text
https://main.vscode-cdn.net/sourcemaps/<commit>/core
```

In Azure Pipelines, source maps are uploaded separately instead of being kept in
the installed app. For web builds, this happens through:

- `build/azure-pipelines/upload-sourcemaps.ts`

For Copilot, source maps are uploaded in the separate Copilot pipeline stage:

- `build/azure-pipelines/product-copilot.yml`
  - `Upload source maps to CDN`
  - source directory: `extensions/copilot/dist-sourcemaps`
  - target prefix:
    `sourcemaps/github.copilot-chat/<extension-version>`
  - commit mapping:
    `sourcemaps/github.copilot-chat/commits/<commit>.json`

## App node_modules Packaging

Official VS Code does not copy raw root `node_modules` into the app.

The packaging task starts from production dependencies only:

```text
npm ls --all --omit=dev --parseable
```

That logic lives in:

- `build/lib/dependencies.ts`
  - `getNpmProductionDependencies()`
  - `getProductionDependencies()`

Then package tasks expand those dependency paths into gulp globs and apply
cleanup filters.

Important cleanup files:

- `build/.moduleignore`
- `build/.moduleignore.<platform>`
  - for macOS: `build/.moduleignore.darwin`

The general cleanup removes many non-runtime files:

- `docs/`, `example/`, `examples/`
- `test/`, `tests/`
- common readmes/changelogs/contributing docs
- `*.ts`
- native module source, deps, test, and build inputs
- unneeded native prebuilds
- selected wrong-platform modules

The macOS-specific cleanup excludes Windows-only native packages such as:

- `@vscode/windows-mutex`
- `@vscode/windows-process-tree`
- `@vscode/windows-registry`

The desktop packaging task also excludes:

- package locks
- `yarn.lock`
- selected old Electron ABI bins
- `*.js.map` and `*.css.map` when `stripSourceMapsInPackagingTasks` is true

Relevant code:

- `build/gulpfile.vscode.ts`
  - `productionDependencies = getProductionDependencies(root)`
  - `dependenciesSrc`
  - `depFilterPattern`
  - `util.cleanNodeModules(...)`
  - `filter(getCopilotExcludeFilter(platform, arch))`

## ASAR Behavior

ASAR is mostly a layout/runtime mechanism, not the main size reducer.

The package task writes most app dependencies into `node_modules.asar`, while
keeping some files outside in `node_modules.asar.unpacked` or duplicated in
plain `node_modules`.

Files kept unpacked include:

- `*.node`
- ripgrep binaries
- `@github/copilot-*` platform packages
- selected `node-pty` runtime files
- `*.wasm`
- `@vscode/vsce-sign` binaries

Files skipped from ASAR remain in plain `node_modules`.
Files duplicated are both in ASAR and plain `node_modules`.

Relevant code:

- `build/lib/asar.ts`
- `build/gulpfile.vscode.ts`
  - `createAsar(...)`

The main size reduction has already happened before ASAR, through production
dependency selection and `.moduleignore` pruning.

## Copilot Packaging Is The Main Remaining Gap

The largest remaining difference between Actions Hucode and official VS Code is
Copilot:

| Area | Actions Hucode | Official VS Code | Delta |
| --- | ---: | ---: | ---: |
| `extensions/copilot` | `290M` | `86M` | `+204M` |
| `extensions/copilot/node_modules` | `236M` | `25M` | `+211M` |

Official VS Code's shipped Copilot extension has only two node_modules scopes:

- `@github`
- `@vscode`

Hucode's Actions build ships roughly 190 dependency folders under
`extensions/copilot/node_modules`, including large groups such as:

- `@github` around `68M`
- `@anthropic-ai` around `56M`
- `@opentelemetry` around `30M`
- `@microsoft` around `20M`
- `@img` around `16M`

This is not mainly source maps in the Actions build. Copilot dependency maps in
the Actions app total only about `9M`. The issue is that Hucode is packaging
many more runtime dependency folders than official VS Code.

## Why Official VS Code Copilot Is Smaller

Upstream VS Code has a separate Azure Pipelines `Copilot` stage:

- `build/azure-pipelines/product-copilot.yml`

That stage:

1. checks out source
2. runs Copilot setup
3. runs Copilot tests
4. builds the Copilot extension
5. generates localization and notices
6. extracts telemetry
7. minifies JSON files outside `node_modules`
8. packages the extension with `vsce`
9. publishes `copilot-chat.vsix` as the `copilot_vsix` pipeline artifact
10. uploads Copilot source maps to the CDN

The platform product build then waits for and downloads that artifact:

- `build/azure-pipelines/common/downloadCopilotVsix.ts`

It extracts the VSIX into:

```text
.build/extensions/copilot
```

The macOS product compile flow does this before packaging the client:

- `build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml`
  - `Download Copilot VSIX (background)`
  - `Download Copilot VSIX`
  - `Build client`

After that, the CI package task consumes `.build/extensions/copilot` directly.

## What Hucode Currently Does Instead

Hucode's release wrapper runs:

```text
node build/hucode/release-build.ts
```

That script chooses:

```text
vscode-<platform>-<arch>-min
```

not:

```text
vscode-<platform>-<arch>-min-ci
```

The non-`-ci` gulp task builds and packages Copilot locally from source:

- `build/gulpfile.extensions.ts`
  - `compileCopilotExtensionBuildTask`
- `build/lib/extensions.ts`
  - `packageCopilotExtensionStream()`

`packageCopilotExtensionStream()` does two things:

1. packages the local extension files through `fromLocal(...)`
2. separately merges every production dependency returned by:

```text
getProductionDependencies('extensions/copilot')
```

That second step is the problem. It broadly includes Copilot production
dependencies as directories under `extensions/copilot/node_modules`, cleaned only
by generic `.moduleignore` rules.

The local extension's `.vscodeignore` is much tighter and appears designed for a
VSIX-shaped package. It allowlists specific files such as:

- `dist/extension.js`
- selected `dist/*.wasm`, `dist/*.json`, token assets, and worker files
- selected `node_modules/@github/copilot/sdk` files
- selected `@vscode/copilot-typescript-server-plugin` files

But Hucode's extra dependency merge in `packageCopilotExtensionStream()` bypasses
that VSIX-shaped output and puts the full production dependency tree into
`.build/extensions/copilot`.

## package.json Differences

Official VS Code's shipped Copilot package has:

- `buildType: "prod"`
- marketplace-style `__metadata`
- dependencies and devDependencies retained in `package.json`
- many localized `package.nls.*.json` files
- `ThirdPartyNotices.txt`
- a small `node_modules`

Hucode's Actions Copilot package has:

- `buildType: "dev"`
- no `dependencies` or `devDependencies` in the shipped `package.json`
- fewer localization files
- small local `LICENSE.txt`
- large `node_modules`

The `dependencies` removal happens because local bundled extensions go through
`updateExtensionPackageJSON()` in `build/lib/extensions.ts`.

The `buildType: "dev"` value comes from the source
`extensions/copilot/package.json`.

## Product JSON Notes

In the inspected official VS Code app:

- `product.json` did not list `GitHub.copilot-chat` in `builtInExtensions`
- `builtInExtensionsEnabledWithAutoUpdates` included `GitHub.copilot-chat`
- `extensions/copilot` was still present in the app bundle

That is consistent with the product build injecting Copilot from the separate
VSIX artifact into `.build/extensions/copilot`, rather than treating it as a
normal product `builtInExtensions` marketplace download.

In Hucode's product config, Copilot is also listed under:

```json
"builtInExtensionsEnabledWithAutoUpdates": ["GitHub.copilot-chat"]
```

but Hucode currently relies on the local source-package fallback in release
builds.

## Recommended Fix Paths

### Preferred: Mirror Upstream Copilot VSIX Injection

The Hucode release workflow now has a `copilot-vsix` job that builds Copilot as
a VSIX and uploads it as `hucode-copilot-vsix`. Platform build jobs download
that artifact and pass it to `build/hucode/release-build.ts --copilot-vsix`,
which extracts the VSIX into `.build/extensions/copilot` before the desktop app
package task.

This is closest to upstream and most likely to reproduce official size:

1. build Copilot
2. run any required mixin/setup steps
3. generate notice/telemetry/localization artifacts if needed
4. run `vsce package`
5. extract VSIX `extension/` contents into `.build/extensions/copilot`
6. package desktop app using a CI-style package task that does not rebuild
   Copilot locally

The upstream model to copy is:

- `build/azure-pipelines/product-copilot.yml`
- `build/azure-pipelines/common/downloadCopilotVsix.ts`
- `build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml`

Hucode mirrors that artifact shape through GitHub Actions rather than Azure
Pipelines: build VSIX once, then inject that VSIX output.
The official private `microsoft/vscode-capi` mixin is not publicly accessible,
so Hucode's GitHub workflow uses the public Copilot build and packaging steps.
The Hucode release wrapper also rejects VSIX contents that already carry
platform-specific Copilot executable packages or ripgrep binaries. The final
desktop package task injects the target-specific ripgrep shim and the wrapper
validates that shim in the packaged app.

### Alternative: Make Local Copilot Packaging VSIX-Shaped

If a separate VSIX stage is too much right now, change
`packageCopilotExtensionStream()` so it does not merge all production
dependencies.

Possible approaches:

- call `vsce.listFiles(...)` and trust `.vscodeignore`
- add a Copilot-specific dependency allowlist matching `.vscodeignore`
- run `vsce package` locally and stream/extract the resulting VSIX
- add explicit filters for large dependency families if they are unnecessary

This must be verified carefully because Copilot runtime imports may depend on
files that are copied or shimmed during `extensions/copilot/script/postinstall.ts`.

### Also Fix Local Source Map Behavior

For local `npm run hucode:build:production` and
`npm run hucode:build:release`, Hucode now forces release packaging to strip
local source maps even outside CI. `build/hucode/release-build.ts` sets
`GITHUB_WORKSPACE` for the upstream gulp build subprocess, which reuses the
existing upstream CI packaging path without modifying `build/gulpfile.vscode.ts`.
Pass `--include-source-maps` to keep source maps in a local package.

The Actions app is already much smaller because GitHub Actions sets
`GITHUB_WORKSPACE`, making `isCI` true.

## Verification Commands

Useful read-only checks:

Release CI now writes size reports as build artifacts with:

```bash
node build/hucode/release-size-report.js \
  --platform darwin \
  --arch arm64 \
  --app ../VSCode-darwin-arm64 \
  --out .build/hucode/release/<version>/size-report-darwin-arm64.json \
  --markdown-out .build/hucode/release/<version>/size-report-darwin-arm64.md \
  --copilot-node-modules-warn-mb 100
```

The warning threshold is intentionally loose until a release workflow run with
VSIX-injected Copilot establishes a stable baseline. Tighten it or add
`--copilot-node-modules-fail-mb` after the first successful reports.

```bash
du -sh \
  dist/hucode-darwin-arm64/Hucode.app \
  "/Volumes/VS Code/Hucode.app" \
  "/Applications/Visual Studio Code.app"
```

```bash
du -sk \
  "/Volumes/VS Code/Hucode.app/Contents/Resources/app"/* |
  sort -nr |
  head -80
```

```bash
du -sk \
  "/Volumes/VS Code/Hucode.app/Contents/Resources/app/extensions"/* |
  sort -nr |
  head -80
```

```bash
du -sk \
  "/Volumes/VS Code/Hucode.app/Contents/Resources/app/extensions/copilot"/* |
  sort -nr |
  head -80
```

```bash
zsh -lc '
sum=0
count=0
for f in "/Volumes/VS Code/Hucode.app/Contents/Resources/app"/**/*.map(N); do
  kb=$(du -sk "$f" | cut -f1)
  sum=$((sum + kb))
  count=$((count + 1))
done
print "$count $sum"
'
```

Check shipped Copilot package shape:

```bash
node - <<'NODE'
const paths = [
  '/Volumes/VS Code/Hucode.app/Contents/Resources/app/extensions/copilot/package.json',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json'
];

for (const path of paths) {
  const pkg = require(path);
  console.log(path);
  console.log(JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    buildType: pkg.buildType,
    hasMetadata: Boolean(pkg.__metadata),
    hasDependencies: Boolean(pkg.dependencies),
    hasDevDependencies: Boolean(pkg.devDependencies),
    main: pkg.main
  }, null, 2));
}
NODE
```

## Files To Review Before Changing Packaging

Core package flow:

- `build/hucode/release-build.ts`
- `build/gulpfile.vscode.ts`
- `build/gulpfile.extensions.ts`
- `build/lib/extensions.ts`
- `build/lib/dependencies.ts`
- `build/lib/asar.ts`
- `build/.moduleignore`
- `build/.moduleignore.darwin`

Copilot setup and packaging:

- `extensions/copilot/package.json`
- `extensions/copilot/package-lock.json`
- `extensions/copilot/.vscodeignore`
- `extensions/copilot/script/postinstall.ts`
- `build/azure-pipelines/product-copilot.yml`
- `build/azure-pipelines/common/downloadCopilotVsix.ts`
- `build/azure-pipelines/copilot/setup-steps.yml`
- `build/azure-pipelines/copilot/build-steps.yml`

Hucode release workflows:

- `.github/workflows/hucode-release-build.yml`
- `.github/workflows/hucode-ci.yml`

## Expected Outcome

If Hucode mirrors upstream Copilot VSIX injection and continues stripping source
maps in release packaging, the macOS expanded app should move much closer to
official VS Code's size.

The current Actions app is about `903M`. Replacing the local Copilot package
shape with an official-like VSIX shape could plausibly remove around `200M`.
That would put Hucode roughly in the `700M` range before any additional app
`node_modules` cleanup or Hucode-specific code-size work.

The exact target should account for Hucode's additional Omni code and any
intentional extra runtime dependencies.
