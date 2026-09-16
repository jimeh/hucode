---
title: Global Arbitrary Workbench Catalog Plan
status: proposed implementation
last_updated: 2026-09-16
---

# Global Arbitrary Workbench Catalog Plan

## Document purpose

This document plans the move from per-Omni-session arbitrary-workbench
catalogs to one persisted global catalog shared by every desktop Omni window
and every serve-web Omni tab.

The plan preserves the existing boundary between global navigation data and
session-local hosted-workbench lifecycle. It is detailed enough for an
implementer to change the storage schema, service contracts, desktop and web
adapters, migration paths, UI projection, tests, and current documentation
without reconstructing the design from discussion history.

## Independent review corrections

Independent reviews checked this plan against the current project-manager,
desktop shell, window-state, serve-web, sidebar, and test implementations. The
following corrections are incorporated as requirements:

- retain stored schema version 1 with an optional workbench field so a
  downgraded build does not erase projects or quarantine `projects.json`;
- migrate both legacy retained arrays and project-less resident workspace
  entries;
- define retryable serve-web startup behavior when the catalog or legacy import
  is unavailable;
- make ensure-workbench results distinguish saved workbenches from project
  worktrees and make the final desktop insertion atomic;
- use relative move semantics for global reordering;
- join cross-window session overlays against the global catalog;
- deliver the controller split and both platform feeds as one compatibility
  tranche; and
- treat current-worktree promotion gating as new behavior and scope durable
  write-publication guarantees to serve-web;
- isolate malformed optional workbench data from valid project records;
- define legacy bulk-import metadata, conflict, and ID-remapping semantics;
- revision HTTP and SSE snapshots against out-of-order delivery; and
- retry orphan adoption without resurrecting globally dismissed workbenches.

## Intended outcome

After this work:

- adding an arbitrary workbench saves it once for the Hucode installation or
  serve-web server;
- every Omni window or tab shows the same saved arbitrary workbench list;
- closing a window or tab does not lose that list;
- labels and manual ordering are global, like saved projects;
- each Omni session still chooses independently which saved workbenches are
  loaded, active, dormant, or explicitly unloaded;
- a folder represented by a project worktree has one project-owned catalog
  entry, never a duplicate arbitrary-workbench entry; and
- desktop and serve-web use the same domain model while retaining their
  platform-specific persistence and hosted-renderer implementations.

## Scope

This plan covers:

- adding arbitrary workbenches to the state owned by
  `IProjectManagerService`;
- splitting globally persisted workbench metadata from per-session lifecycle
  state;
- publishing one coherent project-and-workbench catalog snapshot;
- extending desktop IPC and serve-web HTTP/SSE transport for workbench catalog
  reads and mutations;
- reconciling project worktrees and arbitrary workbenches inside the global
  catalog authority;
- migrating existing desktop window state and serve-web session storage;
- preserving desktop live-path ownership and serve-web tab-local ownership;
- adapting sidebar, switcher, lifecycle, and restore callers; and
- adding focused automated and runtime verification.

This plan does not cover:

- making live hosted workbench ownership global on serve-web;
- remotely unloading a workbench in another browser tab or Omni window;
- adding server-side renderer leases, Web Locks, or cross-tab messaging;
- multi-root workspaces, `.code-workspace` files, empty workbenches, or new
  remote-authority behavior;
- changing project creation or Git worktree operations beyond the catalog
  reconciliation needed by this change;
- synchronizing the catalog through Settings Sync; or
- changing workbench-row visuals except where a session-only live row needs a
  clear transient presentation after global removal.

## Terminology

- **Global catalog**: the persisted set of projects and arbitrary workbenches
  shared by all Omni sessions connected to the same desktop installation or
  serve-web server.
- **Arbitrary workbench**: a saved single-folder entry not currently
  represented by a project worktree.
- **Session overlay**: one Omni window or tab's lifecycle intent and runtime
  status for a global arbitrary workbench.
- **Hosted instance**: a live desktop `WebContentsView` or serve-web iframe.
- **Session-only workbench**: a still-live hosted instance whose global
  arbitrary-workbench entry was removed by another session. It remains usable
  until unloaded, but is not restored or silently re-added.
- **Promotion**: replacing an arbitrary-workbench catalog entry with project
  ownership after the folder becomes a known project worktree.
- **Adoption**: saving a still-live former project worktree as an arbitrary
  workbench after its project is removed.

## Current behavior and constraints

### Global project catalog

`ProjectManagerMainService` owns saved projects, discovered worktrees,
project ordering, labels, pins, and last-active worktree metadata. Desktop
stores this state under `hucode.projectManager.projects`. Serve-web stores the
same schema in `<server-data-dir>/hucode/projects.json` and publishes project
changes to connected clients over the existing event stream.

