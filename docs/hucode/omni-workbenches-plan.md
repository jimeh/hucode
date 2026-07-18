---
title: Hucode Omni Workbenches and Projects Sidebar Plan
status: implemented
last_updated: 2026-07-18
---

# Hucode Omni Workbenches and Projects Sidebar Plan

## Document purpose

This document is the implementation plan and persistent progress tracker for
expanding the Omni Projects sidebar into a combined Workbenches and Projects
sidebar.

Keep this file current during implementation:

- update the phase status table when work starts or finishes;
- check off completed acceptance criteria and test cases;
- add dated entries to the decision and implementation logs;
- record deviations from the proposed design before implementing them;
- record exact validation commands and results before declaring the feature
  complete.

The plan is intentionally stored in the repository so future work can refer to
the approved behavior and track progress without reconstructing decisions from
chat history.

## Current status

- Overall status: **Final hardening implemented and locally validated**
- Implementation status: **Complete; awaiting orchestrator review and CI**
- Last updated: **2026-07-18**
- Current owner: **Hucode maintainers**

| Phase | Status | Notes |
| --- | --- | --- |
| 0. Approve product and architecture decisions | Complete | Approved 2026-07-17 |
| 1. Add retained-workbench contracts and state model | Complete | Shared catalog and restore scheduler |
| 2. Add desktop persistence and lifecycle operations | Complete | Native window-state persistence and safe lifecycle |
| 3. Add serve-web persistence and lifecycle parity | Complete | Profile storage and iframe restore policy |
| 4. Build the combined sidebar model and UI | Complete | Sections, ordering, actions, and navigation |
| 5. Route arbitrary folder opens into Omni | Complete | Desktop and browser host routing |
| 6. Complete tests, documentation, and runtime validation | Complete | Automated suites and fresh-profile desktop QA pass |
| 7. Refine density, ordering, state icons, and missing paths | Complete | Focused compile, tests, and hygiene pass |

## Goal

Expand the Omni sidebar from a project-only navigator into a persistent
navigator for both:

1. saved Git projects and their worktrees; and
2. arbitrary folder-backed workbenches hosted inside the Omni window.

Users should be able to open an arbitrary directory as a hosted workbench,
switch away from it without destroying it, unload its renderer to release
resources while retaining its sidebar entry, reopen it from the sidebar, and
dismiss the entry explicitly when it is no longer wanted.

## Terminology

Use these terms consistently in UI, code comments, and documentation:

- **Project**: a persistent `IProjectManagerService` record representing a Git
  repository and its known worktrees.
- **Project worktree**: a folder managed and displayed under a saved project.
- **Arbitrary workbench**: a retained folder entry that is not represented by a
  saved project worktree.
- **Hosted workbench instance**: a live desktop `WebContentsView` or serve-web
  iframe running a normal VS Code workbench.
- **Load**: create or restore the hosted workbench instance for an entry.
- **Activate**: make an already loaded or newly loaded workbench the visible
  hosted workbench.
- **Unload**: complete the normal dirty-state and shutdown handshake, destroy
  the hosted instance, and retain the arbitrary workbench entry.
- **Dismiss**: remove the arbitrary workbench entry from the sidebar. If it is
  loaded, dismissal must unload it successfully before removing the entry.
- **Close**: reserve for lower-level renderer/window lifecycle APIs where the
  existing method name cannot be changed cleanly. User-facing UI should say
  **Unload** or **Dismiss**, not **Close**, for this feature.

## Settled product decisions

The following decisions are considered approved unless plan review changes
them:

- The Omni sidebar has distinct **Projects** and **Workbenches** sections.
- The Workbenches section defaults above Projects because it is expected to be
  the shorter, more transient list.
- Each section has its own visible plus action.
- Both section headers are collapsible and default to expanded.
- Section collapse state persists per Omni window across restart.
- The Projects plus action retains the current Add Project behavior.
- The Workbenches plus action opens a folder picker and creates a retained,
  loaded arbitrary workbench for the selected directory.
- The first version supports single-folder workbenches only.
- A workbench row uses the directory basename as its primary label.
- A workbench row uses the full home-relative path, such as
  `~/Projects/example`, as secondary text.
- Paths outside the user home use the normal absolute platform label.
- Workbench rows default to two lines so the secondary path is useful at
  normal sidebar widths. `hucode.omni.workbenchItemLayout` independently
  switches them to a compact single-line layout.
- Project worktree rows default to compact and can independently use two lines
  through `hucode.omni.worktreeItemLayout`.
- Workbenches and Projects section headers can be reordered by drag-and-drop.
  Their order persists per Omni window and defaults to Workbenches first.
- Workbench rows can be reordered with drag-and-drop. Their manual order is
  persisted and is independent of activation recency.
- Unloading an arbitrary workbench releases its hosted renderer but leaves the
  entry visible and reopenable.
- An unloaded workbench remains until the user explicitly dismisses it with
  the X action or a Dismiss Workbench context action.
- The arbitrary workbench catalog is separate from the Git project manager.
- Catalog ownership is per Omni window, matching the existing resident hosted
  workbench controller and restore state.
- If the folder is already open in a standalone window or hosted workbench,
  opening it from Workbenches focuses the existing owner and does not create a
  duplicate or retain a new catalog entry.
- When a retained workbench becomes a saved project worktree, remove its
  arbitrary-workbench catalog record and treat the path only as a project.
- A loaded workbench can be dismissed directly from its context menu. The
  operation still completes the safe unload handshake before removing the
  catalog entry.
- Explicit Open in New Window behavior continues to create or focus a
  standalone workbench instead of retaining an Omni entry.
- Saved `.code-workspace` files, multi-root workspaces, and truly empty hosted
  workbenches are outside the initial scope.
- Desktop and serve-web should expose equivalent sidebar and lifecycle
  semantics, even though their persistence adapters differ.
- Serve-web does not try to discover or focus an existing browser tab for a
  folder. Upstream VS Code web only avoids navigation when reusing the current
  tab for the same workspace; otherwise it navigates or opens a tab and does
  not maintain an existing-tab workspace registry. Desktop retains its
  focus-existing-window behavior.
- The Omni shell checks folder availability before loading. Missing retained
  folders stay catalogued in a missing/unloaded presentation and do not create
  a desktop hosted view or serve-web iframe.
- On Omni startup, eagerly restore the last selected hosted workbench by
  default. Keep other previously loaded workbenches dormant until first
  activation, visually distinct from explicitly unloaded workbenches.
- Expose the eager-restore policy as a user setting shared by desktop and
  serve-web.
- Generalize the standard switch picker, loaded quick switcher, last-active
  command, and all next/previous variants to navigate both arbitrary
  workbenches and project worktrees.
- Preserve existing command IDs and keybindings while updating user-facing
  titles and behavior to neutral Workbench terminology.

## Non-goals

Do not expand the first implementation to include:

- empty hosted workbenches with no folder;
- multi-root or `.code-workspace` hosted workbenches;
- remote-authority workbenches;
- changing the project manager into a general workspace registry;
- pinning, custom labels, or grouping arbitrary workbenches;
- automatic resource-limit or LRU eviction policies;
- renaming the existing persisted `worktreePath`,
  `omniActiveWorktreePath`, or `omniResidentWorkspaces` contracts;
- changing explicit force-new-window behavior;
- changing project creation, pinning, worktree creation, or project-management
  commands that are unrelated to combined navigation.

Remote support should remain possible later. New retained-workbench records
should therefore store a URI-shaped resource identity rather than introduce a
second new persisted absolute-path-only format.

## Existing architecture

The feature should extend the current architecture rather than create a second
hosted-workbench stack.

### Existing capabilities to reuse

- `IHucodeHostedWorkbenchInstance.projectId` is already optional.
- `IHucodeShellService.openWorkspace()` already accepts a path without a
  project identifier.
- `ResidentHostedWorkspacesController` already creates, activates, restores,
  unloads, and shuts down hosted desktop workbenches.
