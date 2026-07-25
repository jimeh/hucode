# Hucode Architecture and Quality Review Brief

## Review target

- Repository: `/home/jimeh/.herdr/worktrees/hucode/architecture-quality-review`
- Review branch: `architecture-quality-review`
- Hucode HEAD: `9988ea33b8b22cadc9332eae44c01df7589a22ad`
- Equivalent series tip: `series-1.130.0`
- Upstream baseline: `upstream-1.130.0`
- Upstream SHA: `1b6a188127eeaf9194f945eb6eb89a657e93c54c`
- Merge base: `1b6a188127eeaf9194f945eb6eb89a657e93c54c`
- Comparison: `upstream-1.130.0..HEAD`
- Hucode commits in comparison: 14
- Changed paths: approximately 495
- Diff summary: 492 files, 72,594 insertions, 1,283 deletions

The current review branch and `series-1.130.0` resolve to the same commit. The
comparison therefore represents the complete current Hucode patch stack on top
of the selected VS Code 1.130.0 baseline.

Supporting inventories in this directory:

- `changed-files.tsv`: name/status inventory for the complete comparison.
- `diff-stat.txt`: per-file diff statistics.
- `commits.tsv`: Hucode patch-series commits.
- `findings.schema.json`: required structured output schema.

## Primary question

What concrete architectural, correctness, reliability, testing, security,
upgradeability, or maintainability problems prevent the current Hucode codebase
from being considered non-alpha quality?

Assess both:

- **Beta readiness:** correctness, safety, lifecycle, recovery, and operational
  blockers.
- **Stable readiness:** architecture, test confidence, maintainability,
  observability, release reliability, and sustainable upstream upgrades.

## Product and architecture summary

Hucode is a source fork of VS Code. Its main product capability is Omni: a
persistent outer shell for projects, Git worktrees, arbitrary folder
workbenches, and multiple resident VS Code workbenches.

Primary runtime areas include:

1. **Omni shell**
   - Hucode-owned renderer and workbench bootstrap.
   - Projects UI, layout, focus, command routing, and lifecycle display.
   - Primarily under `src/vs/hucode/`.

2. **Hosted workbenches**
   - Electron `WebContentsView` instances on desktop.
   - Same-origin iframes in serve-web.
   - Shared `HostedWorkspaceStateModel` with platform-specific controllers.
   - Restore, loading, active, loaded, dormant, unloaded, missing, and crashed
     states.

3. **Project and worktree management**
   - Shared Node service under `src/vs/platform/projectManager/`.
   - Electron IPC and serve-web HTTP/SSE adapters.
   - Project persistence, Git worktree discovery and mutation, ordering, labels,
     pinning, and recent-worktree state.

4. **Desktop main-process integration**
   - Hosted renderer creation, visibility, z-order, focus, unload, crash, and
     shutdown coordination.
   - Native command, keybinding, clipboard, utility-process, and extension-host
     routing.

5. **Integrated browser views**
   - Top-level Electron view ownership associated with hosted workbenches.
   - Visibility, layout, destruction, and hit-testing integration.

6. **Serve-web Omni**
   - Hucode routes, shell and hosted-workbench bootstraps, project API, iframe
     IPC, storage, and lifecycle behavior.

7. **Product, build, release, and update infrastructure**
   - Tracked product overlay under `build/hucode/mixin/stable/`.
   - Hucode compile/run wrappers, CI, release packaging, signing, notarization,
     update metadata, standalone Rust CLI, and server-web archives.

8. **Fork and upgrade strategy**
   - Clean `upstream-*` release baselines.
   - Curated Hucode patch series and replay branches.
   - Preference for additive Hucode-owned seams over broad upstream edits.

## Required source material

Read at minimum:

- `AGENTS.md`
- `.github/copilot-instructions.md`
- `docs/hucode/agent-instructions.md`
- `docs/hucode/README.md`
- `docs/hucode/architecture.md`
- `docs/hucode/omni.md`
- `docs/hucode/roadmap.md`
- `docs/hucode/repo-strategy.md`
- `docs/hucode/development.md`
- `docs/hucode/release.md` when reviewing release/update infrastructure

Current guides describe intended contracts. They are useful evidence, but they
do not prove the implementation satisfies those contracts. Archived plans are
historical context, not current authority.

## Scope

Review the complete Hucode delta, including:

- Hucode-owned source modules.
- Modifications to upstream-owned VS Code files.
- Hucode-named companions beside upstream integration points.
- Tests and test architecture.
- Product overlay and configuration.
- Build, CI, packaging, release, update, signing, and publication code.
- Rust CLI integration where present in this repository.
- Desktop, serve-web, and shared behavior.
- Documentation where it defines or contradicts architectural contracts.
- Fork-maintenance and future VS Code upgrade burden.