The persisted schema is currently version 1 and contains only `projects`.
`loadStoredProjectManagerState()` treats an unknown version as empty, and the
serve-web file adapter quarantines a structurally unknown state as corrupt.
The combined catalog must therefore remain version 1 and add an optional
`workbenches` field. An older build may drop that new field if it writes the
state, but it continues to preserve projects instead of replacing or
quarantining the complete catalog during a downgrade.

### Per-session arbitrary-workbench catalog

`RetainedWorkbenchCatalog` currently owns a complete arbitrary-workbench
record inside each shell controller. `IOmniRetainedWorkbench` combines:

- stable identity, folder URI, custom label, and manual order;
- desired loaded or unloaded state;
- missing-folder status; and
- last-active time.

Desktop initializes that catalog from
`INativeWindowConfiguration.omniRetainedWorkbenches` and writes it back into
window restore state. Serve-web loads and saves the same catalog in tab-local
`sessionStorage` alongside resident project workspaces and the active path.

This coupling makes catalog identity per window or tab. It also means the
record cannot be moved unchanged into global storage: an unload or activation
in one session would overwrite every other session's restore intent.

### Catalog reconciliation

The Projects UI currently reads projects from `IProjectManagerService` and
retained workbenches from shell state. It then submits the complete project
catalog to the shell so each controller can remove duplicate retained paths or
adopt live instances whose projects disappeared.

Once both saved lists have one authority, project-to-workbench deduplication
belongs in the project manager. Shell controllers should report only the live
instance facts needed for adoption and maintain their own lifecycle overlays.

### Ownership remains local

Desktop globally arbitrates live paths across regular windows and hosted
workbenches. Serve-web intentionally owns live workbenches within one tab.
Globalizing the saved catalog must not globalize iframe or active-workbench
ownership.

The existing arbitrary-workbench Git observations also remain ephemeral and
consumer-scoped. The global catalog supplies target paths, while each sidebar
connection retains its own bounded monitor registration and cleanup.

## Settled design decisions

1. `IProjectManagerService` becomes the authority for one combined global
   project-and-arbitrary-workbench catalog.
2. A global arbitrary-workbench record contains only stable ID, folder
   identity, optional label, and manual order.
3. Desired state and last-active time remain per session. Missing-folder state
   is runtime observation, not global durable metadata.
4. A saved workbench absent from a session overlay is presented as unloaded in
   that session.
5. Adding a workbench saves it globally and opens it only in the initiating
   session.
6. Renaming, resetting, reordering, and dismissing a saved workbench mutate the
   global catalog and propagate to every session.
7. Unload and suspend remain session-local lifecycle actions.
8. Projects remain authoritative for paths discovered as project worktrees.
   Promotion removes the duplicate arbitrary-workbench record atomically with
   catalog publication.
9. Removing a project retains the current orphan-adoption behavior. Each live
   former project instance asks the global catalog to save its folder, using an
   idempotent path-based operation.
10. Global dismissal first completes the initiating session's safe unload when
    necessary. A veto leaves the global entry intact.
11. Global dismissal does not force-close a live instance in another session.
    That instance becomes session-only until it unloads, and it is not restored
    or silently re-added.
12. The existing project storage key, serve-web `projects.json` path, and
    schema version 1 remain in use. `workbenches` is an optional additive field
    so an older build can still read and preserve projects after downgrade.
13. Legacy imports are idempotent and write the global catalog before removing
    the legacy source, so interruption cannot lose saved folders.
14. Serve-web restores resident project workspaces without waiting for the
    catalog. Arbitrary-workbench restoration waits for the first successful
    global catalog snapshot and retries without treating an unavailable
    catalog as an authoritative empty list.
15. Reordering is a relative move operation, not replacement of the full
    ordered ID set. This keeps a stale client from dropping a concurrently
    added workbench.

## User-visible behavior

| Scenario | Global catalog | Initiating session | Other sessions |
| --- | --- | --- | --- |
| Add `/work/scratch` | Add one record | Open and activate it | Show it unloaded |
| Select a saved workbench | No change | Load or activate it | No change |
| Suspend | No change | Become dormant | No change |
| Unload | No change | Become unloaded | No change |
| Rename or reset label | Update record | Show new label | Show new label |
| Reorder workbenches | Update global order | Show new order | Show new order |
| Close an Omni window/tab | No change | Session state may end | Saved list remains |
| Dismiss an unloaded workbench | Remove record | Remove row | Remove saved row |
| Dismiss a locally loaded workbench | Remove only after successful unload | Unload and remove row | Remove saved row |
| Another session has dismissed workbench loaded | Record stays removed | No special action | Keep a session-only live row until unload |
| Folder becomes project worktree | Remove arbitrary record | Reclassify live instance | Show only project row |
| Project containing a live worktree is removed | Add or reuse arbitrary record | Keep live instance as arbitrary | Show saved workbench unloaded unless locally live |
| Open a fresh Omni session | No change | Show all saved workbenches unloaded | No change |

## Target domain model

### Global records

Add a public runtime record and a persisted record in the project-manager
common layer. Names may be adjusted during implementation to match nearby
conventions, but the ownership split is required.