- `WebHucodeShellController` already creates and switches hosted serve-web
  workbench iframes for arbitrary paths.
- `HostedWorkspaceStateModel` already owns path indexing, active selection,
  readiness transitions, and public live-instance state.
- Desktop Omni window state already persists resident workspace restore
  entries and the active workspace path.
- `ILabelService.getUriLabel()` already provides platform-aware, tildified
  labels suitable for the requested secondary text.
- The Project Switcher renderer already has active, loading, loaded, missing,
  and unloaded visual conventions that arbitrary rows can follow.

### Current gaps

- The Project Switcher tree is built only from project-manager records.
  Project-less hosted instances are omitted.
- The current UI has one global Add Project action rather than per-section
  creation actions.
- Unknown folder opens from desktop Omni or hosted desktop workbenches are
  deliberately forced into a new normal window.
- Browser host opening does not currently route arbitrary folders through the
  serve-web Omni shell.
- Live hosted state cannot represent an unloaded-but-retained arbitrary
  workbench because unloaded instances are removed.
- Serve-web hosted instances are not restored after a shell page reload.
- Current selection and navigation target types assume every row has a project
  identifier.

## Desired user experience

### Sidebar structure

The sidebar should render in this default order. Dragging either section header
persists the alternate Projects-first order:

```text
Workbenches                                   [+]
  folder-name
  ~/full/path/to/folder-name

Projects                                      [+]
  Pinned
    project
      worktree
  Unpinned
    project
      worktree
```

Section headers should be visually stronger than the existing Pinned and
Unpinned separators. Their plus actions must remain visible rather than only
appearing on row hover. Both headers should expand and collapse their own
children, default to expanded, and preserve expansion state using the tree's
existing view-state mechanism.

The existing full-height “No projects have been added yet” state should not
replace the combined tree in an Omni window. Both section headers must remain
available when either or both sections are empty.

### Workbench row states

| State | Primary behavior | Suggested presentation |
| --- | --- | --- |
| Active | Click focuses the active workbench | Active row treatment |
| Loading | Click is idempotent | Spinner, normal labels |
| Loaded | Click activates the resident workbench | Window icon, normal opacity |
| Dormant | Click lazily creates and activates | Sleep/pause treatment distinct from unloaded |
| Unloaded | Click loads and activates | Muted row, X trailing action |
| Crashed | Click retries loading | Warning icon, retained X/dismiss path |
| Missing folder | Click reports a useful error | Warning icon, remains dismissible |

The dormant visual state also applies to project worktree rows retained by the
startup restore scheduler. Existing project rows that were explicitly unloaded
must remain visually distinct from dormant restore candidates.

For a loaded row, the trailing hover action should be the existing
minimize/unload affordance. For a dormant or unloaded row, the trailing hover
action should be X/Dismiss.

Workbench rows should support drag-and-drop reordering within the Workbenches
section. A drag must not move a workbench into Projects, turn it into a
project, or alter filesystem contents. New workbenches append to the existing
manual order.

### Actions

Workbench row context menu:

- Open or Activate Workbench
- Open in New Window
- Unload Workbench, when loaded/loading/active/crashed as appropriate
- Dismiss Workbench

Dismissal must never delete or modify the selected directory.

### Navigation

- Selecting a workbench row must set the real tree selection and focus using
  the live item instance.
- Sidebar back/forward history should include arbitrary workbenches visited in
  the current session.
- Switch to Project Worktree becomes **Switch Workbench...** and includes every
  project worktree and retained arbitrary workbench. Choosing a dormant or
  unloaded target loads it before activation.
- Quick Switch Loaded Project Worktree becomes **Quick Switch Loaded
  Workbench** and includes all live project and arbitrary hosted instances.
  Dormant and explicitly unloaded targets are excluded because they have no
  loaded renderer.
- Switch to Last Active Project Worktree becomes **Switch to Last Active
  Workbench** and uses combined activation recency.
- Previous/Next Project Worktree becomes **Previous/Next Workbench** and cycles
  across the full combined target order, loading a dormant or unloaded target
  when selected.
- Previous/Next Loaded Project Worktree becomes **Previous/Next Loaded
  Workbench** and cycles only across live hosted instances.
- Combined target order follows the persisted sidebar section order. Within
  Workbenches it uses manual order; within Projects it uses existing
  pinned/unpinned project and worktree order. Collapsed section state does not
  remove targets from keyboard navigation.
- Quick-pick grouping should distinguish Current, Loaded, Dormant, and Not
  Loaded while preserving combined target order within each group.
- Search arbitrary entries by basename and full/home-relative path; preserve
  existing project and worktree search fields.
- Keep existing command IDs, quick-navigation context IDs, and keybindings for
  compatibility with user configuration. User-facing names and shared model
  types should use neutral Workbench terminology.
- In a standalone non-Omni window, commands retain existing project-only input
  because that window has no arbitrary catalog. Hosted workbenches forward the
  combined command to their owning Omni shell as they do today.

## Proposed state model

### Retained arbitrary workbench record

Add a Hucode-owned shared contract similar to:

```ts
export interface IHucodeRetainedWorkbench {
  readonly id: string;
  readonly folderUri: UriComponents;
  readonly desiredState: 'loaded' | 'unloaded';
  readonly order: number;
  readonly lastActiveAt?: number;
}
```

The exact name may change during implementation, but the contract must have:

- a stable ID independent of the transient hosted instance ID;
- URI-shaped folder identity for future authority-aware evolution;
- persisted desired load state so explicit unload survives restart;
- persisted manual order for drag-and-drop sorting;
- persisted recency for activation and restore selection without changing the
  manual sidebar order.

Do not put Git metadata, branches, project IDs, pinning, or custom labels in
this record.

### Live and retained state relationship

Keep `HostedWorkspaceStateModel` responsible for live hosted instances. Add a
small shared retained-workbench catalog model responsible for:

- normalized resource lookup;
- deduplication;
- stable IDs;
- desired load state;
- recency;
- serialization and validation;
- add, reorder, mark loaded, mark unloaded, and dismiss operations.

The shell’s public state should expose both the retained records and the live
hosted instances. The sidebar model joins them by normalized folder identity:

```text
retained record + live instance -> active/loading/loaded/crashed row
desired-loaded record only      -> dormant row awaiting first activation
desired-unloaded record only    -> explicitly unloaded row
live project worktree instance  -> project/worktree row
```

Avoid storing presentation labels in the catalog. Compute basename,
home-relative description, tooltip, and lifecycle icon in the pure sidebar
model.

### Identity and deduplication

- A retained record is unique by normalized folder URI within its Omni window.
- Reopening an existing retained folder reuses the record and hosted instance.
- New records append to the Workbenches section's persisted manual order.
- Reordering rewrites a compact deterministic order and never changes MRU
  activation metadata.
- Deserialization assigns compact order from serialized sequence when an
  adopted or malformed record has no valid order.
- Workbench tree handles should use the stable retained record ID, not an
  encoded absolute path.
- Live hosted instances remain keyed by the current normalized path mechanism
  in the initial implementation.
- URI identity and authority-aware normalization can replace path identity in a
  later remote-workbench feature without migrating the sidebar record ID.

### Desired state transitions

| Event | Catalog result | Hosted-instance result |
| --- | --- | --- |
| Add folder | Create record as loaded | Create and activate |
| Activate loaded row | Mark recency | Activate existing |
| Activate dormant row | Keep loaded; mark recency | Lazily create and activate |
| Open unloaded row | Set loaded | Create and activate |
| Reorder row | Update persisted order | No lifecycle change |
| Explicit unload | Set unloaded after successful handshake | Destroy |
| Dismiss unloaded | Remove record | No instance |
| Dismiss loaded | Remove only after successful unload | Destroy |
| Unload veto | Leave state unchanged | Keep instance |
| Renderer crash | Retain record; persist as unloaded | Keep crash state until retry/dismiss |
| App shutdown | Preserve desired state | Normal shutdown/restore behavior |
| Folder missing on restore | Retain as unloaded/error | Do not create instance |