Do not report generic inherited VS Code defects unless Hucode changed, exposed,
duplicated, or materially relies upon the affected behavior.

## Review dimensions

1. Architecture, layering, ownership, and dependency direction.
2. Lifecycle, state machines, persistence, restoration, and cleanup.
3. Concurrency, ordering, cancellation, retries, timeouts, and idempotency.
4. Error propagation, fallback behavior, partial failure, and recovery.
5. API contracts, type safety, compatibility, and invalid states.
6. Desktop/web parity and platform-specific divergence.
7. Security and trust boundaries, especially IPC, HTTP, filesystem, Git,
   process execution, and browser/desktop crossings.
8. Test coverage, test quality, observability, and reproducibility.
9. Build, release, signing, packaging, update, and publication reliability.
10. Maintainability, duplication, dead architecture, and confusing ownership.
11. Upstream upgrade sustainability and patch-boundary quality.

## VS Code architectural fit

Treat VS Code architecture and conventions as the default prior, not an
absolute constraint.

For each significant Hucode subsystem:

1. Search for analogous upstream VS Code features, services, and integration
   patterns.
2. Compare dependency boundaries, lifecycle, service registration, state
   ownership, API shape, cancellation, disposal, persistence, error handling,
   platform layering, contribution mechanisms, and tests.
3. Classify the subsystem as:
   - `upstream-aligned`
   - `justified-deviation`
   - `unjustified-deviation`
   - `hucode-specific`
   - `hybrid`
4. Determine whether upstream alignment would reduce duplication, inconsistent
   behavior, lifecycle risk, or upgrade burden.
5. Where requirements differ materially, assess whether a custom architecture
   is clearer and safer than adapting an unsuitable VS Code abstraction.
6. Even when custom architecture is justified, verify that its integration
   surfaces follow appropriate VS Code conventions.

Do not recommend alignment merely for consistency. Do not defend custom design
merely because it already exists. Any alignment finding must cite the upstream
analogue and explain the concrete consequence of the current choice.

Relevant VS Code conventions include, where applicable:

- `common`, `browser`, `electron-sandbox`, `electron-main`, and `node` layering.
- Dependency injection and constructor-declared service dependencies.
- Workbench/platform contribution and registration mechanisms.
- Events, observables, cancellation, and immediate disposable ownership.
- Commands, menus, context keys, configuration, localization, and accessibility.
- Storage, lifecycle, IPC, remote, browser, and desktop conventions.
- Existing test placement, fixtures, assertions, and coverage boundaries.

## Evidence and severity standards

A finding must:

- Identify specific files, lines, and symbols where possible.
- Explain the root cause rather than only the visible symptom.
- Describe a concrete runtime, maintenance, release, or upgrade scenario.
- Explain user, data, reliability, security, or maintenance impact.
- Distinguish confirmed evidence from plausible concerns.
- State verification already performed and further verification needed.
- Recommend an architectural or behavioral direction, not a patch.

Do not include general advice, speculative style complaints, or findings without
material consequences. Do not target a predetermined number of findings.

Severity definitions:

- **Critical:** credible data loss, security-boundary failure, or broadly broken
  core operation without a practical mitigation.
- **High:** serious/common failure, major architectural blocker, or substantial
  reliability/upgrade risk that should block beta or stable readiness.
- **Medium:** bounded defect or structural weakness that should be fixed during
  hardening.
- **Low:** real but limited debt with a contained consequence.

## Concurrency and repository safety

This initial review phase is blind and read-only except for each reviewer's own
artifact directory.

- Do not edit source, configuration, tests, documentation, dependencies, or Git
  state.
- Do not stage or commit anything.
- Do not invoke subagents or communicate with other reviewers.
- Do not read sibling reviewer directories.
- Do not run builds or tests that write shared output such as `out/`,
  `.build/electron`, or `.build/distro`.
- Record desired build, test, or runtime checks for the later serialized
  verification phase.
- Read-only searches, Git inspection, and static analysis are allowed.

## Required outputs

Each reviewer writes:

1. A Markdown report with:
   - executive assessment;
   - beta and stable readiness assessment;
   - strengths worth preserving;
   - findings ordered by severity;
   - VS Code alignment assessment;
   - cross-cutting themes;
   - testing and observability assessment;
   - upstream-upgrade sustainability assessment;
   - suggested verification commands;
   - deep, sampled, and unreviewed coverage;
   - limitations and unresolved questions.

2. A JSON document conforming to `findings.schema.json`.

Agreement is not required. Explicitly report areas that appear sound rather
than manufacturing concerns.
