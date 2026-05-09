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

- TOML files cannot carry VS Code's standard block copyright header. Keep
  `*.toml` excluded from copyright hygiene rather than adding invalid TOML.