Do not interpret application shutdown as an explicit unload. A workbench that
was loaded when the app quit should remain desired-loaded. Whether its hosted
instance is created immediately or on first activation is controlled by the
startup restore policy.

### Project/workbench classification

The combined sidebar must never show the same path twice.

Classification order:

1. If a retained path exactly matches a current project worktree, render the
   path only under Projects and schedule removal of the retained record after
   authoritative project state has hydrated.
2. If a live instance has a project ID matching an existing project but Git no
   longer reports that worktree, keep the existing Missing worktree behavior.
3. Otherwise, render the retained record under Workbenches.

Promotion is a catalog/controller reconciliation operation, not a mutation
inside the pure sidebar model. Adding or updating a project triggers it once
project state is authoritative; the sidebar suppresses a duplicate row during
the transition. Promotion does not copy arbitrary-workbench order or
desired-state metadata into the project record. If the project is later
removed, the folder does not automatically reappear under Workbenches; the user
can add it again. A live hosted instance may continue to be reused by normalized
path while the sidebar and future lifecycle behavior become project-owned.

## Persistence design

### Startup restore policy

Add the user-facing setting
`hucode.omni.restoreHostedWorkbenches`, with these values:

| Value | Startup behavior |
| --- | --- |
| `active` | Default. Eagerly restore only the last selected desired-loaded hosted workbench; leave the others dormant |
| `all` | Eagerly restore every desired-loaded hosted workbench |
| `none` | Eagerly restore none; leave every desired-loaded hosted workbench dormant |

The setting applies consistently to desktop and serve-web and covers all
Omni-hosted workbenches, including project worktrees and arbitrary
workbenches, so the window has one understandable resource-restoration policy.

Dormant is a runtime/sidebar projection, not a third persisted desired state:

- desired-loaded plus a live instance is active, loading, loaded, or crashed;
- desired-loaded without a live instance is dormant and loads on first
  activation;
- desired-unloaded without a live instance is explicitly unloaded;
- the setting never causes an explicitly unloaded workbench to load.

If the previously active workbench is absent, invalid, or explicitly unloaded,
fall back to the most recently active valid desired-loaded entry. If there is
no valid candidate, show the Omni host surface without eagerly creating a
workbench. Project and arbitrary restore candidates must share this selection
policy.

Use one restore scheduler fed by:

- the persisted active hosted-workbench path;
- desired-loaded arbitrary catalog records;
- persisted resident project-worktree restore entries; and
- the configured restore policy.

The scheduler selects the eager set and retains the remainder as dormant
candidates. For project worktrees, presence in the resident restore snapshot is
the equivalent of desired-loaded; do not add restore metadata to project
manager records. Dormant project candidates must remain in the next persisted
snapshot even if they were never activated during the current session.
Explicitly unloading a project worktree removes it from that snapshot.

### Desktop

Add a new optional Omni-window configuration and window-state field for the
retained catalog. Do not overload project manager storage.

Suggested shape:

```ts
omniRetainedWorkbenches?: readonly IHucodeRetainedWorkbench[];
```

Desktop responsibilities:

- copy the field through Omni open plans and window configuration;
- serialize and restore it in `WindowsStateHandler`;
- update window configuration whenever catalog state changes;
- validate malformed records and drop only invalid entries;
- deduplicate records using the platform’s path-casing behavior;
- persist and restore manual workbench ordering;
- apply the configured eager-restore policy after catalog and resident-state
  hydration;
- project desired-loaded entries that were not eagerly created as dormant;
- leave desired-unloaded entries visible without creating views;
- preserve existing resident-workspace compatibility fields while moving
  restore scheduling behind the shared policy.

Existing `omniResidentWorkspaces` remains the compatibility restore snapshot
during the first implementation. For project worktrees, persistence must merge
current live instances with unactivated dormant candidates so an active-only
startup does not forget them on the following restart. The new arbitrary
catalog is authoritative for arbitrary desired state; deduplicate any
project-less compatibility entries during adoption and restore. Do not rename
the existing field as part of this feature.

On first launch after upgrade, adopt any project-less resident restore entries
into retained records so older or development-created arbitrary instances do
not remain invisible.

### Serve-web

Serve-web needs equivalent retained catalog persistence across shell refresh.
Use a Hucode-owned storage adapter rather than server project-manager state.

Requirements:

- scope storage to the current server origin and Hucode user/profile context;
- serialize the same shared retained-record shape;
- hydrate before or as the shell sidebar initializes;
- apply the same configured eager-restore policy once the host surface exists;
- show non-eager desired-loaded entries as dormant without creating iframes;
- keep desired-unloaded rows without creating iframes;
- tolerate stale or malformed browser storage;
- avoid sharing transient `MessagePort` or iframe instance IDs.

The implementation should prefer `IStorageService` when its scope is suitable.
If browser-local storage is required, isolate it behind an injectable adapter
so tests do not depend on a real browser storage global.

### Persistence compatibility

- Absence of the new field must behave as an empty catalog.
- Older builds should ignore the additive field safely.
- Corrupt individual entries must not discard the whole Omni window state.
- Removing a catalog record must never touch filesystem contents.
- Explicitly unloaded state must survive app restart or web refresh.
- Manual workbench ordering must survive app restart or web refresh.
- Desired-loaded dormant state must survive repeated restarts until activation
  or explicit unload.

## Service and controller API

Prefer explicit retained-workbench operations rather than adding an ambiguous
boolean to `openWorkspace()`.

Candidate shell-service methods:

```ts
retainAndOpenWorkbench(
  windowId: number,
  folderUri: UriComponents
): Promise<IHucodeHostedWorkspaceState>;

unloadRetainedWorkbench(
  windowId: number,
  workbenchId: string
): Promise<IHucodeHostedWorkspaceState>;

dismissRetainedWorkbench(
  windowId: number,
  workbenchId: string
): Promise<IHucodeHostedWorkspaceState>;

reorderRetainedWorkbenches(
  windowId: number,
  orderedWorkbenchIds: readonly string[]
): Promise<IHucodeHostedWorkspaceState>;
```

Exact names should reflect final terminology. Required behavior:

- retain/open is idempotent by normalized folder identity;
- unload runs the existing renderer handshake and updates catalog state only
  after successful removal;
- dismissing loaded state composes unload plus record removal;
- a veto or timeout leaves the record and desired state intact;
- reorder validates that IDs belong to the same catalog, persists a compact
  order, and does not alter lifecycle or activation recency;
- activating an unloaded workbench updates desired state before opening, but
  rolls back or exposes a recoverable error state if creation fails;
- project worktree open paths continue to use existing project-aware methods;
- IPC subsets used by hosted desktop and web workbenches are updated together.

Keep lower-level `closeWorkspace()` available for existing project and
shutdown flows. User-facing arbitrary-workbench actions should call the new
semantic methods.

## Combined sidebar model

Add a Hucode-owned pure model, tentatively
`src/vs/hucode/common/omniSidebar/omniSidebarTreeModel.ts`, that composes:

- the existing project/worktree tree model;
- top-level section-header items in persisted order, defaulting to Workbenches
  then Projects;
- retained arbitrary workbench items;
- active and lifecycle projection;
- classification and duplicate suppression;
- stable handle lookup.

Do not turn `IProjectManagerService` or its records into a mixed project and
workbench model.

Candidate item kinds:

```ts
type OmniSidebarItem =
  | OmniSidebarSectionItem
  | ProjectSwitcherProjectItem
  | ProjectSwitcherWorktreeItem
  | ProjectSwitcherSeparatorItem
  | OmniSidebarWorkbenchItem;
```

Workbench item fields should include:

- retained workbench ID;
- folder URI/path;
- primary label;
- secondary description;
- tooltip;
- active flag;
- desired state;
- dormant projection;
- persisted manual order;
- live hosted lifecycle state and instance ID when present;
- context value;
- theme icon.