```ts
export interface ArbitraryWorkbenchRecord {
	readonly id: string;
	readonly folderUri: URI;
	readonly label?: string;
	readonly order: number;
}

export interface StoredArbitraryWorkbenchRecord {
	id: string;
	folderPath: string;
	label?: string;
	order: number;
}

export interface ProjectCatalogSnapshot {
	readonly revision: number;
	readonly projects: readonly ProjectRecord[];
	readonly workbenches: readonly ArbitraryWorkbenchRecord[];
}
```

The current feature supports folder paths only. Persist `folderPath`, matching
stored project roots, and revive it as `URI.file(folderPath)` at the service
boundary. Do not introduce a second client-specific URI encoding into the
server-owned file.

IDs are stable across sessions. Paths are unique under the project manager's
existing platform case-sensitivity rules. Orders are dense, zero-based within
the Workbenches section, and independent of project order.

### Backward-compatible stored state

```ts
export interface StoredProjectManagerState {
	readonly version: 1;
	readonly projects: readonly StoredProjectRecord[];
	readonly workbenches?: readonly StoredArbitraryWorkbenchRecord[];
}
```

The reader:

- preserves the existing version 1 project parsing;
- treats an absent `workbenches` field as an empty workbench list;
- validates, clones, path-deduplicates, and compacts a present workbench list;
- rejects an unknown top-level version without partially accepting the state;
  and
- isolates an invalid `workbenches` field from valid `projects` instead of
  applying the existing whole-file failure policy to the additive field.

On desktop, invalid workbench data loads as an empty workbench list while
valid projects remain available. Serve-web preserves the exact source file as
a corrupt recovery copy, rewrites a clean file containing the valid projects,
and does not start from an empty project catalog. This isolation applies only
when the top-level version and project records are valid; malformed core state
retains the existing fail-safe behavior.

An older build ignores the added property while reading. If that build later
writes the state, it may remove the global workbench list. This downgrade
limitation must be documented in the release notes, but it must not destroy
projects or cause serve-web to quarantine the complete state file.

### Per-session state

Replace catalog ownership in shell controllers with a lifecycle overlay:

```ts
export interface OmniWorkbenchSessionEntry {
	readonly workbenchId: string;
	readonly desiredState: 'loaded' | 'unloaded';
	readonly lastActiveAt?: number;
}
```

Missing-folder status is derived during folder preflight and retained only in
runtime projection. A globally removed workbench with a still-live hosted
instance is represented by the instance itself, not by a durable overlay.

A fresh session does not stat every unloaded saved folder during catalog
hydration. It initially presents an unloaded row without a missing marker and
updates that status after an existing Git observation or open-time folder
preflight supplies evidence. This avoids an unbounded startup stat pass while
preserving the current missing-folder safety before renderer creation.

Desktop window state and serve-web session storage continue to persist:

- active worktree path;
- resident project workspace restore entries; and
- arbitrary-workbench session overlays.

They no longer persist label, order, or the authoritative folder list.

### Public shell projection

`IHucodeHostedWorkspaceState` should expose session facts without presenting
them as the catalog authority. Replace or narrow `retainedWorkbenches` to a
session-oriented projection keyed by global workbench ID.

The sidebar and switcher build their rows from:

```text
ProjectCatalogSnapshot.workbenches
  + current shell session overlays
  + live session-only arbitrary instances
  + consumer-scoped Git observations
```

This keeps catalog events and lifecycle events independent while giving the UI
one deterministic merge point.

## Project-manager contract

Prefer one coherent catalog snapshot over separate project and workbench
events:

```ts
readonly onDidChangeCatalog: Event<ProjectCatalogSnapshot>;

getCatalog(): Promise<ProjectCatalogSnapshot>;
ensureWorkbench(uri: URI): Promise<EnsureWorkbenchResult>;
importWorkbenches(
	entries: readonly LegacyWorkbenchImportRecord[]
): Promise<ImportWorkbenchesResult>;
renameWorkbench(id: string, label: string): Promise<void>;
resetWorkbenchLabel(id: string): Promise<void>;
moveWorkbench(id: string, beforeWorkbenchId?: string): Promise<void>;
removeWorkbench(id: string): Promise<void>;
```

`EnsureWorkbenchResult` is discriminated so callers cannot confuse a saved
workbench with an already project-owned path:

```ts
export type EnsureWorkbenchResult =
	| {
		readonly kind: 'workbench';
		readonly workbench: ArbitraryWorkbenchRecord;
		readonly created: boolean;
	}
	| {
		readonly kind: 'projectWorktree';
		readonly projectId: string;
		readonly worktree: WorktreeRecord;
	};

export interface LegacyWorkbenchImportRecord {
	readonly legacyId: string;
	readonly folderUri: URI;
	readonly label?: string;
	readonly order: number;
}

export interface ImportWorkbenchesResult {
	readonly catalog: ProjectCatalogSnapshot;
	readonly idMappings: readonly {
		readonly legacyId: string;
		readonly workbenchId: string;
	}[];
}
```

