# Hucode first-launch onboarding and editor migration plan

Status: active

## Summary

Replace the upstream Copilot-first setup with a Hucode-owned, full-window
onboarding experience. The first release will help desktop users bring a setup
from Visual Studio Code, Visual Studio Code Insiders, or Cursor, review every
planned change, and learn the small part of Omni they need before opening their
first project or workbench.

The migration flow will ship first as the rerunnable **Hucode: Import Setup from
Another Editor...** command. First-launch onboarding will embed the same flow
after it has independent test and runtime evidence. The final activation change
will only replace startup routing, connect versioned completion state, and turn
the Hucode experience on for new installations.

Serve-web onboarding is deliberately deferred. Its useful migration sources may
include browser-owned Hucode data, server-owned Hucode data, a desktop Hucode
export, or an uploaded profile. The desktop design must leave room for new source
adapters without choosing a web migration contract now.

## Settled product decisions

- Onboarding occupies the whole Hucode window. It is not an editor, modal, or
  dialog. Native window controls and the draggable title area remain available.
- GitHub sign-in, Copilot, Settings Sync, and account management stay available
  after onboarding but do not occupy a main step.
- Full onboarding completion belongs to the Hucode user-data installation, not
  to a profile.
- Each import names exactly one ordinary target profile. The Omni shell's
  internal profile is never a target or a user-facing choice.
- The first automatic source adapters cover Visual Studio Code, Visual Studio
  Code Insiders, and Cursor. Later editors get separate adapter work after the
  initial contract is proven.
- The first import categories are settings and appearance, keybindings,
  extensions, and snippets. User tasks are deferred.
- Extension import is additive. Hucode installs reviewed compatible releases
  from its configured Open VSX gallery and never removes target extensions just
  because the source lacks them.
- Start Fresh remains as prominent as migration.
- Appearance mode stays separate from concrete preferred light and dark themes.
- Onboarding offers one **Use compact worktree and workbench lists** toggle. It
  writes both underlying Omni layout settings together while those settings
  remain independently configurable later.
- The public layout value `twoLine` becomes `default` for both settings. Stored
  explicit values migrate without changing appearance.
- The list choice uses a fake Projects list because a new user has no project
  catalog yet. The preview includes project worktrees and an arbitrary
  workbench.
- The permanent empty Omni host becomes an actionable landing view with **Add
  Project** and **Open Folder as Workbench** actions.
- Serve-web and additional editor adapters do not block the first desktop
  release.

## Current product constraints

### Omni profiles

The Omni shell uses a stable internal profile to bootstrap shell services.
Hosted workbenches use ordinary VS Code workspace-profile associations and may
switch profiles independently. The projects catalog is global.

Onboarding therefore has two separate state concerns:

- installation-scoped walkthrough state, including completion and resume data;
- target-profile-aware migration state, including the reviewed plan, operation
  progress, snapshots, and results.

Importing into a named profile does not make the shell use that profile. When
the user adds a repository at the end, onboarding may associate that workspace
with the chosen target profile. It must not replace an existing association
without an explicit choice.

### Omni layout settings

The Projects sidebar exposes two window-scoped settings:

- `hucode.omni.workbenchItemLayout`
- `hucode.omni.worktreeItemLayout`

Both now accept `default` or `compact` and default to `default`. PR #207 migrated
explicit stored `twoLine` values to `default`, while runtime normalization
continues to interpret a legacy `twoLine` value as `default`.

The settings remain separate. Onboarding writes the same staged choice to both
when the user continues past the Omni setup step. Back navigation preserves the
staged value without changing configuration.

### Empty hosted-workbench state

`OmniHostPart` distinguishes its hosted surface from an empty element and
reveals the Projects sidebar when no workbench is available. PR #209 replaced
the old passive sentence with the actionable landing view described below.

The landing view adapts its text to the state:

- with no projects or retained workbenches, explain the two ways to start and
  offer both actions;
- with catalog entries but no active workbench, lead with selecting an existing
  item and keep both add actions available;
- keep crash recovery distinct from a clean empty state.

Both buttons invoke the existing project and workbench commands. The landing
view does not duplicate file dialogs, canonical path ownership, or workbench
opening logic.

## User experience

### Standalone migration command

**Hucode: Import Setup from Another Editor...** is the first complete consumer
of the migration system. It supports the whole flow without first-launch state:

1. discover and select a source installation and source profile;
2. choose one ordinary Hucode target profile;
3. review categories, filtered values, conflicts, and extension compatibility;
4. apply the accepted plan with cancellable per-category progress;
5. show completed, skipped, failed, and unavailable items;
6. offer retry, recovery, rollback of file-backed categories, and a copyable
   report where applicable.

The command and onboarding share migration services, flow state, and UI
components. Onboarding calls those services directly instead of executing the
command internally. Each host may frame the shared UI differently.

### Full-window onboarding

Onboarding replaces normal workbench content below the native window controls.
It uses primary application semantics rather than dialog semantics. It has no
backdrop, dialog role, or modal focus trap.