The pure model should accept path-label and identity helpers so Node/common
tests do not instantiate browser services.

## UI implementation

### Section rows

- Add Workbenches and Projects section item render paths with Workbenches first
  by default and persisted drag ordering.
- Keep plus buttons always visible and keyboard accessible.
- Prevent section rows from invoking Open Selected Worktree.
- Keep existing Pinned and Unpinned separators within Projects.
- Make both section rows collapsible, default them to expanded, and preserve
  their expansion state through the existing tree view-state mechanism.

### Workbench rows

- Use a dynamic tree-row height for two-line workbench rows.
- Keep compact project and worktree row heights unchanged by default.
- Stack labels and descriptions vertically for rows configured as two-line.
- Ellipsize both lines independently and preserve a full tooltip.
- Use the existing active row treatment.
- Use loading, dormant, unloaded, crashed, and missing-folder visual states.
- Expose correct ARIA labels combining name, path, and lifecycle state.

### Selection and commands

- Replace project-required navigation targets with a neutral Omni workbench
  target containing stable kind/ID and folder URI; project metadata is present
  only for project worktrees.
- Skip `setLastActiveWorktree()` when there is no project ID.
- Ensure active arbitrary workbenches can be selected/revealed after every
  shell-state rebuild.
- Extend in-session back/forward history to arbitrary workbench targets.
- Add Open/Activate, Unload, Dismiss, and Open in New Window command handling.
- Generalize switch-picker construction, loaded filtering, last-active
  selection, and adjacent-target calculation over the same combined target
  model.
- Keep loaded-only commands restricted to live hosted instances; dormant
  candidates participate only in the all-target variants.
- Preserve legacy command IDs and keybindings while updating localized titles,
  empty messages, and quick-pick section labels.
- Allow workbench rows to be reordered within Workbenches by drag-and-drop.
- Allow Workbenches and Projects section headers to be reordered by
  drag-and-drop and persist that order per Omni window.
- Reuse the existing project/worktree drag feedback and reorder conventions
  where they fit the two-line workbench row.
- Reject drops across section boundaries and drops onto folder contents.
- Rename user-facing “selected worktree” messages when they also apply to
  workbench rows.

### Empty host surface

Update the empty Omni host message from project-only wording to instruct users
to select a project worktree or workbench from the sidebar.

## Folder-open routing

### Workbenches plus action

The Workbenches plus action should:

1. show a single-folder picker;
2. return without mutation on cancellation;
3. validate or normalize the selected URI;
4. focus an existing standalone window or hosted workbench that owns the
   folder, without retaining a duplicate;
5. otherwise call the retained-workbench shell operation;
6. activate and focus the new hosted workbench;
7. report creation errors without losing the retained entry’s dismiss path.

Use the existing file dialog service so native and serve-web use the correct
picker implementation.

### Generic folder opens

When a single folder is opened from an Omni shell or hosted Omni workbench:

- preserve force-new-window, add/remove-folder, diff, merge, goto-line, and
  wait-marker behavior;
- resolve an exact project-worktree match first;
- route known worktrees through the existing project-aware hosted path;
- retain and open unknown folders as arbitrary workbenches;
- focus an already loaded matching hosted workbench rather than duplicate it;
- continue opening `.code-workspace` files in a normal workbench window.

Desktop currently has a Hucode-specific host helper. Refactor or extend it so
the decision-making can be reused by a browser-host companion. Keep changes to
upstream `nativeHostService.ts` and `browserHostService.ts` limited to service
injection and delegation into Hucode-named helpers.

### Existing standalone window ownership

The current project path tries to focus a normal window that already owns the
folder. Arbitrary workbench creation should use the same ownership rule:

- generic folder opens focus an existing normal window rather than duplicate
  it;
- the explicit Workbenches plus action focuses an existing standalone window
  or hosted workbench and does not create or retain a duplicate;
- moving a live standalone workbench into Omni is a separate future feature.

### Main-process and CLI routing

Do not broaden main-process `hucode <folder>` routing automatically in the
first implementation. Existing main-process logic should continue to focus a
matching hosted workbench if one exists. Creating a new retained arbitrary
workbench from an external CLI or OS open event is a separate policy decision
because it must choose an Omni-window owner.

## Lifecycle behavior

### Unload

Unloading a retained arbitrary workbench must:

1. resolve the retained record and hosted instance;
2. run the existing before-unload and will-unload handshake;
3. respect dirty-state vetoes and timeouts;
4. destroy owned integrated browser views;
5. detach and destroy the hosted workbench view/iframe;
6. select the most recent remaining hosted workbench, if any;
7. keep the Workbenches/Projects sidebar visible if no hosted workbench remains;
8. set the retained record to desired-unloaded;
9. emit one coherent public state update;
10. persist the catalog.

If unload fails or is vetoed, do not mark the record unloaded.

### Dismiss

- Dismissing a dormant or unloaded record removes and persists the catalog
  entry immediately.
- Dismiss Workbench is available from the context menu in every row state.
- Dismissing a loaded record first attempts the safe unload handshake.
- Remove the record only after the hosted instance is gone.
- A veto, timeout, or unexpected failure leaves the record visible.
- Dismissal never invokes filesystem deletion.

### Reopen

- Clicking a dormant row lazily creates the hosted instance without changing
  its desired-loaded state.
- Clicking an unloaded row sets desired-loaded and creates the hosted instance.
- Creation is idempotent if another open is already in flight.
- Successful readiness transitions follow the existing Restored handshake.
- A missing directory produces a recoverable error and leaves a dismissible
  row.
- Reopening updates MRU activation metadata but not manual sidebar ordering.

### Shutdown and restore

- Normal application shutdown preserves desired state.
- The configured restore policy eagerly creates the last active, all, or none
  of the previously desired-loaded hosted workbenches.
- Desired-loaded entries not eagerly created appear as dormant rows and load
  on first activation.
- Desired-unloaded entries restore only as sidebar rows.
- The default `active` policy chooses the last selected valid desired-loaded
  workbench, with MRU fallback.
- Restore shares one in-flight promise.
- Project and arbitrary restore entries must not create duplicate instances for
  the same path.

## Upstream compatibility strategy

- Put domain logic, models, state validation, and UI composition under
  `src/vs/hucode/` whenever layer rules allow it.
- Use Hucode-named same-layer companions when generic workbench or platform
  code cannot import from `src/vs/hucode/`.
- Keep upstream host-service changes to thin feature detection, service
  injection, and delegation.
- Add new optional persisted fields rather than changing upstream workspace or
  window-state meanings.
- Do not rename the existing Hucode `worktreePath` restore fields in the same
  change.
- Keep project manager APIs and stored project JSON unchanged.
- Prefer shared pure state models plus desktop/web adapters over duplicated
  lifecycle policy.
- Update Hucode architecture and agent instructions when the old rule that
  unknown folders open in normal windows is intentionally replaced.

## Implementation phases

### Phase 0 - Approve decisions

Goal: settle behavior that changes architecture or user expectations.

- [x] Approve this plan.
- [x] Confirm per-Omni-window catalog ownership.
- [x] Confirm single-folder-only scope.
- [x] Confirm existing standalone/hosted ownership is focused, not duplicated.
- [x] Confirm both section headers are collapsible.
- [x] Confirm Workbenches defaults above Projects with persistent reordering.
- [x] Confirm arbitrary workbench drag-and-drop ordering is persisted.
- [x] Confirm desktop and serve-web share startup restore behavior.
- [x] Confirm promoted workbenches are removed from the arbitrary catalog.
- [x] Confirm loaded workbenches expose safe Dismiss in the context menu.
- [x] Confirm quick pickers, last-active, and all next/previous variants include
      arbitrary workbenches.
- [x] Confirm `hucode.omni.restoreHostedWorkbenches` with `active`, `all`, and
      `none`, defaulting to `active` and applying to all hosted workbenches.