During migration, `getProjects()` and `onDidChangeProjects` may remain as
compatibility views over the same authoritative snapshot. Do not maintain two
independently emitted sources of truth. A catalog mutation should result in one
coherent snapshot publication.

`ensureWorkbench()` is idempotent by normalized path:

- return `{ kind: 'workbench', created: false }` when the path is already
  saved;
- return `{ kind: 'projectWorktree' }` for a stored project root or a worktree
  from a `current` discovery snapshot;
- when relevant worktree discovery is stale or unavailable, permit a saved
  workbench and let the next authoritative current refresh promote it;
- generate one ID and append one order for a new path; and
- save before publishing.

The final normalized-path check and insert must have no `await` between them.
Any asynchronous validation happens first, followed by a final synchronous
re-check. This makes concurrent desktop calls converge in the single
main-process service; serve-web additionally retains its serialized durable
mutation admission.

Project refresh and project mutations reconcile overlaps before publication.
After current discovery, clients must not observe the same path in both arrays.
While discovery is stale or unavailable, the stored project record may still
contain a last-known non-root worktree that also has a saved arbitrary record.
The combined UI projection gives the project row precedence and hides the
arbitrary row until current discovery either promotes it or establishes that
the old worktree no longer belongs to the project. A stored project root is
always project-owned, independent of worktree-discovery freshness.

## Platform data flow

### Desktop

```text
Projects UI
  -> renderer IProjectManagerService proxy
  -> main-process ProjectManagerMainService
  -> application IStateService
  -> onDidChangeCatalog to every renderer

Add/Open action
  -> HucodeShellMainService calls ensureWorkbench(folder)
  -> shell controller opens the returned workbench ID in current window,
     or routes the returned project worktree through project open
  -> current window writes only its lifecycle overlay
```

`HucodeShellMainService` already receives `IProjectManagerMainService`. Pass a
narrow catalog dependency into `ResidentHostedWorkspacesController`, or keep
global mutation orchestration in `HucodeShellMainService`. Do not give the
controller a second mutable catalog copy.

Desktop live-path admission and cross-window focus remain owned by
`HucodeDesktopWorkbenchOwnershipCoordinator`. Global catalog membership does
not prove or grant live ownership.

### Serve-web

```text
Projects UI
  -> WebProjectManagerClient
  -> existing same-origin projects HTTP API
  -> serialized server mutation admission
  -> ProjectManagerMainService
  -> <server-data-dir>/hucode/projects.json
  -> existing SSE publication to all clients
```

Extend the existing response and event payloads to carry the combined catalog.
Do not create a second endpoint family, state file, event stream, or browser
storage authority.

Every catalog snapshot carries a monotonically increasing service revision.
HTTP responses and SSE events use the same revision sequence, and
`WebProjectManagerClient` ignores a response or event older than the newest
revision it has already applied. This prevents an initial GET that started
before a mutation from overwriting a newer SSE snapshot when it finishes
later. A server restart establishes a new connection generation; current
hosted-shell protocol policy requires the page reload that installs that new
generation.

Dispatch reserved `workbenches` routes before the existing handler interprets
the first URL segment as a project ID.

`WebHucodeShellController` receives catalog snapshots through the existing web
project-manager client. Its `sessionStorage` adapter saves only lifecycle
overlays and restore state after migration.

Request cancellation rules remain unchanged. Once a catalog mutation begins
inside the durable mutation queue, finish its state write and publication even
if the initiating HTTP response disconnects.

### Catalog hydration and restore availability

Desktop loads the catalog in the same main process before arbitrary-workbench
restore planning. Serve-web must not make the complete shell unusable when the
projects API is temporarily unavailable:

1. Restore resident project workspaces from session state independently.
2. Mark the arbitrary-workbench catalog as unhydrated rather than empty.
3. Start or retain the existing project event-stream connection and retry the
   catalog read through its normal reconnect path.
4. Do not create arbitrary-workbench restore candidates until the first valid
   catalog snapshot arrives.
5. When it arrives, join overlays by ID, discard overlays whose records no
   longer exist, and schedule eligible restoration through the normal restore
   policy.
6. If legacy import fails, preserve the old session payload, do not write a
   migration marker, and retry later. Never replace it with an empty migrated
   payload.

The overlay deliberately does not carry an authoritative folder-path fallback.
Restoring from a stale hint while the catalog is unavailable could reopen a
workbench another session globally dismissed. The shell remains usable for
projects while the saved Workbenches section presents a loading or unavailable
state instead of authoritative empty copy.

## Operation semantics

### Add and open

1. Resolve and validate the selected folder using the existing platform path.
2. Call `ensureWorkbench()` before creating a hosted instance.
3. If the discriminated result is `projectWorktree`, route through the project
   worktree open path.
4. Otherwise record the returned workbench ID in the initiating session and
   open or focus it through existing ownership admission.