The first release has three stages.

#### 1. Bring your setup

- Show validated Visual Studio Code, Visual Studio Code Insiders, and Cursor
  sources.
- Show named profiles only when a strict known-schema reader validates them.
- Label modification evidence accurately. Do not describe a file timestamp as
  last editor use.
- Show available categories, extension count, source path details, and
  diagnostics for partial sources.
- Rank usable sources deterministically by resource completeness, trustworthy
  modification evidence, and stable-channel preference.
- Offer **Start Fresh** with equal prominence.
- Offer explicit `.code-profile` selection as an escape hatch.
- Allow **Do This Later** without starting an import.

#### 2. Review import or start fresh

For migration:

- choose one ordinary target profile;
- preserve target values by default;
- review settings filters and key-level conflicts;
- review keybinding conflicts and snippet file collisions;
- select categories independently;
- show named extension classifications before any write;
- require another review if the target or gallery result changes.

For Start Fresh:

- choose System, Light, or Dark mode behavior;
- choose concrete preferred light and dark themes separately;
- explain that migration remains available from the Command Palette.

#### 3. Import and meet Omni

- Apply the reviewed plan and show accurate results before describing the
  target as ready.
- Explain Project, Worktree, Workbench, Loaded, Dormant, Suspend, and Unload in
  the smallest useful amount of copy.
- Show a fake Projects list with at least one project root, one linked worktree,
  and one arbitrary workbench.
- Offer **Use compact worktree and workbench lists** with an immediate preview.
- Use resolved platform keybinding labels.
- Offer **Add Project**, **Open Folder as Workbench**, and **Finish for Now**.
- If a non-Default target profile was chosen, make any new workspace-profile
  association explicit.
- Finish in the real Omni shell rather than opening another welcome page.

### Rerun behavior

- **Hucode: Open Onboarding** reopens the full experience after first launch.
- Reopening onboarding does not erase existing values or repeat an import.
- **Hucode: Import Setup from Another Editor...** starts a new migration
  independently of walkthrough completion.
- Creating a profile does not force the full walkthrough.
- Resetting upstream welcome-page state does not rerun Hucode onboarding.

## Migration model

### Discover

Desktop source adapters inspect readable user-data directories, not application
binaries. They never start or modify the source editor.

Each adapter defines:

- product and channel identity;
- platform-specific candidate user-data and extension roots;
- the expected Default and named-profile layout;
- resource readers and source-specific filters;
- evidence used for ranking and deduplication.

Discovery must be read-only, cancellable, and tolerant of missing, locked,
partially written, malformed, symlinked, and unfamiliar data. Readers consume
known files and known keys. They do not copy or import opaque application state,
SQLite databases, workspace history, authentication state, or telemetry
identity.

The normalized discovery result must allow future adapters without exposing a
source editor's raw layout to the planner. This is the only forward-looking
extension point required for future serve-web or editor-specific sources.

### Plan

Planning is pure with respect to Hucode user data. It reads the selected source,
target profile, current product configuration, and configured extension gallery
to produce an immutable reviewed plan.

The plan records:

- source and target fingerprints;
- selected categories;
- normalized source resources;
- filtered settings and the reason for every product-specific exclusion;
- target conflicts and the selected resolution;
- extension classification and the exact compatible release selected;
- snapshot requirements and apply ordering.

Extension classifications are:

- available from Open VSX and installable;
- built into Hucode;
- already installed in the target profile;
- unavailable from the configured gallery;
- incompatible with the current platform or product version;
- excluded because the extension belongs to the source editor.

If the source, target, or gallery result changes before Apply, the flow returns
to Review. Apply never silently resolves a different plan.

### Apply

Apply receives an accepted plan and explicit target profile. It does not infer
the target from the current window or shell profile.

The operation order is:

1. persist the admitted operation and pre-apply fingerprints;
2. snapshot every selected file-backed target resource;
3. apply settings, keybindings, and snippets with atomic writes where the file
   provider supports them;
4. persist each category result;
5. install reviewed extensions additively;
6. persist the final result before completion UI appears.

Each category is idempotent. A rerun against the same source and target reaches
the same planned result without duplicate settings, keybindings, snippets, or
extension installs.

File-backed categories can return to their pre-operation snapshots. Successful
extension installs remain installed if another extension fails. The result
reports every successful, skipped, unavailable, incompatible, canceled, and
failed item.

Cancellation before Apply leaves the target unchanged. Cancellation after
writes begin stops only at documented safe boundaries and leaves a resumable
operation record. A restart explains what completed before offering Resume,
Retry, or Roll Back.

## State ownership

### Onboarding state

The versioned installation-scoped record distinguishes:

- not started;
- in progress at a resumable step;
- explicitly skipped;
- completed;
- superseded by a future onboarding version.

It stores navigation and non-sensitive staged UI choices. It does not store
imported setting values, extension lists, credentials, or telemetry identity.

### Migration operation state

Each admitted import has a durable identifier and records:

- source adapter and non-sensitive source fingerprint;
- target profile ID;
- reviewed-plan fingerprint;
- selected categories;
- snapshot locations;
- per-category status;
- extension outcomes;
- final or recoverable operation state.

Local diagnostics may include paths needed to recover the operation. Telemetry
must not contain usernames, filesystem paths, extension IDs, settings,
keybindings, or source contents.

## Architecture ownership

- Hucode common code owns normalized source, plan, operation, result, and
  onboarding-state contracts.
- Desktop Node or Electron code owns local source discovery and filesystem
  adapters.
- Pure planners own settings filtering, conflict decisions, extension
  classification, and deterministic fingerprints.
- A Hucode migration service owns explicit-target Apply, snapshots, progress,
  recovery, and results.
- Shared migration flow state and UI components serve both the command and
  onboarding hosts.
- A Hucode full-window contribution owns onboarding presentation and startup
  state. It does not add Hucode behavior to upstream onboarding files.
- `OmniHostPart` owns only its permanent active and empty hosted-workbench
  presentation.
- Existing project and workbench commands remain the authority for final and
  empty-state actions.

Existing `IUserDataProfileImportExportService` resources may provide parsers,
serializers, explicit-profile resource locations, and gallery integration. The
migration service must not call replacement behavior that overwrites whole
categories or uninstalls target extensions absent from the source.

## Accessibility and interaction

- Every step supports keyboard-only operation with visible focus and a stable
  tab order.
- Source selection, category selection, the compact toggle, progress, results,
  errors, and retry actions expose appropriate accessible names and states.
- The fake Projects preview is not interactive. Its changed density has a text
  label or status announcement that does not depend on visual comparison.
- Source and extension lists support filtering and remain usable with hundreds
  of entries.
- Detection completion, plan changes, progress, partial failure, and completion
  have screen-reader announcements.
- Narrow desktop windows, high-contrast themes, and reduced motion remain
  usable.
- Back preserves selections without repeating discovery. Closing before Apply
  leaves the target unchanged.

## Validation strategy

### Automated tests

- fixture-driven path and resource tests for each supported editor and operating
  system layout;
- named-profile schema validation, partial profiles, malformed files, locked
  resources, symlink deduplication, and deterministic source ranking;
- public list-layout value migration and legacy normalization;
- settings filtering, conflict preservation, keybinding merge behavior, and
  snippet collisions;
- every extension classification, target-platform compatibility, gallery
  changes, and additive install behavior;
- cancellation before Apply and at every supported safe boundary;
- snapshots, atomic file results, idempotent reruns, partial extension failure,
  rollback, retry, and crash recovery;
- installation-scoped onboarding state, Back, Skip, resume, completion,
  reopening, and version changes;
- target-profile selection and explicit workspace-profile association;
- full-window and empty-host view state transitions and command dispatch.

New behavioral tests must fail at their intended assertion before they count as
evidence. Test output must confirm that each new suite and case ran.

### Runtime evidence

- complete desktop migration from a source containing many settings,
  keybindings, snippets, and mixed-compatibility extensions;
- Start Fresh, Skip, Back, cancel, retry, rollback, crash-resume, rerun, and
  non-empty target paths;
- keyboard-only navigation;
- normal and narrow desktop windows;
- light, dark, high-contrast, and reduced-motion configurations;
- `default` and `compact` fake-list previews and real Projects rows;
- Add Project, Open Folder as Workbench, and target profile association;
- actionable empty-host behavior before the first workbench and after unloading
  the last workbench.

Run focused Node or Electron suites during each change. Before delivery, run the
relevant Hucode compile and type checks, desktop Omni smoke, changed-file
hygiene, and any broader repository validation justified by the affected
services.

## Delivery sequence

1. **Complete:** Add an actionable empty hosted-workbench view through PR #209.
2. **Complete:** Rename the public list layout values and migrate stored
   configuration through PR #207.
3. Add Visual Studio Code, Visual Studio Code Insiders, and Cursor discovery.
4. Add selective import planning and extension compatibility.
5. Add recoverable import application and result reporting.
6. Ship the complete migration flow through **Hucode: Import Setup from Another
   Editor...**.
7. Ship the full-window flow through **Hucode: Open Onboarding** without making
   it automatic.
8. Replace upstream first-launch routing and enable the Hucode experience for
   new installations.

The first two changes are normal user-visible improvements. Discovery, planning,
and Apply can land as tested internal services. The migration command is the
first complete migration milestone. The manually reopenable onboarding command
is the second complete user-visible milestone. Startup activation comes last so
it introduces no new migration behavior.

## Deferred work

- serve-web onboarding and migration;
- browser-owned to server-owned Hucode user-data migration;
- importing from desktop Hucode into serve-web Hucode;
- Windsurf, Kiro, Antigravity, VSCodium, Code OSS, Positron, Trae, and Void
  source adapters;
- user tasks, workspace history, recent projects, MCP configuration, accounts,
  authentication state, extension global state, and opaque state databases;
- importing several Hucode target profiles in one operation;
- clone, recent-repository, or project-creation actions in the empty host.
