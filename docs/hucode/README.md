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
- `npm run hucode:generate-icons`: regenerate Hucode macOS icon assets from
  `build/hucode/icons/darwin/`.
- `npm run hucode:build:production`: build a minified desktop app and move it
  into the default `dist/hucode-<platform>-<arch>` output directory. Local
  release builds strip packaged source maps by default; pass
  `-- --include-source-maps` to keep them for debugging.
- `npm run hucode:build:release`: build a minified desktop app, create a zip
  archive, and move the app output into `dist/`.
- `node build/hucode/release-build.js --copilot-vsix <path>`: inject a
  prebuilt Copilot VSIX into `.build/extensions/copilot` before packaging the
  desktop app, matching the release workflow's smaller Copilot package shape.
