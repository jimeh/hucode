# Hucode Roadmap

This roadmap describes product capability by current status. It is not a
release schedule. Completed implementation plans are preserved under
[`archive/`](archive/) rather than kept here as active checklists.

## Completed

### Fork and Product Baseline

- Hucode builds as a branded VS Code source fork.
- Product identity is isolated in the tracked stable mixin overlay.
- OpenVSX is the extension gallery.
- Build, watch, run, web, icon, validation, changelog, and release commands are
  available from the repository root.
- Selected VS Code releases are tracked through clean `upstream-*` baselines
  and rolling `series-*` development branches.

### Omni Projects and Workbenches

- The Omni shell owns project navigation outside individual workbench
  renderers.
- Saved projects expose their git worktrees in the Projects sidebar.
- Arbitrary folder workbenches can coexist with project worktrees.
- Add, create, remove, rename, refresh, pin, reorder, switch, suspend, unload,
  and dismiss flows are implemented where applicable.
- Quick-pick, recent-workbench, previous, and next navigation are available.
- Folder-open requests route into Omni on desktop and serve-web.

### Hosted Workbench Lifecycle

- Desktop workbenches are hosted in Electron `WebContentsView` instances.
- Serve-web workbenches are hosted in same-origin iframes.
- Both adapters share indexing, active selection, navigation, readiness, and
  public lifecycle projection.
- Startup can restore the active workbench, all desired-loaded workbenches, or
  none of them eagerly.
- Dormant and suspended workbenches release renderer resources while retaining
  restoration intent.
- Explicit unload, renderer unload handshakes, crash state, shutdown flushing,
  and hosted browser-view cleanup are implemented.

### Shell and Extension Hardening

- Shell commands and keybindings route to the correct shell or hosted
  workbench scope.
- Focus and native paste handoff work across the shell and desktop hosts.
- User extensions are filtered for the lightweight Omni shell while hosted
  workbenches keep normal extension behavior.
- Integrated browser views remain interactive and track hosted-workbench
  visibility and ownership.

### Release and Update Pipeline

- GitHub Actions builds macOS, Linux, and Windows matrix targets.
- Required public releases contain macOS and Linux desktop packages plus
  standalone CLI and server-web archives for supported targets.
- Copilot is built once as a production VSIX and injected into platform builds.
- Release output has size reports, checksums, metadata validation, Linux
  package smoke tests, and guarded publication.
- macOS signing and notarization are integrated.
- Stable builds use `updates.hucode.dev`; macOS supports automatic ZIP updates,
  while Linux directs users to manual package downloads.

## Active

### VS Code Upgrade Discipline

- Keep the repository strategy and upgrade skill aligned with each new VS Code
  baseline.
- Curate replay branches so future upgrades carry stable Hucode patches rather
  than development and conflict-resolution churn.
- Keep the active `series-*` branch as the repository default and update
  branch-aware automation when the active series changes.
- Preserve thin, named Hucode integration seams as upstream APIs move.

### Hosted Workbench Reliability

- Continue hardening launch, eager restore, suspend, unload, crash, focus, and
  quit sequencing across desktop and serve-web.
- Exercise repeated switching with real repositories and multiple resident
  workbenches.
- Keep browser views, devtools, extension hosts, and utility-process ownership
  tied to the correct hosted workbench.
- Add focused regression tests whenever a lifecycle edge case is fixed.

### Documentation and Feedback Loops

- Keep the current guides useful to humans and agents.
- Move completed plans and one-off investigations into the archive with clear
  historical status.
- Record durable subsystem gotchas in `agent-instructions.md` and keep routine
  setup in the shorter development guide.
- Keep release documentation synchronized with machine-checked asset and
  workflow contracts.

## Later or Exploratory

These are possible directions, not committed release promises:

- Decide whether Hucode needs a stable `main` branch, and whether it would be a
  mirror, archive, or true integration branch. Avoid automatic merges until the
  desired history contract is clear.
- Decide whether Windows desktop packages should become public release assets,
  including signing, installation, update, and smoke-test requirements.
- Extend hosted Omni support beyond single-folder workbenches where the product
  model is clear, including workspace files, multi-root workspaces,
  remote-authority windows, or empty workbenches.
- Improve packaged-app and browser end-to-end coverage where reliable
  automation can replace manual acceptance testing.
- Continue reducing fork conflict surface as upstream VS Code evolves similar
  workspace-hosting or project-management capabilities.