- [x] Confirm section collapse state persists per Omni window across restart.
- [x] Create the feature branch and matching `.changes` fragment when
      implementation begins.

Exit criteria:

- all blocking product decisions above are settled and recorded in the
  decision log.

### Phase 1 - Shared contracts and state model

Goal: represent retained arbitrary workbenches independently of live views.

- [x] Add retained-workbench common contracts with JSDoc.
- [x] Add catalog normalization, deduplication, manual ordering, mutation, and
      serialization.
- [x] Add public shell state for retained records.
- [x] Add desired-state transition helpers.
- [x] Add a pure shared eager/dormant restore scheduler.
- [x] Add malformed and legacy-state adoption helpers.
- [x] Add focused common/Node unit tests.
- [x] Add new targeted tests to Hucode CI when needed.

Exit criteria:

- the pure models cover add, reuse, reorder, unload, dismiss, dormant
  projection, restore policy selection, corruption, and duplicate handling
  without Electron or DOM dependencies.

### Phase 2 - Desktop persistence and lifecycle

Goal: make retained entries durable and operable in desktop Omni windows.

- [x] Add the optional native window configuration field.
- [x] Carry it through Omni open plans.
- [x] Serialize and restore it in `WindowsStateHandler`.
- [x] Hydrate the catalog before resident restore.
- [x] Adopt existing project-less resident entries.
- [x] Implement retain/open, unload, dismiss, and reopen controller operations.
- [x] Implement catalog reorder operations and persistence.
- [x] Preserve dirty-state veto and shutdown invariants.
- [x] Keep active/MRU selection coherent after unload and dismiss.
- [x] Apply the shared eager-restore policy and expose non-eager entries as
      dormant.
- [x] Add main/renderer IPC methods and update local service subsets.
- [x] Add Electron-main controller and window-state tests.

Exit criteria:

- loaded, dormant, explicitly unloaded, and manually ordered arbitrary
  workbenches survive a desktop restart with the correct state.

### Phase 3 - Serve-web parity

Goal: expose the same retained lifecycle in the web Omni shell.

- [x] Add an injectable web catalog persistence adapter.
- [x] Hydrate retained records during web shell startup.
- [x] Apply the shared eager-restore policy when the host surface is available.
- [x] Show non-eager desired-loaded records as dormant without iframes.
- [x] Keep desired-unloaded records without iframes.
- [x] Implement unload and dismiss with the existing workbench handshake.
- [x] Handle refresh and malformed storage while retaining missing folders.
- [x] Add browser controller tests.

Exit criteria:

- page refresh preserves catalog order and desired state, eagerly restores only
  the configured subset, and leaves the other desired-loaded workbenches
  dormant.

### Phase 4 - Combined sidebar model and UI

Goal: present Workbenches and Projects as distinct, usable sections.

- [x] Add the pure combined sidebar model.
- [x] Add Workbenches and Projects section rows with Workbenches first by
      default, persisted header drag ordering, and plus actions.
- [x] Make both section rows collapsible and preserve expansion view state.
- [x] Preserve Pinned/Unpinned project rendering.
- [x] Add two-line arbitrary workbench rows.
- [x] Add active/loading/loaded/dormant/unloaded/crashed presentation; missing
      folders remain retained and surface their open failure.
- [x] Add workbench selection, open, unload, dismiss, and standalone actions.
- [x] Add persisted drag-and-drop sorting within Workbenches.
- [x] Generalize selection and in-session history targets.
- [x] Generalize the full switch picker to project and arbitrary targets.
- [x] Generalize the loaded quick switcher to every live hosted target.
- [x] Generalize last-active and all loaded/unloaded next/previous commands.
- [x] Preserve legacy command IDs and keybindings while renaming visible
      commands to Workbench terminology.
- [x] Update accessibility labels and keyboard behavior.
- [x] Update empty-state and host-surface wording.
- [x] Add model tests and lower-level command tests.

Exit criteria:

- every retained record is reachable, correctly classified, and operable from
  the sidebar, quick pickers, and adjacent navigation without duplicate
  project/workbench targets.

### Phase 5 - Folder-open routing

Goal: retain unknown folders opened from Omni contexts.

- [x] Extract or extend the shared Hucode folder-open decision helper.
- [x] Route desktop unknown folder opens into retained workbenches.
- [x] Add equivalent browser host routing for serve-web.
- [x] Preserve all explicit new-window and special open modes.
- [x] Preserve project worktree recency updates.
- [x] Handle existing normal-window ownership according to the approved policy.
- [x] Add desktop and browser host routing tests.

Exit criteria:

- File -> Open Folder from an Omni shell or hosted workbench produces the
  approved hosted behavior on desktop and serve-web.

### Phase 6 - Documentation, validation, and release readiness

Goal: close behavior gaps and produce reviewable evidence.

- [x] Update `docs/hucode/architecture.md`.
- [x] Update `docs/hucode/agent-instructions.md` with new routing and lifecycle
      invariants.
- [x] Update `docs/hucode/roadmap.md` when the feature is complete.
- [x] Document the startup restore setting, values, default, and desktop/web
      parity.
- [x] Add a matching `.changes` fragment before opening a feature PR.
- [x] Run focused common, browser, Electron-main, and host tests.
- [x] Run type checking, layer validation, Hucode compile, and precommit.
- [x] Manually validate desktop behavior with a fresh profile.
- [x] Manually validate serve-web behavior and refresh restore.
- [x] Capture screenshots or a short recording for visual review.
- [x] Record exact validation results in this document.

Exit criteria:

- automated gates pass, manual acceptance criteria pass, documentation matches
  behavior, and the plan tracker has no unexplained incomplete items.

### Phase 7 - Follow-up sidebar and restore refinements

Goal: make lifecycle state, density, section ordering, and missing-folder
behavior consistent across desktop and serve-web.

- [x] Project worktrees use pause for dormant and circle for unloaded state.
- [x] Workbench and project-worktree row layouts have independent settings.
- [x] The Settings editor has a top-level Hucode category for `hucode.*`.
- [x] Section header action padding remains stable across hover.
- [x] Section headers support persisted drag ordering with Workbenches first by
      default.
- [x] Quick pickers and previous/next navigation use persisted section order.
- [x] Serve-web preflights restored and explicitly opened folders before iframe
      creation, retaining missing arbitrary folders as dismissible records.
- [x] Document browser cross-tab ownership as an accepted platform limitation.
- [x] Add migration, order, lifecycle-icon, and folder-preflight tests.

Exit criteria:

- focused compilation, common tests, browser controller tests, and precommit
  hygiene pass before the follow-up patch is handed to final review.

## Automated test plan

### Common state tests

Add coverage for:

- empty catalog;
- add and stable ID assignment;
- duplicate add by equivalent path;
- case-sensitive and case-insensitive path behavior;
- manual reorder and compact order normalization;
- activation recency does not change manual order;
- mark loaded/unloaded;
- desired-loaded without live state projects as dormant;
- dismiss;
- MRU activation selection independent of manual display order;
- `active`, `all`, and `none` restore scheduler selection;
- active candidate fallback when the persisted selection is invalid or
  explicitly unloaded;
- dormant project candidates survive repeated snapshot serialization;
- malformed record filtering;
- legacy project-less resident adoption;
- serialized round trip;
- project promotion removes the arbitrary record;
- project promotion waits for authoritative project hydration;
- missing and crashed projection.

### Sidebar model tests

Add coverage for:

- default Workbenches-then-Projects ordering and persisted Projects-first
  ordering;
- empty sections remain visible;
- collapsed sections preserve their view state;
- pinned/unpinned project ordering is unchanged;
- arbitrary basename and home-relative description;
- workbench stable handle uses record ID;
- active, loading, loaded, dormant, unloaded, crashed, and missing states;
- dormant and explicitly unloaded project worktree states are distinct;
- no duplicate row for a matching project worktree;
- project promotion removes the retained workbench row and catalog record;
- project association with a missing worktree retains existing missing-row
  behavior;
