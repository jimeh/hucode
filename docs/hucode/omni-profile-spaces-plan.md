---
title: Omni Sessions, Workbench Ownership, and Appearance Projection Plan
status: proposed implementation
last_updated: 2026-08-21
tracking_issue: https://github.com/jimeh/hucode/issues/191
supersedes: Omni Profile Spaces Implementation Plan
---

# Omni Sessions, Workbench Ownership, and Appearance Projection Plan

## Document purpose

This document replaces the earlier profile-space plan for
[issue #191](https://github.com/jimeh/hucode/issues/191). Runtime testing showed
that VS Code workbenches can switch profiles in place, while Hucode's projects
catalog is already global. Those facts make an Omni-window owner profile the
wrong product boundary.

The revised plan keeps Omni windows useful as independent workbench sessions,
allows each hosted workbench to use any regular profile, prevents the same path
from being live in more than one window, and makes the Omni shell visually
follow the active hosted workbench.

Once the implementation lands and its durable contracts are reflected in
`omni.md` and `architecture.md`, move this plan to `docs/hucode/archive/`.

## Outcome

An Omni window is an independent session over one global projects catalog. It
owns its active, resident, dormant, and restored workbench entries, but it does
not own a profile space. Each hosted workbench uses the ordinary VS Code profile
associated with its workspace and may switch profiles through upstream profile
management.

Across one running Hucode desktop application, a canonical folder or workspace
path has at most one live workbench owner. Opening an already-owned path focuses
the owning regular window or Omni window and, for an Omni owner, activates the
relevant hosted workbench.

The Omni shell retains a stable internal profile for its own services. That
profile is not user-facing and does not determine project visibility or hosted
workbench profiles. The shell projects the active hosted workbench's resolved
color theme and Modern UI presentation so the whole native window reads as one
coherent interface.

## Scope

This plan covers:

- one global projects catalog shared by profiles and Omni windows;
- independent per-window Omni session and retained-workbench state;
- race-safe live path ownership across regular and Omni windows;
- focus-or-open routing for every folder and workspace ingress;
- deterministic restoration when multiple sessions claim the same path;
- ordinary, independently switchable profiles in hosted workbenches;
- a fixed internal shell profile with no profile-specific Omni-window action;
- active-workbench color-theme and Modern UI projection into the shell;
- desktop and serve-web ownership scopes and behavior;
- disposition of the implementation in PR #193; and
- staged delivery, focused tests, and runtime acceptance evidence.

This plan does not cover:

- profile-scoped project catalogs;
- switching the Omni shell's internal profile in place;
- a user-visible dedicated Omni profile;
- synchronizing Omni session state through Settings Sync;
- copying a hosted workbench's settings into the shell;
- redesigning the first-launch onboarding flow tracked by issue #192;
- projecting zoom level, display language, product icon theme, or file icon
  theme in the first implementation; or
- globally excluding the same path across different machines, browser
  profiles, or Hucode application processes.

## Settled product contract

### Vocabulary

- **Project catalog**: the application-level list of configured projects and
  their discovered worktrees. It is global and profile-independent.
- **Omni session**: one native Omni window on desktop or one Omni shell page on
  serve-web. It owns workbench lifecycle and presentation state for that host.
- **Hosted workbench**: one VS Code workbench renderer hosted by an Omni
  session. It uses an ordinary VS Code profile associated with its workspace.
- **Regular workbench**: a standalone VS Code window outside an Omni session.
- **Live owner**: the regular window or hosted workbench that currently owns a
  canonical folder or workspace path.
- **Ownership reservation**: a short-lived claim held while a workbench is
  being created, restored, transferred, or recovered.
- **Shell profile**: the stable internal profile used to bootstrap the Omni
  shell's own workbench services. It is an implementation detail.
- **Appearance snapshot**: the resolved active color scheme, registered theme
  colors, and Modern UI flags published by a hosted workbench to its shell.

### Invariants

1. The project catalog is global. Profiles do not filter or partition it.
2. Omni sessions are independent. Switching or closing one session does not
   rewrite another session's lifecycle intent.
3. A canonical path has at most one live owner within the applicable ownership
   scope.
4. Every open request goes through one ownership decision before creating or
   restoring a workbench.
5. An already-owned path is focused and activated; it is not opened again.
6. Explicit standalone reopen is an ownership transfer, not a duplicate open.
7. Hosted workbench profiles are ordinary VS Code profiles and may differ
   within one Omni session.
8. Changing a hosted workbench profile does not change the shell profile or
   any other hosted workbench.
9. The shell profile does not determine catalog contents or live ownership.
10. The shell projects appearance without persisting the projected values as
    shell settings.
11. Appearance authority follows the last active hosted workbench, including
    while focus temporarily moves into shell-owned UI.
12. Trusted shell/child identity and capability checks remain generation-bound;
    profile equality is not an authority check.

### State ownership

| State | Authority | Notes |
| --- | --- | --- |
| Project definitions and discovered worktrees | Application project manager | One global catalog and shared Git runtime. |
| Project ordering, labels, and pins | Global project catalog | Not duplicated by profile. |
| Active hosted workbench | Omni session | Exactly one active instance per session. |
| Resident, dormant, crashed, and restore-pending entries | Omni session | Subject to global live ownership admission. |
| Retained arbitrary workbench records | Omni session | May exist unloaded in more than one session; only one may be live. |
| Workbench profile association | Upstream profile service | The usual workspace-to-profile association remains authoritative. |
| Live canonical-path owner and reservations | Desktop main process | Cross-window, race-safe authority. |
| Omni window geometry and window restoration | Desktop window services | Independent of profile. |
| Sidebar selection, expansion, and view state | Omni session | Multiple Omni windows may present the same catalog differently. |
| Shell implementation settings | Shell profile | Internal bootstrap concern, not product identity. |
| Active shell colors and Modern UI presentation | Appearance projection | Ephemeral snapshot from the active hosted workbench. |

## Current implementation findings

The implementation already contains most of the pieces needed for the revised
model, but their authority is inconsistent:

- `ProjectManagerMainService` is registered once in the desktop main process,
  and `hucode.projectManager.projects` is application-scoped storage. The
  projects catalog is therefore global today.
- `HucodeShellMainService` can scan every Omni window for a restorable hosted
  workbench by path, activate it, focus the owning window, and distinguish
  regular windows from Omni windows.
- `prepareWorkspaceForStandaloneOpen()` already closes a hosted owner before a
  path opens in a regular window.
- Some UI actions call the cross-window lookup before opening, while other
  project, Quick Pick, restore, and shell-service paths call a controller
  directly. Those bypasses allow duplicate hosted workbenches.
- The lookup is a best-effort scan. It does not reserve the path, so concurrent
  open or restore requests may both observe no owner and create duplicates.
- Hosted workbench state already distinguishes loading, active, loaded,
  dormant, crashed, unloaded, and missing entries. The new coordinator can
  reuse those lifecycle concepts.
- Upstream profile switching replaces the current profile services and updates
  workspace association without requiring a new window. Hucode should retain
  that behavior inside hosted workbenches.
- Theme and Modern UI services already emit the changes needed to build an
  appearance snapshot. Applying that snapshot to the shell requires an
  explicit projection layer because the shell and child are separate
  renderers.

The architectural gap is therefore not a new catalog or new profile type. It
is a single admission authority for live paths plus a presentation bridge from
the active hosted workbench.

## Target architecture

### Global project catalog

Keep the existing main-process project manager and application storage as the
single project authority. Do not add a profile ID to project records, project
mutations, Git watchers, HTTP routes, SSE snapshots, or hosted-shell project
capabilities.

Project changes continue to broadcast to every Omni session. A session may keep
its own tree expansion, active row, workbench lifecycle, and retained arbitrary
folders without forking the catalog itself.

### Desktop live ownership coordinator

Add one main-process coordinator owned by `HucodeShellMainService`, or by a
small service it instantiates. It is the sole authority for admitting live
folder and workspace paths across all desktop windows.

The coordinator keys records by canonical path using the existing platform
case semantics. Each record contains enough identity to validate stale calls:

- canonical path and display path;
- owner kind: regular window or hosted workbench;
- native window ID;
- hosted instance ID when applicable;
- ownership generation;
- lifecycle phase: reserved, live, recovering, or transferring; and
- timestamps used for diagnostics and deterministic recovery.

Do not treat periodic scans of window state as the authority. Existing scan
helpers are useful for initial reconciliation and stale-record repair, while
all new admissions and releases update the registry directly.

### Focus-or-open flow

Every open request follows the same serialized decision for its canonical path:

```text
open request
    |
    v
canonicalize and enter per-path admission
    |
    +-- regular owner ----------> focus regular window
    |
    +-- hosted owner -----------> activate instance, focus Omni window
    |
    +-- reservation/recovery ---> join or await the in-flight decision
    |
    +-- no owner ---------------> reserve for requester
                                      |
                                      +-- create/restore succeeds -> live owner
                                      |
                                      +-- fails/cancels ----------> release reservation
```

The result should be typed rather than boolean so callers can distinguish
focused, opened, transferred, superseded, and failed outcomes without guessing
whether a renderer was created.

The coordinator must serialize only decisions for the same canonical path.
Opening unrelated projects remains concurrent.

### Ownership lifecycle

Ownership includes restore-pending, loading, active, loaded, and dormant hosted
entries. A dormant entry still owns its path because selecting it restores the
same logical workbench.

A crashed entry retains ownership while automatic recovery is pending. It
releases ownership only when the session abandons recovery, the entry becomes
unloaded or missing, or the containing window closes. A generation check must
prevent a late close or crash event from releasing a replacement owner.

Normal unload, explicit close, unrecoverable creation failure, and window
destruction release ownership. Controller and window shutdown must reconcile
the registry even when renderer callbacks never arrive.

### Concurrent restore

Startup may discover the same persisted path in more than one Omni session.
Restore performs admission before creating a renderer. Exactly one claimant
wins; losers keep no live instance.

Use this deterministic order:

1. an entry persisted as active before a merely resident or dormant entry;
2. newer entry activity time;
3. newer containing-window focus time; and
4. stable native window and instance IDs as a final tie-breaker.

If the losing entry represents a global project worktree, discard only its
session lifecycle claim. If it is a retained arbitrary workbench, keep the
unloaded retained record so the user does not lose it; selecting that record
later focuses the current owner.

### Standalone transfer

Opening a hosted path in a regular window is an explicit transfer:

1. mark the ownership record as transferring;
2. prepare and unload the hosted workbench;
3. verify the old generation is gone;
4. reserve the path for the regular window;
5. open the regular window; and
6. publish or release the new owner according to the result.

The inverse transition uses the same admission path. If a regular window owns
the path, an ordinary project click focuses it. A future explicit "Move into
Omni" action may request a transfer, but it is not part of this plan.

### Open ingress inventory

Route all of these through the ownership coordinator:

- project and worktree rows in the Projects sidebar;
- retained arbitrary workbench rows;
- Add Workbench;
- project/worktree Quick Picks and commands;
- Open Folder and Open Workspace requests handled by an Omni shell;
- external file and folder routing;
- hosted navigation between worktrees;
- session restoration and crash recovery;
- smoke-driver and test-only open helpers; and
- any desktop IPC facade exposed to hosted workbenches.

No renderer or controller API that creates a hosted workbench should remain a
public bypass. Controller-local methods may assume admission only when their
name and type make that precondition explicit.

### Cross-window state and UI

Publish ownership changes to all Omni sessions. The Projects sidebar should
distinguish these states without turning ownership into a new catalog:

- active in this Omni window;
- loaded in this Omni window;
- open in another Omni window; and
- open in a regular window.

Activating an item owned elsewhere focuses that owner. The initial UI may use a
small icon and hover text; it does not need a permanent owner column or window
picker.

## Hosted workbench profiles

### Profile authority

Remove the invariant that a hosted workbench profile must equal an Omni owner
profile. Hosted workbenches use upstream workspace profile association exactly
as standalone workbenches do.

When a hosted workbench switches profile:

- upstream profile services update settings, keybindings, snippets, storage,
  extensions, and workspace association;
- its renderer and extension host restart or reconfigure through the existing
  profile workflow;
- its Omni connection remains bound to the same window and hosted instance
  generation;
- the shell and sibling hosted workbenches keep their current profiles; and
- the workbench republishes its appearance after profile services settle.

Global live ownership makes upstream's global workspace-to-profile association
safe: the same workspace cannot be live in two workbenches with competing
profiles within one application process.

### Shell profile

Launch each Omni shell with one stable internal profile. Prefer the existing
default-profile bootstrap unless runtime characterization shows a separate
internal profile is required to keep shell-only settings isolated.

The shell profile has deliberately narrow authority:

- bootstrap workbench services needed by the shell;
- store shell implementation settings that cannot yet move to explicit Omni
  session or application storage; and
- provide fallback appearance before any hosted workbench is active.

It must not scope projects, choose hosted workbench profiles, authorize hosted
capabilities, or appear as an Omni-window identity in the UI.

### Commands, keybindings, and menus

Keep the existing focus-based workbench command model. When a hosted workbench
is active, profile management and profile switching target that workbench.
Shell-owned commands remain local or use the existing trusted forwarding
facade.

Do not add "New Omni Window with Profile...". Keep one "New Omni Window"
action because choosing a shell profile no longer changes the user-visible
session. Retain upstream "New Window" and "New Window with Profile..." for
regular workbenches.

Mixed-profile testing must cover native menu accelerators, global keybindings,
shell-focused Projects interactions, and hosted editor focus. The expected rule
is that the focused renderer's keybinding service handles the command, while
shell-wide forwarding remains allowlisted and instance-bound.

## Appearance projection

### Projected snapshot

Each hosted workbench publishes a resolved appearance snapshot after startup
and whenever its theme or relevant layout configuration changes. The snapshot
contains:

- base color scheme: light, dark, high contrast light, or high contrast dark;
- the resolved registered workbench color values required by shell parts,
  including `workbench.colorCustomizations`;
- `workbench.experimental.modernUI`; and
- `workbench.experimental.modernUIUppercaseViewHeaders`.

Send resolved values, not a theme extension ID. The shell may not have the same
theme extension loaded, and a profile may override individual colors.

The first implementation does not project token colors, editor styles, file
icons, product icons, zoom, or language. Add them later only if runtime evidence
shows a visible shell-owned surface that needs them.

### Transport and authority

Extend the existing trusted hosted-shell protocol with a least-authority
appearance message. Bind it to the authenticated window, hosted instance, and
connection generation. Reject snapshots from stale instances, replaced ports,
or a child that is no longer hosted by the receiving shell.

Cache the latest snapshot per hosted instance. When the active instance
changes, apply its cached snapshot immediately and request or await a fresh one.
An inactive child may update its cache but cannot change the visible shell.

### Applying appearance

Introduce one shell-side appearance projection service rather than writing
projected values into configuration. It should:

- apply base theme classes and shell CSS variables;
- notify shell parts that compute colors programmatically so they rerun
  `updateStyles()` or the equivalent;
- toggle the Modern UI and uppercase-header presentation classes;
- request the required shell relayout when Modern UI changes; and
- restore the shell fallback snapshot when no hosted workbench exists.

Theme-picker previews should project live and cancellation should naturally
restore the prior snapshot. When focus moves from a hosted workbench to the
Projects sidebar, preserve the last active workbench's appearance rather than
flashing back to the shell fallback.

Appearance projection is presentation only. It must not mutate the shell
profile's settings, Settings Sync data, or another workbench's configuration.

## Serve-web design

The project catalog remains server-side and global within its existing
user-data authority. Live workbench ownership must not become global across all
users, machines, or browsers connected to a server.

Define serve-web ownership scope as one browser profile and origin. Coordinate
same-origin Omni tabs with a browser-side owner registry using `BroadcastChannel`
and a crash-recoverable per-path lock or lease. The exact primitive should be
prototyped before committing storage schema; Web Locks is preferred when
available, with a lease-backed fallback if Hucode supports browsers without it.

Within that scope:

- duplicate open and restore requests elect one owner;
- the losing tab asks the owner to activate the hosted workbench;
- focusing the owning browser tab is best-effort because browsers may reject
  programmatic focus; and
- when focus is denied, the requester shows a clear notification with the
  owning tab/session identity rather than opening a duplicate.

Separate browser profiles, devices, or origins may open the same server path.
That is outside the ownership scope and must not be blocked by server-global
state.

Appearance projection uses the same typed hosted-shell protocol and snapshot
semantics on web. A full page reload remains required after a server protocol
upgrade; do not retain legacy adapters.

## Persistence and migration

### Catalog and session storage

Keep current global project-manager storage. Do not introduce profile-keyed
catalog records or migrate projects between profiles.

Keep existing per-window or per-page session storage for active, resident,
dormant, and retained workbench entries. Add only the ownership metadata needed
for deterministic restore and diagnostics, such as activity time and stable
session identity, if it is not already present.

The live ownership registry is runtime state, not durable truth. Persisted
session entries are claims that must pass admission again after startup.

### Existing installations

The current shipped model already has a global project catalog and per-window
workbench lifecycle. The revised design should therefore need no destructive
catalog migration.

If any branch from the old profile-space implementation reaches an integration
environment, its profile-partitioned data must not silently become canonical.
Before landing the revised storage work, inspect the deployed build history and
either:

1. discard unshipped experimental records; or
2. merge them deterministically into the global catalog with conflict reporting
   and the original records retained for recovery.

Do not write this migration until there is evidence that users can possess the
old schema.

## PR #193 disposition

[PR #193](https://github.com/jimeh/hucode/pull/193) must not merge as currently
designed because its central same-profile invariant conflicts with this plan.

Use its commits as investigation evidence against three buckets:

- **retain**: trusted session identity, bootstrap consistency, tests, or
  refactors that remain valid without profile equality;
- **rework**: fields or handshakes such as an Omni profile ID that can become
  internal shell bootstrap identity without authorizing a child profile; and
- **drop**: owner-profile selection, profile-equality enforcement,
  profile-specific window actions, and catalog partitioning assumptions.

Close PR #193 as superseded once the replacement feature branch is published.
Reimplement any retained behavior in the new branch instead of cherry-picking
the profile-owner commits. Do not preserve churn merely to keep the existing
branch alive.

Issue #191's title and body also describe the rejected profile-space model.
Rewrite them to summarize this plan before implementation resumes so new PRs,
change fragments, and review comments do not cite contradictory acceptance
criteria.

## Related onboarding work

[Issue #192](https://github.com/jimeh/hucode/issues/192) remains the separate
first-launch onboarding track. It no longer depends on choosing an owner
profile for the initial Omni window. Onboarding should import into the user's
chosen regular profile, or Default when no choice is made, and the initial
hosted workbench should use normal workspace-profile association.

This plan changes only that profile handoff. It does not absorb the onboarding
experience, editor detection, import selection, or first-launch UI into the
Omni implementation series.

## Delivery sequence

Deliver the complete plan through one `$ship-feature-pr` directly against the
live default series branch. Treat the slices below as ordered implementation
checkpoints, not separate pull requests. Complete focused tests and create one
coherent commit after each checkpoint so reviewers can inspect the final pull
request by behavior and dependency order.

Keep the pull request draft until every slice is complete. Run independent
review and full CI against the combined exact head, then address confirmed
findings within the delivery's correction budget. If a slice proves materially
larger than the current architecture predicts, split it only from concrete
implementation or review evidence rather than pre-planning another PR series.

### Slice 1: Correct the profile foundation

- Retitle and rewrite issue #191 to replace its profile-space acceptance
  contract with this plan's session, ownership, and projection model.
- Characterize hosted profile switching on desktop and serve-web with two real
  profiles, including extension-host restart and connection survival.
- Audit PR #193 into retain, rework, and drop buckets, then supersede it with
  the replacement feature branch.
- Remove profile equality as a hosted-shell invariant and authority check.
- Stabilize the shell's internal bootstrap profile without exposing it as a
  product choice.
- Keep one New Omni Window action and remove any new profile-specific Omni
  window actions introduced by the old plan.

Exit evidence: two hosted workbenches in one Omni session can use different
profiles, and switching one leaves the shell connection and sibling unchanged.

### Slice 2: Desktop ownership admission

- Add the main-process canonical-path ownership coordinator and typed outcomes.
- Seed and reconcile it from current regular and hosted windows.
- Put hosted creation, restore, recovery, unload, and window destruction behind
  generation-safe reserve/publish/release operations.
- Route project rows, retained workbenches, Add Workbench, and Quick Picks
  through it.
- Add unit and service tests for sequential and concurrent admission.

Exit evidence: simultaneous requests for one path create exactly one desktop
workbench and focus the winner from every covered ingress.

### Slice 3: Routing, restore, and transfer completeness

- Route external opens, hosted navigation, session restore, crash recovery,
  and test helpers through the coordinator.
- Implement deterministic duplicate-restore arbitration.
- Convert standalone reopen into an explicit generation-safe transfer.
- Broadcast ownership state to Omni sessions and add restrained owner
  indication in the Projects sidebar.
- Remove or narrow direct controller-open APIs that bypass admission.

Exit evidence: the same path cannot become live in two desktop Omni windows or
in an Omni and regular window, including across restore and crash recovery.

### Slice 4: Appearance projection

- Define the typed appearance snapshot and hosted-shell capability.
- Publish initial, live theme, theme-preview, profile-switch, and Modern UI
  updates from each hosted workbench.
- Add the shell projection service, per-instance cache, stale-generation
  rejection, CSS/color application, and relayout behavior.
- Preserve the last active appearance while shell UI owns focus.
- Implement identical protocol behavior in desktop and serve-web transports.

Exit evidence: switching between hosted workbenches with visibly different
themes and Modern UI settings updates the entire Omni window without changing
shell settings.

### Slice 5: Serve-web tab ownership

- Prototype and select the browser lock/lease primitive.
- Add same-origin, browser-profile-scoped ownership and tab messaging.
- Arbitrate concurrent open, restore, release, and crashed-tab recovery.
- Activate the owning hosted workbench and focus its tab when the browser
  permits; otherwise report the existing owner clearly.
- Verify that different browser profiles and devices remain independent.

Exit evidence: two Omni tabs in one browser do not host the same path, while a
separate browser profile is not incorrectly blocked.

### Slice 6: Integration proof and durable documentation

- Run the full desktop and serve-web scenario matrix with two profiles, two
  Omni sessions, and one regular window.
- Verify native menus, keybindings, extension hosts, profile switching, theme
  previews, Modern UI relayout, shutdown, restore, and crash recovery.
- Update `omni.md`, `architecture.md`, commands, and user-facing help to the
  final behavior.
- Remove obsolete profile-space terminology and compatibility code.
- Prepare the single feature PR with its commit map and runtime evidence.

Exit evidence: all acceptance checks below are backed by automated tests or a
recorded, reproducible runtime scenario.

## Testing strategy

### Ownership unit and service tests

Cover the material success, race, and cleanup cases:

- sequential and simultaneous opens of the same canonical path;
- Linux case-sensitive and macOS/Windows case-insensitive comparison;
- owner in the requesting Omni, another Omni, and a regular window;
- reservation join, successful publish, failed creation, cancellation, and
  stale-generation release;
- loading, active, loaded, dormant, crashed, unloaded, and missing entries;
- deterministic duplicate restore and losing retained-record preservation;
- explicit hosted-to-standalone transfer;
- window close and process-owned cleanup; and
- unrelated paths admitting concurrently.

Each user-facing ingress needs a focused routing test that proves it requests
admission rather than creating a controller entry directly.

### Profile and protocol tests

- A hosted workbench starts with its workspace-associated profile.
- Switching profile refreshes settings, keybindings, storage, extensions, and
  workspace association through upstream behavior.
- The shell profile and sibling profiles do not change.
- Mixed profiles do not break hosted-shell connection acquisition,
  reconnection, command forwarding, unload, or terminal shutdown.
- Trusted capability checks reject stale window, instance, and connection
  generations without comparing profile IDs.

### Appearance tests

- Initial active workbench snapshot and no-workbench fallback.
- Switching active workbench between light, dark, and high-contrast themes.
- Live persisted theme changes and preview/cancel cycles.
- Resolved `workbench.colorCustomizations` reaching shell-owned parts.
- Modern UI and uppercase-header changes causing the required relayout.
- Shell/sidebar focus preserving the last active snapshot.
- Inactive and stale-generation snapshots updating neither visible colors nor
  layout.
- Profile switching republishing appearance after services settle.

### Runtime scenarios

Desktop acceptance uses two Omni windows, one regular window, two profiles with
different keymaps/themes/Modern UI settings, one project worktree, and one
arbitrary folder:

1. Open the worktree in Omni A, request it from Omni B, and verify Omni A is
   focused with the existing hosted workbench active.
2. Repeat for the arbitrary folder and from external folder routing.
3. Open the path standalone and verify the hosted owner is cleanly transferred,
   not duplicated.
4. Trigger two simultaneous open requests and observe one renderer.
5. Persist conflicting restore claims, restart, and verify the deterministic
   winner and usable losing session.
6. Switch profiles independently in two hosted workbenches and exercise editor,
   terminal, menu, and Projects-sidebar shortcuts.
7. Switch between contrasting themes and Modern UI modes, including theme
   preview and cancellation.
8. Crash and recover the owner, then close it and verify ownership releases.

Serve-web repeats the applicable scenarios in two same-origin tabs and then in
a separate browser profile to prove the intended ownership boundary.

### Validation commands

Use focused checks while implementing each slice, then the repository gates:

```sh
npm run gulp compile-client
npm run hucode:check-test-suites
npm run hucode:compile
npm run hucode:validate
npm run -s precommit -- <edited-paths>
```

Run the generated Hucode Node or Electron suites that cover each changed layer.
Do not run concurrent `scripts/test.sh` processes, and rebuild `out/` after
source edits before interpreting Electron test results. Use the repository's
desktop and serve-web launch/smoke paths for the runtime matrix.

## Acceptance checklist

- [ ] One global project catalog is visible from every profile and Omni window.
- [ ] Multiple Omni windows retain independent active, resident, dormant, and
      restored workbench state.
- [ ] New Omni Window is the only profile-related Omni creation action.
- [ ] Hosted workbenches may use and hot-switch different regular profiles in
      one Omni window.
- [ ] Switching a hosted profile does not switch the shell or a sibling.
- [ ] A canonical path has at most one live desktop owner across regular and
      hosted workbenches.
- [ ] Requesting an owned path focuses its window and activates its hosted
      workbench when applicable.
- [ ] Concurrent open and restore requests cannot bypass ownership admission.
- [ ] Standalone reopen transfers ownership without overlapping live renderers.
- [ ] Crash, unload, failure, and window close do not leave stale ownership.
- [ ] The Projects sidebar shows enough ownership state to explain a focus jump.
- [ ] The shell follows the active workbench's resolved colors and Modern UI
      presentation without writing shell configuration.
- [ ] Theme previews, cancellation, high contrast, and shell focus behave
      without visible fallback flicker.
- [ ] Native menus and keybindings target the correct focused renderer under
      mixed profiles.
- [ ] Same-browser serve-web tabs arbitrate duplicates without imposing a
      server-global lock.
- [ ] PR #193 is closed or reshaped so no same-profile invariant remains.
- [ ] Focused tests, generated suite checks, compile, validation, hygiene, and
      desktop/serve-web runtime evidence pass.

## Risks and controls

| Risk | Control |
| --- | --- |
| Two requests race after both observe no owner | Make per-path reservation atomic in one main-process coordinator; scans are reconciliation only. |
| A stale crash or close releases a replacement | Bind every mutation and release to an ownership generation. |
| Dormant entries create hidden duplicate claims | Treat dormant and recovery-pending entries as owners and arbitrate restore before renderer creation. |
| Profile switching breaks the shell connection | Bind trust to window, instance, port, and generation rather than profile equality; add mixed-profile protocol tests. |
| Theme projection diverges from child rendering | Publish resolved colors and scheme, not a theme ID; cover customizations and previews. |
| Modern UI projection changes classes without geometry | Centralize application in a projection service that also requests shell relayout. |
| Shell settings are accidentally overwritten | Keep projection ephemeral and outside configuration/Settings Sync. |
| Browser tabs cannot force-focus one another | Make activation reliable, focus best-effort, and show the owner when browser policy denies focus. |
| Web ownership blocks unrelated users or devices | Scope coordination to one browser profile and origin, not the server project manager. |
| Old profile-space work is merged for convenience | Gate the first slice on explicit retain/rework/drop review of PR #193. |
| Upstream changes broaden the fork patch surface | Keep coordinator, projection, protocol, and UX code under `src/vs/hucode/`; use narrow upstream seams. |

## Implementation questions to settle during characterization

No product decision currently blocks implementation. The first relevant slice
should answer these low-level questions with focused prototypes and record the
choice in its PR:

1. Should crashed hosted entries hold ownership indefinitely while the current
   recovery UI remains actionable, or use a bounded lease after recovery is
   explicitly abandoned? The default recommendation is no time-based expiry;
   release on an explicit lifecycle transition.
2. Can Web Locks plus `BroadcastChannel` cover every supported serve-web
   browser, or is a lease-backed fallback required? This determines only the
   browser coordination mechanism, not the ownership scope.
3. Which existing shell parts require programmatic style refresh in addition
   to CSS variable replacement? Inventory this from runtime evidence before
   finalizing the appearance snapshot's color set.
4. Does the current default-profile bootstrap isolate shell-only settings well
   enough, or should Hucode create an internal shell profile? The profile must
   remain invisible and must not acquire product authority either way.