5. If hosted creation fails, keep the saved catalog entry unloaded. A failed
   renderer creation must not undo the user's successful save.

### Open an existing saved workbench

1. Resolve the global record by ID.
2. Run existing desktop global or serve-web tab-local ownership admission.
3. Set the initiating session's desired state to loaded.
4. Create, focus, or activate the hosted instance.
5. Update session recency only after navigation is accepted.

### Unload and suspend

Unload and suspend mutate only the initiating session overlay and hosted
instance. They never modify or republish the global catalog.

### Rename and reorder

Rename, reset, and reorder go directly through `IProjectManagerService`.
Reordering calls `moveWorkbench(id, beforeWorkbenchId?)`. The service validates
that the moved record and optional anchor still exist, then computes a new
dense order from its current catalog. A stale client cannot replace the full
list or accidentally omit a concurrently added workbench.

### Dismiss

1. If the initiating session has a live instance, complete the current safe
   unload handshake.
2. If unload is vetoed or fails before the irreversible commit, stop and leave
   the global entry unchanged.
3. Remove the entry through the global catalog service.
4. All sessions drop durable overlays for the removed ID.
5. A different session with an already-live instance keeps it as session-only.
   That instance remains visible and usable until unloaded, but it is omitted
   from restore persistence.

The UI should distinguish a session-only row from a saved row with a concise
tooltip or context state. Do not add a persistent warning banner unless runtime
validation shows the transient state is otherwise confusing.

### Project promotion

Whenever authoritative worktree discovery commits a current snapshot:

1. Compute normalized project worktree paths.
2. Remove overlapping arbitrary-workbench records in the same catalog
   mutation.
3. Publish one snapshot containing only project ownership for those paths.
4. Each shell reclassifies a matching live instance to the project ID and
   removes its obsolete arbitrary session overlay.

Failed or stale Git discovery must not remove saved workbenches. Promotion
requires a `current` authoritative worktree snapshot. This is a new safety
gate; the existing renderer-driven complete-catalog reconciliation does not
currently distinguish current from stale discovery.

### Project removal and orphan adoption

After a project disappears from the global catalog, each shell reports any
still-restorable live instances that referenced it. The catalog authority
idempotently ensures an arbitrary-workbench record for each reported path.
Concurrent reports from multiple sessions converge by normalized path.

Desktop and serve-web use the same event-driven shape: after observing the
project removal, each shell calls `ensureWorkbench()` for its still-restorable
live paths. This avoids a project-manager-to-shell dependency and keeps the
catalog service independent of renderer ownership.

Until durable ensure succeeds, the shell keeps each path as a pending adoption
and a session-only row. It retries after catalog reconnection or the next valid
catalog snapshot, and clears the pending adoption only after success or local
unload. A workbench removed by global dismissal is marked separately and never
enters this retry path, so reconnection cannot resurrect an intentional
dismissal.

Instances that are not live or restorable do not create new saved entries only
because a project was removed.

## Migration plan

### Project-manager schema migration

Add pure parsing and serialization helpers for the additive version 1 shape.
An absent workbench field loads as an empty list. A present field validates
every workbench, deduplicates IDs and paths, and compacts order.

Parse core project state and the optional workbench field separately. When the
top-level version and projects are valid but workbenches are malformed, retain
the projects, preserve the original serve-web file for recovery, and continue
with an empty workbench list. Do not classify the complete file as corrupt only
because the additive field is invalid.

Keep the storage key and serve-web filename stable so the same state service
and durability machinery continue to apply. Add a downgrade fixture proving
the pre-change reader still preserves projects when the new field is present.

### Desktop legacy migration

Desktop legacy data may exist in `lastActiveWindow`, `openedWindows`, and other
restorable Omni window records. Migrating only the first controller would miss
catalog entries from windows not restored during that launch.

Add a narrow Hucode migration helper at the desktop window-state composition
boundary. It should inspect the complete serialized windows state before Omni
controllers restore:

1. Read every legacy `omniRetainedWorkbenches` array and every project-less
   entry in `omniResidentWorkspaces`.
2. Validate retained entries with the shared parser and convert project-less
   resident entries into loaded legacy candidates.
3. Union both sources by platform-normalized folder path.
4. Preserve an existing stable ID where possible.
5. Resolve label conflicts by the entry with the greatest valid
   `lastActiveAt`; otherwise use deterministic serialized-window order.
6. Preserve first-seen manual order and compact it.
7. Merge the union into the additive global version 1 state with idempotent
   path matching.
8. Persist the global catalog.
9. Rewrite each Omni window record with session overlays for its desired state
   and recency, removing authoritative label and order data. When duplicate
   paths contributed different legacy IDs, remap every overlay to the winning
   global ID.
10. Persist the rewritten windows state.

The global write precedes legacy cleanup. If the process stops between writes,
the next run repeats the merge without duplicating paths. Window restoration
must not start until the in-memory forms of both writes are installed.