- drag reorder persists and does not cross section boundaries;
- unloaded workbench remains selectable and reopenable.

### Navigation and quick-pick model tests

Add coverage for:

- combined logical order is manual Workbenches order followed by existing
  Projects order;
- collapsed sections retain their targets in next/previous navigation;
- the full picker includes project, loaded, dormant, and explicitly unloaded
  arbitrary targets;
- the loaded quick switcher includes only live project and arbitrary targets;
- Current, Loaded, Dormant, and Not Loaded grouping preserves relative logical
  order;
- arbitrary basename, home-relative path, and full path are searchable;
- previous/next wraps across the Workbenches/Projects boundary;
- previous/next loaded skips dormant and explicitly unloaded targets;
- last-active selection works when the target is arbitrary;
- opening a dormant or unloaded target performs the correct lazy/load
  transition;
- hosted-workbench commands forward to the owning Omni shell;
- standalone windows retain existing project-only inputs;
- legacy command IDs and keybindings invoke generalized behavior.

### Desktop controller tests

Add coverage for:

- retain and open without project ID;
- unload keeps catalog record and removes native view;
- unload veto keeps view and desired-loaded state;
- dismiss unloaded record;
- dismiss loaded record after successful unload;
- dismiss veto retains record;
- active unload promotes MRU resident workbench;
- last unload leaves sidebar reachable;
- restart restores loaded records and preserves unloaded records;
- default startup eagerly restores only the last selected valid workbench;
- other desired-loaded workbenches remain dormant until activated;
- dormant project restore candidates survive another restart without
  activation;
- `all` and `none` restore policies create the expected set;
- restore policy applies consistently to project and arbitrary candidates;
- missing folder restore remains dismissible;
- integrated browser views are destroyed on unload;
- app quit preserves desired state.

### Serve-web controller tests

Add equivalent coverage for:

- iframe creation and reuse;
- unload handshake;
- unload/dismiss distinction;
- persistence hydration;
- refresh restore;
- `active`, `all`, and `none` eager-restore policies;
- dormant desired-loaded entries load on first activation;
- desired-unloaded entries create no iframe;
- missing directory/error handling where the browser/server boundary permits
  validation.

### Open-routing tests

Update desktop tests and add browser-host tests for:

- known project folder opens project-aware hosted workbench;
- unknown folder creates retained arbitrary workbench;
- unloaded retained folder reopens existing record;
- already loaded folder activates existing instance;
- force-new-window bypasses retention;
- workspace files remain standalone;
- add/remove/diff/merge/goto/wait modes remain upstream behavior;
- normal-window ownership follows the approved policy;
- Workbenches plus focuses an existing standalone or hosted owner without
  retaining a duplicate;
- non-Omni windows remain unchanged.

### Persistence tests

Add coverage for:

- native window-state serialization and restore;
- absent new field;
- malformed individual entries;
- duplicate records;
- manual order round trip;
- loaded/unloaded desired-state round trip;
- dormant projection and repeated refresh/restart behavior;
- old project-less resident entry adoption.

## Manual acceptance checklist

### Desktop

- [x] Launch a clean Omni window with no projects or workbenches.
- [x] Verify Workbenches defaults above Projects and both plus actions are
      visible.
- [ ] Drag Projects above Workbenches, restart, and verify the order persists.
- [x] Collapse and expand both sections and verify their view state is kept.
- [ ] Add a Git project and confirm current project behavior is unchanged.
- [x] Add a non-Git directory as a workbench.
- [x] Verify basename and `~/...` secondary path.
- [ ] Add a Git repository that is not a saved project and confirm it remains a
      Workbench.
- [ ] Switch between multiple project worktrees and arbitrary workbenches.
- [ ] Open Switch Workbench and verify project, loaded, dormant, and unloaded
      arbitrary targets appear with the correct grouping and search fields.
- [ ] Select dormant and unloaded entries from the full picker and verify they
      load and activate.
- [ ] Open Quick Switch Loaded Workbench and verify it includes live project
      and arbitrary targets but excludes dormant and unloaded entries.
- [ ] Verify Previous/Next Workbench follows the persisted section order,
      wraps, and loads non-live targets.
- [ ] Verify Previous/Next Loaded Workbench follows the same order while
      skipping dormant and unloaded targets.
- [ ] Verify Last Active Workbench switches correctly across project and
      arbitrary targets.
- [ ] Invoke navigation from a hosted workbench and verify it forwards to the
      owning Omni shell.
- [x] Reorder multiple workbenches by drag-and-drop and verify activation does
      not reorder them.
- [ ] Verify in-session back/forward navigation.
- [x] Unload an arbitrary workbench and confirm the process/view is gone while
      its row remains.
- [x] Click the unloaded row and confirm it reloads.
- [x] Unload it again, press X, and confirm only the sidebar record disappears.
- [ ] Attempt unload with dirty state and verify a veto retains loaded state.
- [ ] Dismiss a loaded dirty workbench and verify a veto retains the record.
- [x] Restart Hucode with the default policy and verify the last selected
      workbench loads while other previously loaded workbenches appear dormant.
- [x] Activate a dormant workbench and verify it loads on demand.
- [ ] Leave a dormant project worktree unactivated across another restart and
      verify it remains a dormant restore candidate.
- [ ] Verify `all` and `none` startup restore policies.
- [ ] Verify explicit unload remains visually distinct and never eagerly
      restores.
- [ ] Verify manual ordering survives restart.
- [ ] Delete an unloaded folder externally and verify the row remains
      dismissible with useful feedback.
- [ ] Add the workbench folder as a project and verify there is no duplicate.
- [ ] Remove that project and verify the former arbitrary record does not
      reappear automatically.
- [ ] Select a folder already open in a standalone window or hosted workbench
      and verify the existing owner is focused without retaining a duplicate.
- [ ] Use Open in New Window and verify the standalone transition is safe.
- [ ] Verify explicit Open Folder in New Window remains standalone.

### Serve-web

- [ ] Repeat add, switch, unload, reopen, and dismiss flows.
- [ ] Repeat full picker, loaded quick switcher, last-active, and next/previous
      navigation across project and arbitrary targets.
- [x] Refresh the Omni shell and verify catalog persistence.
- [x] Verify the default policy restores only the last selected iframe and
      presents other desired-loaded workbenches as dormant.
- [ ] Verify `all` and `none` restore policies match desktop behavior.
- [x] Activate a dormant row and verify its iframe is created on demand.
- [ ] Verify desired-unloaded workbenches remain rows without iframes.
- [ ] Verify manual order survives page refresh.
- [ ] Verify browser-host Open Folder routing enters the Omni catalog.
- [ ] Verify regular `/workbench` behavior remains upstream-compatible.

### Visual and accessibility

- [ ] Verify two-line workbench rows at minimum sidebar width.
- [ ] Verify long folder names and long home-relative paths ellipsize cleanly.
- [ ] Verify tooltips contain the full path.
- [ ] Verify dormant and explicitly unloaded rows are visually distinguishable.
- [ ] Verify Dark, Light, and a theme with sidebar section borders.
- [ ] Verify keyboard navigation skips or handles section rows correctly.
- [ ] Verify plus, unload, and dismiss actions have accessible names.
- [ ] Verify active and focus states remain distinguishable.

## Validation commands

Record exact final commands and results in the validation log. Expected gates
include:

```sh
npm run typecheck-client
cd build && npm run typecheck
npm run valid-layers-check
npm run hucode:compile
```

Run each focused Node test file in its own invocation because the repository
test wrapper accepts one file per `--run` invocation.

Run targeted Electron tests without inherited integrated-workbench Electron or
`VSCODE_*` variables, and do not run them concurrently with compilation or
another `scripts/test.sh` invocation.

After edits, run the repository precommit path for every changed file:

```sh
npm run -s precommit -- <changed paths>
```

## Anticipated file areas

This list is directional, not authorization to modify every file listed.

Hucode-owned common and UI areas:

- `src/vs/hucode/common/omniWindow.ts`
- `src/vs/hucode/common/hostedWorkspaceState.ts`
- `src/vs/hucode/common/projectSwitcher/`
- `src/vs/hucode/common/projectSwitcher/switchProjectWorktreeModel.ts`
- a new Hucode-owned combined sidebar model/state directory
- `src/vs/hucode/browser/projectSwitcher/`
- `src/vs/hucode/browser/projectSwitcher/switchProjectWorktree.contribution.ts`
- `src/vs/hucode/browser/parts/projectsPart.ts`
- `src/vs/hucode/browser/parts/omniHostPart.ts`
- `src/vs/hucode/browser/hostedOmniWorkspace.contribution.ts`
- `src/vs/hucode/browser/webShellService.ts`
- `src/vs/hucode/electron-main/shellMainService.ts`
- `src/vs/hucode/electron-main/hostedWorkspacesController.ts`

Thin upstream integration and same-layer Hucode companions:

- `src/vs/platform/window/common/window.ts`
- `src/vs/platform/windows/electron-main/windowsStateHandler.ts`
- `src/vs/workbench/services/host/electron-browser/hucodeOmniOpen.ts`
- `src/vs/workbench/services/host/electron-browser/nativeHostService.ts`
- a browser-host Hucode companion near
  `src/vs/workbench/services/host/browser/browserHostService.ts`

Tests and CI:

- `src/vs/hucode/test/common/`
- `src/vs/hucode/test/browser/`
- `src/vs/hucode/test/electron-main/`
- `src/vs/workbench/services/host/test/`
- `src/vs/platform/windows/test/electron-main/`
- `.github/workflows/hucode-ci.yml`

Documentation and release metadata:

- `docs/hucode/architecture.md`
- `docs/hucode/agent-instructions.md`
- `docs/hucode/roadmap.md`
- `.changes/*.md`

## Risks and mitigations

### Dirty-state data loss

Risk: dismiss removes the catalog entry even though hosted unload was vetoed or
timed out.

Mitigation: compose dismissal through the existing unload handshake and remove
the record only after the instance is absent from returned state.

### Duplicate project and workbench rows

Risk: a retained arbitrary folder later becomes a saved project worktree.

Mitigation: centralize classification in the pure combined sidebar model and
catalog reconciliation, remove the arbitrary record on promotion, and test
exact-path deduplication.

### Restore duplication

Risk: catalog desired-loaded records and existing resident restore entries both
create the same hosted instance.

Mitigation: hydrate the catalog first, normalize by path, and run one serialized
restore scheduler through the existing in-flight restore promise and configured
eager-restore policy.

### Manual order corruption

Risk: interrupted or conflicting drag operations persist duplicate or sparse
order values.

Mitigation: reorder by stable record IDs, validate catalog membership, compact
the full order deterministically, and test malformed persisted order repair.

### Dormant/unloaded state confusion

Risk: users cannot tell a workbench that will lazily load from one they
explicitly unloaded, or implementation code accidentally eagerly restores the
latter.

Mitigation: derive both states centrally from desired state plus live state,
use distinct icons/ARIA labels, and test all three restore policies in desktop
and serve-web.

### Navigation behavior drift

Risk: sidebar, quick picker, and next/previous commands build separate target
orders or disagree about loaded versus dormant state.

Mitigation: project every navigation surface from the same neutral combined
target model and test ordering, filtering, wrapping, and lazy activation as
pure behavior.

### Command and keybinding compatibility

Risk: renaming project-oriented navigation commands breaks user keybindings,
menus, or forwarded hosted-workbench commands.

Mitigation: preserve existing command and quick-navigation IDs and keybindings,
generalize their handlers, and change only user-facing titles and neutral
internal model names.

### Upstream replay conflicts

Risk: broad edits to generic host and window services become expensive during
VS Code upgrades.

Mitigation: additive optional fields, Hucode-owned policy, same-layer
Hucode-named helpers, and minimal generic integration hooks.

### Desktop/web behavior drift

Risk: desktop supports retained unload and lazy restore while serve-web loses
records or uses different action and restore semantics.

Mitigation: shared contracts and state model, adapter-specific persistence and
view operations, and mirrored controller tests.

### Path identity limits future remote work

Risk: a new path-only catalog repeats the current authority-collision problem.

Mitigation: store URI components and stable record IDs now, while allowing the
initial live controller to remain local-path-based.

### Crash restore loops

Risk: a repeatedly crashing workbench is automatically recreated every launch.

Mitigation: persist a crashed workbench as desired-unloaded after the crash,
retain its row, and require an explicit click to retry.

## Review questions

No product or architecture decisions remain open for the initial
implementation.

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-07-17 | Use separate Projects and Workbenches sections | Projects and arbitrary workbenches have different persistence and actions |
| 2026-07-17 | Workbenches are folder-first, not empty workbenches | Reuses the existing single-folder hosted-workbench architecture |
| 2026-07-17 | Unload retains arbitrary workbench entries | Resource release must be distinct from sidebar removal |
| 2026-07-17 | Dismiss is the explicit removal operation | Avoids overloading close/unload terminology |
| 2026-07-17 | Keep arbitrary catalog outside the project manager | Prevents Git-specific services and records from becoming a generic workspace registry |
| 2026-07-17 | Persist loaded and unloaded desired state | Explicit unload must survive restart and remain reopenable |
| 2026-07-17 | Use URI-shaped identity for new retained records | Preserves a path toward future remote-authority support |
| 2026-07-17 | Render Workbenches above Projects | The smaller transient list remains easy to reach above a potentially long project list |
| 2026-07-17 | Persist manual workbench drag order | Activation recency should not unexpectedly rearrange user organization |
| 2026-07-17 | Make both top-level sections collapsible | Users can reclaim space from either list |
| 2026-07-17 | Focus an existing folder owner | Avoids duplicate standalone or hosted workbenches for one folder |
| 2026-07-17 | Remove arbitrary records promoted to projects | Avoids hidden duplicate ownership and restore-state synchronization |
| 2026-07-17 | Allow safe loaded-state dismissal | Provides a direct context action while retaining dirty-state protection |
| 2026-07-17 | Default to active-only eager restore | Restores the last selected workbench promptly while deferring other renderer cost until activation |
| 2026-07-17 | Generalize all workbench navigation | Sidebar-only support would leave quick pickers, last-active, and next/previous feeling incomplete |
| 2026-07-17 | Preserve navigation command IDs | Existing user keybindings and hosted-command forwarding must keep working after visible renames |
| 2026-07-17 | Finalize `hucode.omni.restoreHostedWorkbenches` | `active`, `all`, and `none` provide explicit resource-restoration control with `active` as the balanced default |
| 2026-07-17 | Apply restore policy to every hosted workbench | Project and arbitrary workbenches should not have conflicting startup resource behavior |
| 2026-07-17 | Persist section collapse per Omni window | Sidebar organization should survive reopening the same Omni window |
| 2026-07-17 | Persist draggable top-level section order | Users can choose Projects first while keeping Workbenches first as the default |
| 2026-07-17 | Configure workbench and worktree density independently | Transient folder paths and project branch metadata have different space needs |
| 2026-07-17 | Keep serve-web tab ownership browser-local | VS Code web has no cross-tab workspace registry or reliable tab-focus API |
| 2026-07-17 | Preflight folders in the Omni shell | Missing folders remain recoverable without launching a broken hosted workbench |

## Implementation log

Add dated entries as implementation progresses.

