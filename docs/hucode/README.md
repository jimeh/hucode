# Hucode Docs

This directory captures Hucode-specific product, architecture, repository, and
agent guidance for this VS Code fork.

Start here:

- [Agent Instructions](./agent-instructions.md): Hucode-specific rules, gotchas,
  and boundaries agents should load before Hucode work.
- [Architecture](./architecture.md): current runtime shape, module ownership,
  and core invariants.
- [Repo Strategy](./repo-strategy.md): how to structure the fork, track VS Code
  releases, and package Hucode.
- [Release Build Size Analysis](./release-build-size-analysis.md): investigation
  notes on Hucode macOS app size, source maps, node_modules pruning, and
  upstream Copilot VSIX packaging.
- [Roadmap](./roadmap.md): completed, active, and later work.
- [Upgrade Skill](../../.agents/skills/hucode-upgrade-vscode/SKILL.md):
  operational workflow for upgrading the underlying VS Code release.

Current assumptions:

- Hucode is a real fork of `microsoft/vscode`, not a wrapper that downloads VS
  Code at build time.
- Hucode product identity lives in the tracked mixin overlay under
  `build/hucode/mixin/stable/`; root product files stay upstream OSS.
- The project manager lives outside any individual workspace renderer.
- Omni workspaces are hosted in Electron `WebContentsView` instances.
- Hucode is rebranded and uses OpenVSX for extension discovery and install.

Current local workflow:

- `npm run hucode:prepare`: generate the tracked stable overlay into
  `.build/distro/mixin/stable/`.
- `npm run hucode:validate`: verify the Hucode mixin and generated output.
- `npm run hucode:compile`: build client, built-in extensions, and extension
  media with Hucode product config staged for the subprocess.
- `npm run hucode:watch`: run the normal watch flow with Hucode product config
  staged for the subprocess.
- `npm run hucode:run`: launch the desktop app through the Hucode wrapper.
- `npm run hucode:web`: launch the local serve-web development server through
  the Hucode wrapper.
- `npm run hucode:generate-icons`: regenerate Hucode macOS icon assets from
  `build/hucode/icons/darwin/`.
- `npm run hucode:prepare-release -- --version <version>`: consume
  `.changes/*.md` fragments, update `CHANGELOG.md`, and bump Hucode release
  metadata before tagging a release.
- `npm run hucode:build:production`: build a minified desktop app and move it
  into the default `dist/hucode-<platform>-<arch>` output directory. Local
  release builds strip packaged source maps by default; pass
  `-- --include-source-maps` to keep them for debugging.
- `npm run hucode:build:release`: build a minified desktop app, create a zip
  archive, and move the app output into `dist/`.
- `node build/hucode/release-build.ts --phase build`: build the final unsigned
  app output at `../VSCode-<platform>-<arch>`, including Copilot target shims
  and the Hucode Rust CLI.
- `node build/hucode/release-build.ts --phase package --artifacts <list>`:
  package an existing final app output into release assets. The default phase is
  `all`, which preserves the older build-and-package flow. Include `cli` to
  package the mixed-in Rust CLI as a one-file standalone archive.
- `node build/hucode/release-build.ts --copilot-vsix <path>`: inject a
  prebuilt Copilot VSIX into `.build/extensions/copilot` before packaging the
  desktop app, matching the release workflow's smaller Copilot package shape.
- `node build/hucode/release-build.ts --prebuilt-cli <path>`: mix a CLI built
  for the selected target into the final app output. Release CI uses this for
  the x64-hosted Linux arm64 cross-build so the standalone CLI retains
  upstream's GLIBC 2.28 compatibility baseline.
- `node build/hucode/release-build.ts --platform darwin --arch <arch> --sign`:
  sign the macOS app, then sign, notarize, staple, and validate DMG release
  assets. Signed Darwin ZIP archives are still supported for explicit local
  artifact requests by notarizing and stapling the app before archiving it.
  Local signing uses the current keychain search list by default and does not
  create or switch keychains. It needs `APPLE_TEAM_ID` plus either
  `APPLE_NOTARIZATION_KEYCHAIN_PROFILE`, `APPLE_NOTARIZATION_KEY_PATH`, or
  `APPLE_NOTARIZATION_KEY_P8_BASE64`; API-key paths/base64 also need
  `APPLE_NOTARIZATION_ISSUER_ID` and `APPLE_NOTARIZATION_KEY_ID`. Release CI
  passes `--signing-mode ci` to import its base64 certificate and notary key
  into a temporary keychain.
- `node build/hucode/release-size-report.js --app <path>`: report packaged app
  size, key subdirectory sizes, source-map totals, and release size guardrails.

## Updates

Hucode stable builds use `https://updates.hucode.dev` as the built-in update
feed. The feed serves VS Code updater responses at
`/api/update/<platform>/stable/<commit>`, where macOS x64 uses `darwin` and
macOS arm64 uses `darwin-arm64`.

Release DMGs are manual install assets. Release ZIPs are the Squirrel.Mac
auto-update assets consumed by Electron's macOS updater. Builds produced before
the Hucode product mixin included `updateUrl` cannot discover updates
automatically, so the first updater-enabled release is the bootstrap for later
auto-updates.

GitHub Releases also publish standalone CLI and server-web archives for macOS,
Linux, and Windows x64/arm64. The CLI resolves matching server-web archives
through the platform-specific
`/api/latest/server-<platform>-<arch>-web/stable` endpoints; Linux armhf does
not support `serve-web` because there is no arm32 server build.