Replace `adoptLegacyRetainedWorkbenches()` with the migration output rather
than letting controller restore create a second catalog after migration. Keep
legacy window-state readers for one release series so partially migrated state
remains recoverable. Remove them only after the normal upgrade window has
elapsed and the cleanup is called out in a change plan.

### Serve-web legacy migration

Each tab may contain the old `hucode.omni.webRetainedWorkbenches` payload.
During web shell initialization:

1. Parse the legacy payload.
2. Send its validated catalog entries through `importWorkbenches()` on the
   server-backed project manager and retain the returned legacy-to-global ID
   mappings.
3. Await the resulting catalog snapshot before arbitrary-workbench restore
   scheduling; resident project restore proceeds independently.
4. Rewrite session storage to the new version containing only remapped
   overlays, resident project workspaces, and the active path.
5. Mark the local payload version so the tab does not import again.

If import or the catalog request fails, keep the legacy payload byte-for-byte,
do not mark it migrated, and expose a retryable unavailable state. A later
successful attempt performs the rewrite.

The import runs in the serialized durable mutation queue. Entries for new paths
append after the current global order in legacy order and preserve their label.
For a path already in the global catalog, the existing global ID, label, and
order win; the result maps the legacy ID to that global ID. Multiple tabs may
therefore import the same folder concurrently without duplicating it or letting
a later stale tab overwrite metadata already accepted from an earlier import.

An already-open tab that does not reload cannot participate in the new
protocol. A tab holding old session storage may reintroduce a previously
removed path on its first upgraded reload. This is an accepted one-time
preservation tradeoff: rejecting the import would silently discard the exact
folders this change is intended to protect. Current hosted-shell protocol
policy already requires a full page reload after a server update.

## Implementation sequence

Phases 2 through 4 form one compatibility tranche. They may be developed and
reviewed separately, but no release or integration branch may remove a
controller-owned catalog before both desktop and serve-web can supply the new
global catalog feed. Keep the existing complete-project reconciliation as a
temporary compatibility feed until both platform subscriptions are live.

### Phase 1: Establish the global state model

- Add global runtime and stored arbitrary-workbench record types.
- Extend the version 1 stored state with optional workbenches and verify
  downgrade project preservation.
- Extract or adapt catalog validation, path deduplication, label normalization,
  ordering, and ID rules from `RetainedWorkbenchCatalog` into the
  project-manager common layer.
- Add `ProjectCatalogSnapshot`, catalog reads, catalog change publication, and
  workbench CRUD to `IProjectManagerService`.
- Make project refresh reconcile workbench overlaps before emitting a catalog
  snapshot.
- Keep temporary project-only compatibility accessors backed by the same
  snapshot.

Verification for this phase:

- state-parser tests for absent and present workbench fields, malformed state,
  valid projects with malformed workbenches, old-reader compatibility,
  duplicate-ID, duplicate-path, case-sensitivity, and order-compaction cases;
- project-manager tests for add, idempotent add, rename/reset, move, remove,
  concurrent ensure, stale/current project ownership, promotion, and coherent
  event publication; and
- a regression test proving that upgrade and downgrade parsing preserve every
  project.

### Phase 2: Split shell catalog and session ownership

- Replace each controller's mutable `RetainedWorkbenchCatalog` with a
  session-overlay structure keyed by global workbench ID.
- Do not remove the legacy catalog input until the platform catalog feed and
  compatibility join are present for that controller.
- Resolve folder, label, and order from injected catalog snapshots.
- Update restore scheduling to combine global records with local desired state
  and recency.
- Default globally saved records missing from the local overlay to unloaded.
- Keep missing-folder status in runtime state and recompute it through the
  existing folder preflight.
- Add session-only projection for live instances whose global records were
  removed.
- Move rename, reset, reorder, and durable remove authority out of the shell
  controller.
- Retain unload, suspend, live-instance creation, crash recovery, and local
  lifecycle transitions in the controller.

Verification for this phase:

- shared lifecycle-contract tests proving unload and suspend do not change the
  global catalog;
- two-controller desktop tests proving catalog sharing and independent desired
  states;
- restore-policy tests for `active`, `all`, and `none` with a shared catalog;
- dismissal-veto tests proving the catalog remains when local unload is
  refused; and
- tests for session-only live instances after external removal.

### Phase 3: Add desktop migration and propagation

- Add the complete-window-state legacy migration before controller restore.
- Change native window persistence to write only arbitrary-workbench overlays.
- Migrate both retained arrays and project-less resident workspace entries,
  remapping duplicate legacy IDs to the winning global IDs.
- Route Add Workbench through the main project manager before opening.
- Subscribe desktop shell/controller coordination to global catalog changes.
- Join overlay IDs against the global catalog anywhere restore arbitration,
  standalone-open preparation, or another cross-window path currently reads
  full retained records from a window configuration.
- Reclassify promoted live instances without recreating their renderer.
- Implement idempotent, retryable orphan adoption after project removal while
  keeping global dismissal non-retryable.
