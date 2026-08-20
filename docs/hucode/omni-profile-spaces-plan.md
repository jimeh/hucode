---
title: Omni Profile Spaces Implementation Plan
status: proposed implementation
last_updated: 2026-08-20
tracking_issue: https://github.com/jimeh/hucode/issues/191
---

# Omni Profile Spaces Implementation Plan

## Document purpose

This document turns the product decisions in
[issue #191](https://github.com/jimeh/hucode/issues/191) into an executable
implementation plan. It defines the target runtime model, persistence and
migration contracts, desktop and serve-web routing, user experience, delivery
slices, and the evidence required before profile-scoped Omni windows can ship.

The plan is repository-owned so implementation and review can work from a
stable contract. Once the feature lands and the durable behavior is reflected
in `omni.md` and `architecture.md`, move this plan to `docs/hucode/archive/`.

## Outcome

Every Omni window belongs to one existing regular Hucode profile for its full
lifetime. Its shell and every hosted workbench use that owner profile. Profiles
also partition Omni's machine-local projects and arbitrary-workbench catalog,
while loaded workbench state remains specific to an individual Omni window.

This makes profiles useful as complete Omni environments, such as Work,
Personal, Client, and Minimal, without introducing competing settings,
keybindings, extensions, or themes inside one native window.

## Scope

This plan covers:

- stable owner-profile selection, persistence, restoration, and display;
- inherited and explicitly selected profiles for new Omni windows;
- owner-profile enforcement for desktop and serve-web hosted workbenches;
- profile-scoped projects, retained workbenches, ordering, labels, pins, and
  Projects-sidebar preferences;
- per-window desktop and per-page serve-web lifecycle sessions;
- profile-bound project-manager IPC, HTTP, SSE, and hosted-shell capabilities;
- cross-window lookup and external file routing across profile boundaries;
- profile switching, rename, deletion, and missing-profile behavior;
- migration of current global and per-window state without silent loss; and
- focused automated and runtime validation on desktop and serve-web.

This plan does not cover:

- different profiles for a shell and one of its hosted workbenches;
- changing an existing Omni window's owner profile in place;
- temporary profiles;
- a dedicated hidden Omni profile;
- syncing project paths or Omni session state through Settings Sync;
- synchronizing transient theme-picker previews between renderers; or
- changing the shell's intentional extension filtering policy.

## Settled product contract

### Vocabulary

- **Owner profile**: the regular Hucode profile, identified by stable ID, that
  owns one Omni window.
- **Profile space**: the machine-local Omni catalog and profile-level UI state
  associated with one regular profile.
- **Omni session**: one native Omni window on desktop or one Omni shell page on
  serve-web. It owns active and resident workbench state.
- **Hosted workbench**: one VS Code workbench renderer hosted by an Omni
  session. It always uses its session's owner profile.

### Invariants

1. An Omni session resolves one existing, non-transient owner profile before
   its shell services are constructed.
2. The stable profile ID, not the display name, is the persisted identity.
3. The owner profile does not change during the session lifetime.
4. Every hosted workbench is configured with the owner profile explicitly.
5. Workspace-to-profile associations never override the owner profile in a
   hosted context.
6. Profile file changes and accepted settings changes continue to update live.
   Fixed identity does not mean a frozen settings snapshot.
7. Two sessions using one profile share the profile space but keep separate
   lifecycle state.
8. The same canonical path has at most one hosted owner within a profile. An
   existing session is focused instead of creating a duplicate. Different
   profiles may host the same path simultaneously.
9. Profile-space paths and session state are machine-local and never enter
   Settings Sync.

### State ownership

| State | Owner |
| --- | --- |
| Profile files: settings, keybindings, extensions, snippets, tasks, MCP, prompts, and appearance | Regular profile |
| Projects, worktree metadata preferences, pins, labels, order, and last-active worktree | Profile space |
| Arbitrary-workbench identity, label, and order | Profile space |
| Projects-sidebar presentation and collapse preferences | Profile |
| Active, resident, dormant, restore-pending, and crashed workbenches | Omni session |
| Native geometry, focus recency, and browser-page identity | Omni session |
| Git discovery, filesystem observation, and mutation serialization | Shared runtime keyed by canonical repository/path |

The current retained-workbench record combines catalog metadata with
`desiredState` and `lastActiveAt`. That shape cannot be shared safely between
windows. The implementation must split it into profile-level catalog metadata
and session-level lifecycle entries before multiple windows can share a
profile space.

## Current implementation findings

The implementation is already close to the owner-profile invariant but does
not represent it explicitly.

| Area | Current behavior | Required change |
| --- | --- | --- |
| Desktop shell profile | `omni.main.ts` constructs profile services from `configuration.profiles.profile`. | Resolve and persist an owner profile before shell startup. |
| Desktop hosted profile | `hostedWorkspacesController.ts` copies the shell window configuration. | Assert the copied current profile is the owner and refresh the available profile catalog for every hosted launch. |
| Omni configuration | `OmniConfigurationService` captures current profile resource paths at construction. | Keep identity fixed and prevent in-place switching so the captured paths cannot form a mixed profile. |
| Restore identity | `omniOpenPlan.ts` carries name-based `forceProfile`, but restorable Omni state has no profile ID. | Add a stable owner-profile ID to open plans and serialized window state. |
| Projects | One `ProjectManagerMainService` stores one global catalog under `hucode.projectManager.projects`. | Route each caller to a profile-scoped catalog while sharing Git runtime work. |
| Desktop retained workbenches | Catalog and lifecycle intent are stored together in each window configuration. | Move catalog metadata to the profile space and keep lifecycle entries in window state. |
| Serve-web retained workbenches | One profile-storage value combines retained catalog, resident entries, and active path. | Split the profile catalog from a browser-local session snapshot. |
| Projects view state | Omni uses workspace storage for view state. | Use profile scope for shared preferences and session scope only for genuinely window-specific UI state. |
| Cross-window lookup | Hosted paths are searched across every Omni window. | Qualify lookup by owner profile. |
| File routing | Plain file opens use the latest Omni window and one global project catalog. | Select a profile first, then route within its catalog and windows. |
| Serve-web profile selection | Browser startup prefers an explicit profile name, then a workspace association, then Default. | Add stable-ID selection and make hosted startup bypass associations. |
| Profile switching | Upstream profile actions call `switchProfile` in the current workbench. | Replace that behavior in Omni contexts with open-or-focus-another-Omni UX. |

The desktop main-process IPC client context is `window:<id>`. Hosted desktop
views inherit their owner window ID, which is useful here: a profile-routing
project-manager channel can resolve the trusted `ICodeWindow.profile` for both
the shell and its children without accepting a renderer-supplied profile ID.

## Target architecture

```text
regular profile: Work (stable profile ID)
│
├── profile space
│   ├── project catalog
│   ├── arbitrary-workbench catalog
│   └── Projects UI preferences
│
├── Omni session A
│   ├── active and resident entries
│   └── hosted workbenches, all using Work
│
└── Omni session B
    ├── separate active and resident entries
    └── hosted workbenches, all using Work

regular profile: Personal (different stable profile ID)
│
├── separate profile space
└── Omni session C, whose hosted workbenches all use Personal

shared Git runtime
└── deduplicated discovery, watchers, caches, and repository mutations
    keyed by canonical path rather than profile
```

### Owner-profile descriptor

Add a small Hucode-owned descriptor in `src/vs/hucode/common/`:

```ts
interface IHucodeOmniProfileOwner {
	readonly profileId: string;
}
```

The ID is authoritative. Name and icon are resolved from the live profile
catalog for display and may change without rewriting every session record.

Carry `profileId` through:

- `IHucodeOmniWindowPath` and its restore key;
- Hucode Omni browser-window options;
- `INativeWindowConfiguration` for an Omni shell;
- desktop serialized window state;
- each `ResidentHostedWorkspacesController`;
- trusted serve-web shell configuration;
- hosted iframe startup and the established parent/child handshake; and
- shell state exposed for profile badges, pickers, and smoke tests.

Do not extend name-based `forceProfile` as the internal identity. Resolve the
existing profile by ID in the main process or web profile service, fail closed
for unknown IDs during explicit opens, and never create a profile from a stale
restore name.

### Profile-space registry

Introduce a Hucode-owned profile-space registry on desktop and serve-web. It
maps stable profile IDs to lazily loaded profile-space services and owns:

- a profile-scoped project-manager facade;
- the retained arbitrary-workbench catalog;
- catalog revision and persistence;
- migrations and orphan recovery; and
- cross-window/session catalog change events.

The existing `ProjectManagerMainService` currently mixes profile metadata,
Git discovery, filesystem watches, refresh retry state, and mutations. Refactor
it behind two responsibilities rather than cloning the entire service for each
profile:

1. **Profile catalog state** owns saved projects, labels, pins, ordering,
   last-active paths, and profile-specific events.
2. **Shared Git runtime** owns canonical-path discovery, watchers, caches,
   refresh work, and repository mutations.

The first implementation may use one project-manager facade per profile, but
all facades must receive the same shared Git runtime. Repository mutations must
be serialized by canonical repository identity across profiles so two profile
spaces cannot race worktree creation or removal. Watch ownership must be
reference-counted by canonical path and consumer, not duplicated per profile.

### Retained catalog and session lifecycle split

Replace the current combined retained record with two concepts:

```ts
interface IOmniProfileWorkbenchRecord {
	readonly id: string;
	readonly folderUri: UriComponents;
	readonly label?: string;
	readonly order: number;
}

interface IOmniSessionWorkbenchEntry {
	readonly worktreePath: string;
	readonly projectId?: string;
	readonly retainedWorkbenchId?: string;
	readonly lastActiveAt?: number;
}
```

The exact names may follow nearby conventions, but the ownership split is
required:

- retain, rename, reorder, and dismiss mutate the profile catalog;
- activate, suspend, unload, crash, and restore mutate one session;
- unloading removes the session entry but leaves the catalog record;
- suspending keeps a desired-loaded session entry without a live renderer;
- dismissing removes the shared catalog record only after no same-profile
  session owns it, or after the user confirms closing it everywhere; and
- promotion of a retained path to a project worktree atomically replaces the
  catalog identity and rewrites affected session references without reloading
  healthy workbenches.

The profile-space coordinator enforces one hosted owner for each
`(profileId, canonicalPath)`. Cross-window focus remains the normal behavior
inside one profile. The profile ID is part of the key, so another profile may
host the same path independently.

## Desktop design

### Opening and restoring an Omni window

Resolve the owner in this order:

1. an explicit existing profile ID from **New Omni Window with Profile...**;
2. the invoking window's current profile ID;
3. the configured new-window/startup profile, if it resolves to an existing
   regular profile; and
4. Default.

`New Omni Window` must use the invoking `sourceWindowId`, not whichever window
happens to be last active when the asynchronous open reaches the main process.
Persist the resolved ID immediately in the Omni open path and browser-window
configuration.

On restore, resolve the stored ID against the current profile catalog. A
profile rename requires no special handling. If the profile is missing, open
the session with Default, retain the missing profile space as an orphan, and
show one recovery notification offering to merge or discard the orphaned
catalog. Do not recreate a deleted profile silently.

Include the owner profile ID in the Omni restore de-duplication key. Two
otherwise identical sessions owned by different profiles are distinct.

### Hosted workbench configuration

`createHostedConfiguration()` must build from the owner window but explicitly
replace its profile fields with:

- the current live profile object whose ID matches the controller owner;
- a fresh `profiles.all` snapshot; and
- the fixed owner-profile ID used by Hucode services.

Ignore the hosted folder's normal workspace-to-profile association. Assert the
resolved profile ID before creating the hosted view and fail with a visible,
recoverable error if the owner disappeared during startup.

Standalone reopen is different: **Open in New Window** preserves the owner
profile for that one open, then the resulting standalone window resumes normal
VS Code profile behavior.

### Project-manager IPC

Replace the generic `ProxyChannel.fromService` registration for
`projectManager` with a Hucode channel that resolves the caller's profile:

1. parse and validate the existing `window:<id>` IPC context;
2. resolve the live `ICodeWindow`;
3. use the controller-bound owner ID for an Omni shell or hosted child;
4. otherwise use the regular window's current profile; and
5. route the call or event to that profile's project-manager facade.

Resolve the profile for every call. Event subscriptions must filter the
registry's profile-tagged change stream against the window's current profile,
so a normal standalone window that switches profile does not retain an event
subscription to its previous catalog. Hosted callers never supply profile IDs.

`HucodeShellMainService` and hosted-shell navigation snapshots must request the
controller's profile facade explicitly rather than reaching for a global
project-manager service.

### Window state

Desktop serialized Omni state should contain:

- owner profile ID;
- active path;
- session workbench entries for projects and retained workbenches;
- native window UI state; and
- a schema version for Hucode session migration.

It should no longer contain the shared retained catalog after migration.
Continue reading the legacy field until the migration has committed, then
leave it untouched as rollback evidence for at least one release series.

## Serve-web design

### Owner selection and page identity

Add stable-ID profile selection to the Omni shell URL and injected Hucode web
configuration. A requested ID is an intentional user selection, not proof of a
privileged caller, so the workbench must resolve it only against the loaded
profile catalog and must not create an unknown profile.

Each shell page also needs a stable `omniSessionId`:

- reload of the same page keeps the ID;
- a new page receives a new ID;
- a duplicated tab that detects an active ID collision mints a replacement;
- a root open with no ID may reclaim the most recently closed session for the
  selected profile; and
- session IDs are included in the URL with `history.replaceState` so browser
  reload and session restoration preserve identity.

Coordinate live claims with a same-origin `BroadcastChannel`, with a
`localStorage` event fallback. This identity is for correct state ownership,
not authentication.

### Hosted profile enforcement

The shell includes its owner profile ID and session ID when it constructs a
hosted iframe URL. `BrowserMain` resolves the profile by ID before considering
workspace associations. An unknown ID fails visibly; it never creates a named
profile and never falls back to an associated profile.

The iframe URL is caller-controlled, so it is not sufficient by itself. Add
the owner profile ID to the existing same-origin `MessagePort` bootstrap. The
shell sends the profile bound to its session, and the child accepts the
connection only when its current profile matches. A forged or stale hosted URL
may render an error, but it cannot integrate with an Omni shell under another
profile.

### Server project APIs

Namespace the project HTTP and SSE APIs by a validated stable profile ID. The
server owns one profile-space facade per ID and publishes only that facade's
events to its SSE clients. Git observation remains shared by canonical path.

For shell and hosted calls, derive the profile from the shell session/handshake
where the transport permits it. Where an HTTP request must carry the ID, treat
it as a routing key within Hucode's existing single-user serve-web model,
validate it strictly, and verify that hosted-shell state still matches the
connected parent profile before applying navigation state.

Keep the current request-admission, cancellation, write-generation, response
lease, and shutdown-drain guarantees independently for every profile facade.
Splitting catalogs must not reintroduce unjoined reads or mutations during
server shutdown.

### Web persistence

Serve-web profile-space catalogs are server-machine data and should live under
the existing Hucode server data root, for example:

```text
<server-data-dir>/hucode/profile-spaces/<validated-profile-id>.json
```

Use atomic replacement, generation tracking, dirty-write retry, corrupt-file
preservation, and shutdown flushing equivalent to the current
`HucodeProjectFileStateService`. Keep one legacy `projects.json` reader for
migration.

Omni session snapshots are browser-window state. Store them in browser-local
origin storage keyed by `(profileId, omniSessionId)`, even when profile files
and normal workbench state use server-authoritative user-data storage. They do
not roam to another browser or device. Store the profile catalog and session
snapshot under separate keys so one tab cannot overwrite another tab's
resident set.

## User experience

### Profile indicator and window actions

Show the owner profile in the existing profile menu and make the ownership
clear without permanently consuming title-bar space. The menu should contain:

- the current owner profile with a check mark;
- **New Omni Window** using the current owner;
- **New Omni Window with Profile...** using an existing-profile picker; and
- **Manage Profiles** using the normal profile editor.

The picker should show profile name, icon, and the count of currently open Omni
sessions. Selecting a profile always opens a new session unless the user chose
an explicit focus-existing affordance. Multiple sessions for one profile remain
allowed.

### Profile switching

Do not hot-switch the current Omni session. In the shell or a hosted workbench,
the normal switch-profile action should:

1. explain that the profile applies to the entire Omni window;
2. offer the existing profiles;
3. focus an existing Omni window with the selection or open a new one; and
4. when invoked from a hosted workbench, optionally open the current folder in
   the destination profile after clear confirmation.

The last option may create a catalog entry in another profile, so it must be an
explicit user action rather than an automatic side effect of selecting a
profile.

Implement the behavior through a Hucode profile-management service or narrow
action adapter that delegates unchanged outside Omni contexts. Avoid copying
the upstream profile action catalog into Hucode.

### Theme and extensions

The shell and children use the same persisted profile theme, but they remain
separate renderer theme-service instances. Accepted theme changes should
converge through normal profile configuration updates. Transient picker preview
may remain local in the first implementation.

The Omni shell continues to filter extensions according to its role while
hosted workbenches run the profile's normal enabled extensions. That is a
surface policy, not a profile mismatch. Profile spaces must not remove the
shell filter or start arbitrary profile extensions in the shell renderer.

### Profile deletion

Profile deletion needs a Hucode preflight because the upstream
`onWillRemoveProfile` join mechanism cannot veto removal reliably.

Before removing a non-default profile:

1. find open Omni sessions using the profile;
2. find its project and retained-workbench catalog;
3. require all owning sessions to close;
4. offer **Move to Default**, **Discard Omni Catalog**, or **Cancel** when the
   catalog is non-empty; and
5. commit the selected catalog action before deleting profile files.

Enforce the preflight in the desktop main profile service and the serve-web
profile service, not only in one menu action. A direct or stale removal request
must fail with a typed error while sessions remain open or catalog disposition
is unresolved.

Moving to Default merges by canonical path. Existing Default entries keep
their stable identity and manual position; unique moved entries append in
source order. Conflicting labels require a small review prompt rather than a
silent winner. Project IDs that collide but refer to different roots are
regenerated during the merge.

## External file and folder routing

Select a destination profile before selecting an Omni window:

1. explicit CLI or API profile;
2. profile of the invoking window;
3. the only profile space whose project/workbench catalog contains all target
   paths;
4. the latest active Omni window for the configured/default profile; and
5. normal standalone behavior when the profile remains ambiguous.

Once a profile is selected, search and focus hosted workbenches only within
that profile. A matching workbench in another profile is not an existing host
for this request.

For a unique catalog match with no open Omni session, open a new Omni window
owned by that profile. If multiple profiles contain the target and there is no
explicit or invoking profile, do not guess. Fall back to a standalone window
and preserve normal VS Code profile-association behavior.

## Persistence and migration

### New storage

Use new versioned Hucode storage keys/files rather than rewriting the current
global project value in place. This leaves rollback evidence and makes retry
idempotent.

Each profile-space envelope should include:

- format version;
- stable profile ID;
- monotonically increasing revision;
- project catalog state;
- retained-workbench catalog state; and
- migration source and completion marker.

Desktop can store envelopes through `IStateService`; serve-web uses one atomic
file per validated profile ID. Session snapshots have their own version and
storage location.

### Migration algorithm

Run migration before any profile-space mutation is admitted:

1. Load and validate all legacy sources without modifying them.
2. Resolve every restorable desktop Omni window's profile from a recoverable
   empty-window/backup association where possible, otherwise Default.
3. Move the current global project catalog to Default only.
4. Group legacy retained workbench records by each window's resolved profile.
5. Merge retained records by canonical folder URI. Process persisted window
   order deterministically and let the recorded last-active window supply the
   final conflicting label and recency value.
6. Convert each legacy retained `desiredState: loaded` record into a session
   entry for that original window. Keep unloaded entries only in the profile
   catalog.
7. Preserve project resident entries and the active path in their original
   session.
8. If two restored sessions in one profile claim the same canonical path, keep
   the last-active session as host and remove only the duplicate session claim.
   The shared catalog entry remains.
9. Migrate current Omni workspace-scoped sidebar preferences to Default.
10. Write and validate all new envelopes and session snapshots.
11. Write one completion marker only after every required write succeeds.
12. Keep legacy keys/files unchanged for at least one release series.

On serve-web, migrate the global `projects.json` to Default. Split the current
combined `hucode.omni.webRetainedWorkbenches` value when a shell first opens:
retained metadata enters that owner profile's catalog, while active/resident
state enters the selected browser session. Mark the legacy value as consumed
only after both writes succeed.

Migration must be safe to retry after interruption. It must not duplicate
catalog entries, regenerate stable IDs on each attempt, or discard a corrupt
source. Preserve malformed server files using the current `.corrupt` behavior
and surface a recovery warning.

## Delivery sequence

Deliver this work on a dedicated integration branch based on the active VS Code
series. Slice PRs target that branch; only the final integration PR targets the
release series. This avoids shipping a visible profile picker while catalogs or
serve-web still use global state.

### Slice 1: Owner identity and characterization

Outcome: every existing Omni session has an explicit, fixed owner profile with
no new user-facing multi-profile action yet.

- Add common owner-profile types and selection helpers.
- Persist the stable ID in desktop open plans and window state.
- Bind controllers and hosted configurations to the owner.
- Add stable-ID selection to serve-web `BrowserMain` and hosted bootstrap.
- Characterize current profile inheritance, restore, association override,
  and missing-profile behavior with focused tests.
- Expose owner ID/name to the smoke driver for later runtime assertions.

Gate: desktop and serve-web hosted workbenches report the same profile ID as
their shell, including a folder associated with another profile.

### Slice 2: Profile-space storage and shared Git runtime

Outcome: profile-scoped project and retained catalogs exist behind internal
facades, while legacy reads remain available for migration.

- Extract or introduce the shared canonical-path Git runtime.
- Add desktop and web profile-space registries and versioned persistence.
- Add retained catalog/session schemas and pure migration helpers.
- Add cross-profile mutation serialization and watcher reference counting.
- Keep the existing service contract usable through one Default facade while
  routing work is incomplete.

Gate: two isolated profile facades can contain the same path with independent
labels/order while sharing one Git observation and mutation lock.

### Slice 3: Trusted project routing and session ownership

Outcome: every project/catalog operation and lifecycle snapshot resolves
against the correct profile and session.

- Replace desktop's generic project-manager channel with window-context
  routing.
- Route `HucodeShellMainService` and hosted capabilities through the controller
  owner.
- Namespace serve-web HTTP, SSE, state files, and monitor consumers.
- Split desktop window and browser-page lifecycle persistence from catalogs.
- Reconcile shared retained mutations across same-profile sessions.
- Qualify cross-window host lookup by profile ID.

Gate: the same path can be active once in Work and once in Personal, while two
Work windows share catalog changes but never overwrite one another's resident
state.

### Slice 4: User actions and routing

Outcome: users can create and navigate profile-owned Omni windows without any
in-place profile switch.

- Add **New Omni Window with Profile...** and source-window inheritance.
- Adapt profile switching in shell and hosted contexts.
- Add owner-profile indication and existing-session counts.
- Implement profile-aware standalone reopen and external file routing.
- Move Projects view preferences to the intended profile/session scopes.
- Add browser session identity, collision handling, and root-session reclaim.

Gate: command-driven, menu-driven, restored, and external-file opens all select
the expected profile and never cross-focus another profile's hosted path.

### Slice 5: Migration, deletion, and recovery

Outcome: upgrades and profile lifecycle operations cannot silently lose Omni
state.

- Enable the idempotent desktop and serve-web migrations.
- Add missing-profile and orphan-catalog recovery.
- Add deletion preflight, close coordination, move/merge, and discard flows.
- Exercise interruption and failed-write recovery.
- Update `omni.md`, `architecture.md`, and relevant agent instructions with
  durable behavior and any discovered pitfalls.

Gate: repeated migration produces byte-equivalent logical state, legacy data
remains recoverable, and profile deletion cannot bypass catalog disposition or
open-window checks.

### Slice 6: Runtime proof and integration

Outcome: one reviewable integration diff is ready for the active series.

- Run the full focused suites and Hucode validation.
- Run desktop and serve-web smoke scenarios with two real profiles.
- Verify accepted theme changes converge while preview remains local.
- Verify the shell extension filter and hosted extension profile remain intact.
- Perform independent code review of the integration diff.
- Update the tracking issue and archive this plan only after delivery lands.

## Testing strategy

### Pure and service tests

Add or extend focused tests for:

- owner selection by explicit ID, source window, startup setting, and Default;
- rename-safe restore and missing/deleted owner fallback;
- Omni restore de-duplication including profile ID;
- hosted configuration overriding conflicting workspace associations;
- project and retained catalogs isolated by profile;
- session state isolated by window/page;
- retained catalog migration and session-entry conversion;
- deterministic merge, duplicate paths, corrupt state, interrupted writes, and
  idempotent retry;
- shared watcher reference counts and cross-profile mutation serialization;
- desktop IPC calls and events routed from `window:<id>`;
- web HTTP/SSE isolation, reconnect, request cancellation, write generations,
  and shutdown draining for multiple profiles;
- same path hosted in two profiles and de-duplicated within one profile;
- profile-aware cross-window focus and external file routing;
- switch-profile actions in shell, hosted, and normal workbench contexts;
- browser session collision and reclaim behavior; and
- deletion refusal, merge, discard, and orphan recovery.

Likely existing suites to extend include:

- `src/vs/hucode/test/electron-main/omniOpenPlan.test.ts`
- `src/vs/platform/windows/test/electron-main/hucodeWindowsStateHandler.test.ts`
- `src/vs/hucode/test/electron-main/hostedWorkspacesController.test.ts`
- `src/vs/hucode/test/electron-main/shellControllerMainService.test.ts`
- `src/vs/hucode/test/electron-main/hostedShellMainService.test.ts`
- `src/vs/hucode/test/electron-main/omniFileOpen.test.ts`
- `src/vs/platform/projectManager/test/common/projectManagerState.test.ts`
- `src/vs/platform/projectManager/test/electron-main/projectManagerMainService.test.ts`
- `src/vs/server/test/node/hucodeWebProjectManagerServer.test.ts`
- `src/vs/hucode/test/browser/webShellService.test.ts`
- `src/vs/hucode/test/browser/projectManager/webProjectManagerService.test.ts`
- `src/vs/hucode/test/browser/projectSwitcher/projectSwitcherContribution.test.ts`
- `src/vs/platform/environment/test/common/hucodeWebConfiguration.test.ts`
- relevant upstream profile service and action tests

For material new tests, observe the intended assertion fail before the
implementation makes it pass. Confirm the focused runner reports the new test
by name or count.

### Runtime scenarios

Desktop smoke:

1. Create Work and Personal profiles with visibly different settings,
   keybindings, theme, and extension enablement.
2. Open one Omni window for each profile.
3. Add the same repository to both catalogs with different labels/order.
4. Host the same worktree simultaneously in both profiles.
5. Confirm shell and child profile IDs match, keybindings resolve consistently,
   and accepted theme changes converge inside each window.
6. Open a second Work Omni window and confirm catalog sharing with separate
   resident state.
7. Restart Hucode and verify owner and session restoration.

Serve-web smoke repeats the same model in separate shell pages, including a
duplicated-tab session collision, SSE isolation, reload, and a hosted folder
with a conflicting workspace association.

Profile lifecycle smoke renames an owner profile while open, then exercises
deletion refusal, close-and-merge to Default, and missing-profile restore from
a copied state fixture.

### Validation commands

Use the repository-generated suite snapshot and current task graph. At minimum:

- regenerate the Hucode suite snapshot when new suites are added;
- run focused Node or Electron suites after compiling the changed sources;
- run focused serve-web server and browser suites;
- run `npm run hucode:compile` and `npm run hucode:validate`;
- run desktop and serve-web smoke through the repository launch workflows; and
- run `npm run -s precommit -- <changed-paths>` before handoff.

Do not run Electron suites concurrently with `gulp compile-client`, and do not
run multiple `scripts/test.sh` processes against the shared Electron build.

## Acceptance checklist

- [ ] Every desktop and serve-web Omni session has one stable owner profile ID.
- [ ] Every hosted workbench uses the owner profile before workspace
      associations are considered.
- [ ] Profile identity cannot change in place in an Omni shell or child.
- [ ] New windows inherit the invoking profile or use an explicit existing ID.
- [ ] Restored windows survive profile rename and handle a missing profile
      visibly.
- [ ] Projects and retained workbench catalogs are profile-scoped.
- [ ] Active and resident lifecycle state is session-scoped.
- [ ] Same-profile windows share catalogs without overwriting session state.
- [ ] The same path may be hosted independently by different profiles.
- [ ] Same-profile path lookup preserves one hosted owner and focuses it.
- [ ] Git watchers, discovery, and mutations are shared safely across profiles.
- [ ] Desktop IPC and web HTTP/SSE route every operation to the correct profile.
- [ ] External file routing and standalone reopen preserve profile intent.
- [ ] Profile switching opens or focuses another Omni session instead of
      hot-switching.
- [ ] Profile deletion cannot lose an open or unresolved Omni catalog.
- [ ] Migration is deterministic, idempotent, interruption-safe, and leaves
      legacy recovery data.
- [ ] Desktop and serve-web runtime evidence covers two real profiles.
- [ ] Current Hucode compile, validation, generated-suite, and hygiene checks
      pass.

## Risks and controls

| Risk | Control |
| --- | --- |
| Shared catalog writes overwrite another window's lifecycle intent | Separate profile catalog records from session entries before enabling shared catalogs. |
| Renderer chooses another catalog | Bind desktop calls to trusted window context and verify web hosted profile during the existing parent/child handshake. |
| Per-profile services duplicate expensive Git work | Share canonical-path runtime, watchers, caches, and mutation locks. |
| Migration partially commits | Write new versioned storage, validate it, then write one completion marker; leave legacy data intact. |
| Profile deletion bypasses one UI | Enforce preflight in desktop main and web profile services with typed failures. |
| Upstream VS Code upgrades conflict broadly | Keep types, registries, routing, and UX adapters under `src/vs/hucode/`; keep necessary upstream seams thin. |
| Multiple web tabs claim one session | Use stable page IDs plus cross-tab live claims and collision replacement. |
| Theme or extension behavior appears inconsistent | Distinguish transient preview and shell role filtering from persisted owner-profile behavior in UX and tests. |

## Implementation questions to settle in Slice 1

No product decision currently blocks implementation. Slice 1 should confirm
two low-level choices against focused prototypes before later schemas depend on
them:

1. whether the desktop owner ID belongs directly on
   `INativeWindowConfiguration` or in a nested Hucode Omni configuration
   object; and
2. whether the existing browser profile catalog can resolve stable IDs early
   enough in `BrowserMain`, or needs a small Hucode pre-initialization hook.

Either choice must preserve the contracts in this plan. They do not change the
user model or persistence ownership.
