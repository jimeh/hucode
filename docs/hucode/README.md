# Hucode Docs

This directory captures the current product plan for Hucode as a fork of
`microsoft/vscode`.

Start here:

- [Architecture](./architecture.md): product shape, runtime boundaries, and the
  main subsystems.
- [Repo Strategy](./repo-strategy.md): how to structure the fork, track VS Code
  releases, and package Hucode.
- [Roadmap](./roadmap.md): phased implementation plan and validation strategy.

Current assumptions:

- Hucode is a real fork of `microsoft/vscode`, not a wrapper that downloads VS
  Code at build time.
- The project manager lives outside any individual workspace renderer.
- Workspaces are hosted in Electron `WebContentsView` instances.
- Hucode is rebranded and uses OpenVSX for extension discovery and install.

Current local workflow:

- `npm run hucode:prepare`: generate the tracked stable overlay into
  `.build/distro/mixin/stable/`.
- `npm run hucode:watch`: run the normal watch flow with Hucode product config
  staged in place for the subprocess.
- `npm run hucode:run`: launch the desktop app through the Hucode wrapper.