- Remove obsolete catalog fields from new desktop window configurations while
  retaining compatibility readers for legacy state.

Verification for this phase:

- migration tests covering one window, several windows, duplicate folders,
  conflicting labels, missing timestamps, mixed project overlap, and an
  interrupted rerun;
- window-state serialization tests proving catalog metadata is no longer
  copied into each window;
- multi-window tests for add, rename, reorder, unload independence, promotion,
  dismissal, orphan-adoption failure/retry, and unload cancellation of pending
  adoption; and
- focused desktop runtime validation with two Omni windows.

### Phase 4: Extend serve-web transport and migrate tabs

- Extend HTTP responses and SSE catalog events to include workbenches.
- Add workbench mutation routes to the existing same-origin API.
- Add the idempotent bulk-import route and legacy-to-global ID mappings.
- Dispatch reserved workbench routes before project-ID route parsing.
- Run all durable workbench mutations through the existing serialized mutation
  admission and state-write generation tracking.
- Extend `WebProjectManagerClient` with catalog revival and mutation methods.
- Change web shell persistence to its versioned session-only shape.
- Import old tab-local catalogs before restore and then mark the payload
  migrated.
- Restore resident project workspaces independently, keep the Workbenches
  catalog unhydrated on failure, and retry catalog load or legacy import
  without overwriting the old payload.
- Preserve event reconnect behavior and Git-target re-registration.
- Apply catalog snapshots by revision so late HTTP responses cannot replace a
  newer SSE event.

Verification for this phase:

- server route tests for validation, same-origin policy, serialization,
  bulk-import conflict semantics, reserved-route dispatch, disconnect
  behavior, write failure, retry, and SSE publication;
- web client tests for catalog revival, both HTTP/SSE delivery orders, stale
  revision rejection, and reconnect updates;
- two-client tests proving shared catalog and independent loaded state;
- duplicate legacy-tab import tests; and
- serve-web browser validation using two Omni tabs and one page reload.

### Phase 5: Adapt sidebar and command flows

- Build Workbenches rows from the global catalog plus shell session state.
- Keep Git observations consumer-scoped and update target registration from the
  global workbench list.
- Route rename, reset, reorder, and unloaded dismissal through the project
  manager.
- Use relative move semantics for drag-and-drop instead of submitting a full
  replacement order.
- Keep unload, suspend, and loaded dismissal coordinated with the shell
  lifecycle service.
- Display live session-only rows until unload without presenting them as
  globally saved.
- Update full switcher, quick switcher, previous/next, and last-active paths to
  use the combined projection.
- Remove the renderer-to-shell complete-project-catalog reconciliation call
  after all promotion and adoption behavior has moved to explicit authority
  boundaries.

Verification for this phase:

- tree-model and contribution tests for global order, unloaded defaults,
  session-only rows, stale-discovery project precedence, relative-move drag
  behavior under a concurrent add, and context actions;
- switcher-model tests for deduplication and active/loaded state;
- accessible labels and context-menu state for saved versus session-only rows;
  and
- focused browser interaction for add, switch, unload, dismiss, rename, and
  reorder propagation.

### Phase 6: Remove compatibility paths and update documentation

- Remove obsolete controller-owned catalog mutations and duplicate
  reconciliation helpers.
- Rename remaining `retainedWorkbenches` symbols where they now refer only to
  session overlays or projected rows.
- Update `docs/hucode/omni.md` to state that projects and arbitrary workbenches
  form one global saved catalog while lifecycle state remains session-local.
- Update `docs/hucode/architecture.md` with the combined catalog authority and
  platform persistence paths.
- Correct the current agent-instruction claim that serve-web retains this
  catalog in profile storage; the pre-change implementation uses tab-local
  `sessionStorage`.
- Add any non-obvious migration or verification hazards discovered during
  implementation to `docs/hucode/agent-instructions.md`.
- Regenerate the Hucode test-suite snapshot if new suites are added.
- Move this plan to `docs/hucode/archive/` after implementation and current
  guides fully describe the delivered behavior.

Verification for this phase:

- focused project-manager, desktop controller, web shell, server adapter,
  tree-model, and contribution suites;
- `npm run hucode:compile`;
- `cd build && npm run typecheck` if build or server scripts change;
- `npm run hucode:check-test-suites`;
- focused Node suites, one per invocation, using
  `npm run test-node -- --run <test-file>`;
- scoped hygiene using `npm run -s precommit -- <edited-paths>`; and
- desktop and serve-web Omni smoke paths appropriate to the final diff.

## Acceptance criteria

The implementation is complete when all of the following are true:

- Two desktop Omni windows show the same arbitrary-workbench records, labels,
  and order.
- Two serve-web Omni tabs show the same arbitrary-workbench records, labels,
  and order after event propagation.
- Loading or unloading a saved workbench in one session does not change another
  session's loaded, dormant, active, or unloaded state.
- Closing the only session that added a workbench does not remove the saved
  record.