| Date | Phase | Change | Evidence or follow-up |
| --- | --- | --- | --- |
| 2026-07-17 | Planning | Initial plan written | Awaiting review; no implementation started |
| 2026-07-17 | Planning | Incorporated first review decisions | Added ordering, drag sorting, collapsibility, promotion, ownership, dismissal, and lazy restore behavior |
| 2026-07-17 | Planning | Expanded navigation scope | Added arbitrary workbenches to full/loaded pickers, last-active, and all next/previous variants |
| 2026-07-17 | Planning | Plan approved and frozen | Remaining restore-setting and collapse-state recommendations accepted for implementation |
| 2026-07-17 | 1-3 | Added retained catalogs and lifecycle parity | Shared scheduler plus desktop window state and serve-web profile persistence |
| 2026-07-17 | 4 | Built combined sidebar and navigation | Workbenches-first sections, DnD ordering, lifecycle actions, and combined switch commands |
| 2026-07-17 | 5 | Routed arbitrary folders into Omni | Desktop and browser host paths preserve special and explicit new-window modes |
| 2026-07-17 | 6 | Added focused coverage and documentation | CI includes new common and browser routing suites; architecture and agent invariants updated |
| 2026-07-17 | QA hardening | Preserved top-level section collapse across startup selection | Tree synchronization events are ignored and active-target reveal does not expand an intentionally collapsed section |
| 2026-07-17 | Review hardening | Closed lifecycle, ownership, restore, and promotion gaps | Failed desktop loads now publish coherent state; restore policy is configured before main-side restore; retained standalone opens release hosted ownership; navigation canonicalizes promoted folders; missing desktop folders surface a warning state; persistence migrations and cross-window guards have focused coverage |
| 2026-07-17 | Follow-up refinement | Added configurable row density, draggable section order, project lifecycle icons, Hucode Settings TOC, stable header actions, and serve-web missing-folder preflight | Focused compile, 48 common tests, 28 browser tests, and precommit pass |
| 2026-07-18 | Review/CI hardening | Corrected serve-web remote folder preflight and stale dormant cleanup; preserved standalone picker MRU ordering; deduplicated promoted navigation history; completed focused CI registration and fixture updates | Focused type, compile, layer, common, browser, and Electron suites pass locally; final orchestrator review and CI remain pending |
| 2026-07-18 | Final review hardening | Guarded async web and desktop activation races, moved desktop missing-folder checks before view creation, preserved remote native routing, and tightened picker, DnD, rendering, and stale-state behavior | Typecheck, full compile, layers, 16 common tests, 98 focused Electron tests, and hygiene pass in the feature worktree |
| 2026-07-18 | Relaunch hardening | Preserved the pre-shutdown resident project snapshot during hosted-view teardown; coalesced same-folder opens; protected unloads from reactivation; canonicalized Workbenches-plus project targets; excluded virtual folders from Omni browser routing | 118 focused Electron/browser tests pass; a two-restart desktop QA run restored the arbitrary workbench active and rendered the previously loaded project worktree with the pause icon |

## Validation log

Add exact commands, results, runtime observations, and links to CI here.

| Date | Scope | Command or validation | Result |
| --- | --- | --- | --- |
| 2026-07-17 | Type and layer checks | `npm run typecheck-client`; `npm run valid-layers-check` | Pass |
| 2026-07-17 | Build | `npm run hucode:prepare`; `npm run hucode:validate`; `npm run hucode:compile` | Pass |
| 2026-07-17 | Common tests | Focused retained catalog, hosted state, tree model, switch model, and Omni open plan | 50 tests pass |
| 2026-07-17 | Browser tests | Browser routing and serve-web shell controller | 39 tests pass in Chromium; 25 web-shell tests pass after final focus-race fix |
| 2026-07-17 | Desktop tests | Hosted controller, desktop routing, and window-state persistence | 49 tests pass |
| 2026-07-17 | Collapse persistence regression | Focused tree-model suite plus two consecutive desktop restarts | 13 tests pass; collapsed Workbenches state remains persisted and rendered after restart |
| 2026-07-17 | Desktop manual visual review | Fresh isolated desktop profile under Xvfb, driven through CDP | Pass: add two folders, two-line rows, drag reorder, unload-retain, reopen, dismiss, active/dormant restore, quick picker, previous navigation, and collapse persistence |
| 2026-07-17 | Serve-web manual visual review | Fresh browser profiles against local `hucode:web`, driven with `agent-browser` | Pass after fixing delayed hidden-iframe focus: second add activates, refresh produces active/dormant states, dormant activation works, quick picker includes both targets, and collapsed Workbenches state survives refresh; screenshots retained under `.build/manual-qa/omni-workbenches-web/` |
| 2026-07-17 | Review-round type check | `npm run typecheck-client` | Pass |
| 2026-07-17 | Follow-up compile and layers | `npm run typecheck-client`; `npm run gulp compile-client`; `npm run valid-layers-check` | Pass with zero TypeScript or layer errors |
| 2026-07-17 | Follow-up common tests | Four focused `npm run test-node -- --run ...` invocations for hosted state, tree model, view state, and switch model | 48 tests pass |
| 2026-07-17 | Follow-up browser tests | `xvfb-run -a ./scripts/test.sh --no-sandbox --grep WebHucodeShellService` | 28 tests pass |
| 2026-07-17 | Follow-up hygiene | `npm run -s precommit -- <edited paths>` | Pass |
| 2026-07-18 | Review/CI hardening checks | `npm run typecheck-client`; `npm run gulp compile-client`; `npm run valid-layers-check` | Pass with zero TypeScript, compile, or layer errors |
| 2026-07-18 | Review/CI hardening common tests | `npm run test-node -- --run src/vs/hucode/test/common/projectSwitcher/switchProjectWorktreeModel.test.ts` | 16 tests pass |
| 2026-07-18 | Review/CI hardening browser tests | Focused `WebHucodeShellService` and `OmniSelectionOpen` Electron invocations | 31 and 11 tests pass |
| 2026-07-18 | Review/CI hardening desktop tests | Focused `ResidentHostedWorkspacesController` Electron invocation | 41 tests pass |
| 2026-07-18 | Review/CI hardening hygiene | `npm run -s precommit -- <edited paths>`; `git diff --check` | Pass |
| 2026-07-18 | Final review validation | `typecheck-client`; `compile-client`; `valid-layers-check`; focused common and Electron suites; changed-file precommit; `git diff --check` | Pass: 16 common and 98 Electron tests; local Electron run used `ELECTRON_DISABLE_SANDBOX=1` because the downloaded helper could not be root-owned without interactive sudo |
| 2026-07-18 | Relaunch regression validation | `typecheck-client`; `compile-client`; `valid-layers-check`; `hucode:validate`; changed-file precommit; focused lifecycle, routing, and selection suites | Pass: 118 Electron/browser tests; desktop restart persisted the inactive project as loaded and rendered `codicon-debug-pause` while restoring the arbitrary workbench active |

## Completion criteria

The feature is complete only when:

- Workbenches and Projects render as distinct collapsible sections with
  separate plus actions, default Workbenches-first ordering, and persisted
  header drag ordering;
- workbench drag order persists independently of activation recency;
- arbitrary folders can be retained and opened as hosted workbenches;
- unload releases resources without removing the sidebar entry;
- dormant desired-loaded rows are visually distinct from explicitly unloaded
  rows and load on first activation;
- unloaded rows reopen on click;
- dismiss removes only the catalog entry and never deletes files;
- dirty-state vetoes preserve both loaded instance and retained entry;
- loaded, dormant, unloaded, and ordered state persists across desktop restart
  and serve-web refresh;
- the configured `active`, `all`, or `none` eager-restore policy behaves the
  same in desktop and serve-web;
- generic folder opens follow the approved Omni routing policy;
- existing standalone or hosted folder owners are focused without duplicates;
- project promotion removes the arbitrary catalog record;
- full and loaded quick pickers, last-active, and next/previous commands include
  the appropriate project and arbitrary targets;
- legacy navigation command IDs and keybindings remain compatible;
- automated and manual validation passes;
- documentation and `.changes` metadata are complete;
- this progress tracker reflects the final implementation and residual risks.
