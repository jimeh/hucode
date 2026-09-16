# Developing Hucode

Hucode builds directly from the VS Code source tree. Follow the upstream VS
Code prerequisites for your platform, then install dependencies from the
repository root:

```sh
npm install
```

## Product Overlay

Hucode identity and product configuration live in the tracked overlay at
`build/hucode/mixin/stable/`. Root `product.json` and upstream resource files
must remain VS Code OSS in committed source.

Hucode wrapper commands prepare the overlay under
`.build/distro/mixin/stable/` and stage it only for the subprocess that needs
Hucode product data. Do not make permanent branding edits to upstream product
files to work around a local launch or build problem.

Hucode's release version is the overlay's `hucodeVersion`. The root package
`version` remains the selected VS Code compatibility version.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run hucode:prepare` | Generate the stable mixin from the tracked overlay. |
| `npm run hucode:validate` | Verify the source overlay and generated mixin. |
| `npm run hucode:compile` | Compile the client, built-in extensions, and extension media with Hucode product data. |
| `npm run hucode:watch` | Run incremental compilation with Hucode product data. |
| `npm run hucode:run` | Launch the desktop app from existing compiled output. |
| `npm run hucode:web` | Launch the local serve-web server from existing compiled output. |
| `npm run hucode:cli` | Run the development CLI wrapper. |

For a one-shot desktop build and launch:

```sh
npm run hucode:compile
npm run hucode:run
```

For an incremental development loop, keep `npm run hucode:watch` running and
launch with `npm run hucode:run` or `npm run hucode:web` in another terminal.

## Validation

Use the narrowest check that covers the change:

- Product overlay: `npm run hucode:validate`
- Hucode TypeScript or workbench integration: `npm run hucode:compile`
- Incremental desktop UI: `npm run hucode:watch`, then
  `npm run hucode:run`
- Serve-web UI: `npm run hucode:watch`, then `npm run hucode:web`
- Project/worktree model: focused tests under `src/vs/hucode/test` or
  `src/vs/platform/projectManager/test`
- Build and release scripts: `npm run test-build-scripts`
- Edited-file hygiene: `npm run -s precommit -- <paths>`

Run focused tests for changed behavior when a nearby suite exists. Formatting
and pre-commit checks do not replace behavioral coverage.

Do not run `hucode:prepare` or `hucode:validate` concurrently with
`test-build-scripts`; they share generated mixin output. Also avoid running a
client compile while tests are consuming `out/`, because compile tasks can
clean that directory.

If a launch starts Electron in Node mode or exits before the main process,
check for inherited extension-host variables such as `ELECTRON_RUN_AS_NODE`
and `VSCODE_ESM_ENTRYPOINT`. An IDE-integrated terminal can carry them into a
nested launch.

## Where to Read Next

- [Omni](omni.md) for the user-visible model and lifecycle terminology
- [Architecture](architecture.md) for runtime ownership and invariants
- [Repository Strategy](repo-strategy.md) before a VS Code baseline upgrade
- [Release Guide](release.md) before changing versions or packaging
- [Agent Instructions](agent-instructions.md) for detailed subsystem gotchas

The agent instructions are intentionally detailed. They are also useful to
humans changing deep integrations, but this guide remains the short entry point
for routine development.