- A fresh session shows every saved arbitrary workbench as unloaded unless that
  session has its own restore overlay.
- A fresh unloaded row does not claim a folder is missing until Git observation
  or folder preflight establishes that status.
- A serve-web session restores resident projects while the catalog is
  unavailable, shows Workbenches as unhydrated, and restores eligible arbitrary
  workbenches after the first valid snapshot.
- A late serve-web HTTP response cannot replace a newer catalog revision
  already received over SSE.
- Global add is idempotent under concurrent requests for the same normalized
  path.
- Project promotion publishes no snapshot containing both a project worktree
  and arbitrary workbench for the same path.
- Project removal preserves a still-live workbench through global orphan
  adoption, including retry after a transient adoption failure.
- A local unload veto prevents initiating-session dismissal from removing the
  global entry.
- Global dismissal does not force-close another session's live workbench and
  does not cause that session to re-add the record.
- Desktop version 1 project state, retained arrays, and project-less resident
  entries migrate without losing projects or workbench folders, and duplicate
  legacy IDs are remapped consistently.
- Serve-web legacy session catalogs import without duplicates and are rewritten
  to session-only storage with every overlay remapped to its global ID.
- Valid projects survive a malformed optional workbench field; serve-web also
  preserves the original malformed file for recovery.
- Serve-web failed durable writes do not publish a catalog snapshot that was
  not saved. Desktop retains its existing best-effort application-state
  durability unless a separate acknowledged-write design is approved.
- Existing desktop ownership and serve-web tab-local ownership tests remain
  green.

## Risks and mitigations

### Catalog and lifecycle state become accidentally coupled again

Mitigation: keep global record types free of desired state, folder status, and
recency. Tests should compare two sessions after every lifecycle mutation.

### A newer catalog is opened by an older build

Mitigation: retain schema version 1 and add an optional field. Test that the
pre-change reader preserves projects. Document that a downgraded writer may
drop the new workbench field even though it must not destroy projects or
quarantine the state file.

### Migration resurrects duplicate or stale folders

Mitigation: normalize and deduplicate paths at the server/main-process
authority. Strip every desktop legacy source in one migration pass after the
global write. Accept one first-reload import from an old serve-web tab as the
data-preserving tradeoff described above.

### Project refresh removes a workbench on stale Git data

Mitigation: perform promotion only after current authoritative discovery. A
stale or unavailable worktree snapshot cannot delete a saved workbench. This
gate is implemented in the new project-manager reconciliation rather than
assumed from the existing renderer path.

### A late catalog response overwrites a newer event

Mitigation: attach one monotonic revision sequence to HTTP and SSE catalog
snapshots and ignore revisions older than the newest snapshot already applied.
Test both response/event delivery orders.

### Orphan adoption fails after project removal

Mitigation: retain a session-local pending-adoption marker and retry on
reconnection or the next catalog snapshot. Keep dismissal tombstones distinct
so retry never recreates an intentionally removed workbench.

### Catalog hydration blocks serve-web startup

Mitigation: restore resident projects independently, represent catalog state as
unhydrated rather than empty, and retry through the existing project connection.
Preserve an old legacy payload until import and catalog read both succeed.

### Global dismissal closes unsaved work in another session

Mitigation: never remotely unload. Preserve a live session-only instance until
its owner unloads it.

### UI observes transient duplicate or missing rows

Mitigation: publish a combined catalog snapshot after reconciliation instead
of separate project and workbench events. Merge it with shell runtime state in
one renderer model update.

### Serve-web transport forks into two state systems

Mitigation: extend the existing project API, mutation queue, state file, and
SSE stream. Do not introduce a workbench-specific server or browser-global
storage adapter.

## Rejected alternatives

### Persist the existing retained record globally

Rejected because the record includes session-local desired state, missing
status, and recency. Concurrent sessions would overwrite one another and an
unload in one session would affect restoration elsewhere.

### Use browser `localStorage` for serve-web

Rejected because it would remain browser-profile and origin local, would not
cover desktop, would not share reliably across devices, and would bypass the
existing server durability and event path.

### Add a separate arbitrary-workbench catalog service

Rejected because it would duplicate storage, transport, path normalization,
ordering, publication, and migration machinery. Project promotion would also
become a cross-service transaction instead of one catalog invariant.

### Force remote unload when a global entry is dismissed

Rejected because another session may contain unsaved work or veto shutdown.
Serve-web intentionally has no cross-tab renderer authority, so the behavior
would either be unsafe or differ substantially by platform.

### Keep per-session catalogs and merge them only in the UI

Rejected because no source would be authoritative for deletion, rename, order,
or persistence after the originating session closes.

## Unresolved questions

No product decision currently blocks implementation. During implementation,
the exact one-release compatibility lifetime for legacy window-state readers
should follow the release branch and upgrade policy in effect when the change
lands. Any need to change the settled dismissal, catalog-unavailable startup,
or session-only behavior should return to design review before code proceeds.
