---
title: Serve-Web Server User Data Plan
status: implemented
last_updated: 2026-08-02
---

# Serve-Web Server User Data Plan

## Document purpose

This document is the implementation plan for making Hucode serve-web user
settings, keybindings, profiles, and state optionally persist on the server.
It records the agreed product contract, the relevant upstream architecture,
implementation seams, migration behavior, validation strategy, and rollout
boundaries.

The plan is intentionally stored in the repository so implementation and
review can refer to an explicit contract rather than reconstructing decisions
from chat history. Durable behavior is now documented in `architecture.md` and
the root README; archive this plan after the delivery PR lands.

## Delivery status

- Product and architecture decisions: **Approved**
- Implementation: **Complete; PR validation in progress**
- Delivery base: `series-1.131.0` at `af8424f48d0`
- Required independent review: Codex and Claude
- Selected external review: CodeRabbit
- Post-draft correction-cycle budget: two pushes

## Goal

Add an opt-in server-authoritative user-data mode to `hucode serve-web` so a
person connecting to the same Hucode server from another browser or device sees
the same:

- user settings and keybindings;
- snippets, tasks, prompts, and other profile files;
- named profiles and workspace-to-profile associations;
- application, profile, and workspace state, including extension
  `globalState` and `workspaceState`.

Browser storage remains the default. Secret storage, authentication sessions,
and browser credentials remain browser-local in both modes.

## Settled decisions

- Add a storage-mode flag with `browser` and `server` values.
- Default to `browser`, preserving current behavior and existing deployments.
- In `server` mode, the server is authoritative. Do not maintain a live mirror
  or merge browser and server copies.
- Keep `ISecretStorageProvider`, authentication sessions, cookies, and browser
  credentials in the browser.
- When server mode starts with an uninitialized server namespace and meaningful
  browser data exists, prompt to migrate it.
- Keep the browser copy after migration. It is a rollback source if the server
  is later restarted in browser mode.
- If server mode cannot reach or initialize its backend, fail visibly and
  offer retry. Never silently fall back to browser storage, because that would
  create split-brain state.
- Treat the mode as a startup-time choice. Changing it requires restarting the
  serve-web server and reloading clients.
- Apply the same mode to the regular workbench, Omni shell, and hosted Omni
  workbenches, including `--no-omni` deployments.
- Scope the first version to Hucode's existing single-server-user security
  model. Every client with access to the same connection token shares the same
  server user data.

## Recommended command-line contract

```text
hucode serve-web --user-data-storage=browser
hucode serve-web --user-data-storage=server
```

The Rust CLI should expose a typed enum and default it to `browser`. The outer
CLI should pass a Hucode-owned internal argument to the Node server, and the
server should inject the resolved mode into trusted workbench configuration.
Do not derive the mode from URL payload parameters; those are caller-controlled
on web.

The existing `--server-data-dir` continues to choose the physical root. A
separate `--user-data-dir` is not needed for the first version. If a separate
mount becomes a real deployment requirement later, it can be added without
changing the logical storage-mode contract.

Proposed server layout:

```text
<server-data-dir>/
└── data/
    ├── User/                 existing remote extension-host user data
    └── WebUser/              new server-authoritative web-client data
        ├── manifest.json     format, state, and committed generation
        ├── User/             default and named profile resources
        └── State/            application/profile/workspace databases
```

`WebUser` is deliberately separate from the existing `data/User` tree. The
existing tree belongs to the remote extension host and can already contain
machine settings, extension data, profiles, and history before the web client
starts. Sharing it would make “server is empty” unreliable and collapse the
same local-versus-remote user-data distinction that desktop VS Code preserves.
The web profile service can continue associating its profiles with remote
extension-host profiles by stable profile ID.

The exact directory name is an implementation detail and may change before
landing, but the separate namespace is part of the design.

## Current architecture

Serve-web user data is not one storage layer today. It is four related stores:

| Data | Current browser owner | Examples | Server-mode owner |
| --- | --- | --- | --- |
| Profile files | IndexedDB file-system provider for `vscode-userdata` | settings, keybindings, snippets, tasks, prompts | Remote file provider rooted in `WebUser/User` |
| Workbench state | `BrowserStorageService` IndexedDB databases | UI state, extension global/workspace state, debug state | Server-hosted state databases over IPC |
| Profile catalog | `BrowserUserDataProfilesService` plus local storage | named profiles and associations | Dedicated server web-profile service |
| Secrets | `LocalStorageSecretStorageProvider` and browser auth/session storage | tokens and credentials | Browser, unchanged |

Relevant source seams at the time this plan was written:

- `BrowserWorkbenchEnvironmentService.userRoamingDataHome` is fixed to
  `vscode-userdata:/User` in
  `src/vs/workbench/services/environment/browser/environmentService.ts`.
- `BrowserMain.registerIndexedDBFileSystemProviders()` installs the user-data
  IndexedDB provider, and `BrowserMain.createStorageService()` constructs
  `BrowserStorageService`, in `src/vs/workbench/browser/web.main.ts`.
- `BrowserUserDataProfilesService` stores profile metadata in browser local
  storage in `src/vs/platform/userDataProfile/browser/userDataProfile.ts`.
- `LocalStorageSecretStorageProvider` is selected in
  `src/vs/code/browser/workbench/workbench.ts`.
- The Node server already installs a disk file-system provider, remote file
  channel, and remote extension-host user-profile channel in
  `src/vs/server/node/serverServices.ts`.
- The reusable browser-side `RemoteStorageService` and storage IPC clients live
  in `src/vs/platform/storage/common/storageService.ts` and `storageIpc.ts`.
  The existing server side of that protocol is coupled to Electron main and
  must be factored into a Node-safe host or implemented as a server-specific
  host.

The existing VS Code Settings Sync subsystem is not a substitute for this
feature. Its standard resource list excludes workspace state, and its global
state synchronizer intentionally selects only user-targeted keys. It may be a
future cross-server sync layer, but it cannot make one serve-web server the
authoritative source for all state.

## Target architecture

### 1. Trusted startup configuration

Add `browser | server` to the serve-web CLI, internal server arguments, and
trusted page configuration. Parse and validate it once. Browser code consumes
the server-injected value; URL payloads cannot override it.

Browser mode follows the current startup path unchanged.

Server mode runs a user-data bootstrap preflight before profile, file, or
storage services are initialized. This ordering prevents default workbench
writes from accidentally converting an uninitialized server into a populated
one before migration is decided.

### 2. Server-authoritative profile files

In server mode, set the web client's user roaming data home to a remote URI
rooted in `WebUser/User` and use the existing remote file-system transport.
Settings and other file resources then continue through `IFileService` without
adding a second synchronization abstraction.

Requirements:

- normal file watching and cross-client change events must work;
- writes must retain the existing atomic file-write behavior;
- remote file operations beneath `WebUser` must share server user-data
  admission, lifetime leases, and orderly-shutdown draining without changing
  the lifecycle of unrelated remote file operations;
- the server must resolve and confine all paths beneath `WebUser`;
- clients must not be able to use a profile or migration argument to select an
  arbitrary server path;
- browser mode must retain the existing IndexedDB file provider exactly.

### 3. Server-authoritative profile catalog

Add a dedicated web user-profile service and IPC channel for the profile
catalog and workspace associations. Do not reuse the existing
`userDataProfiles` server channel directly: that service represents remote
extension-host profiles, not the web client's local/UI profile namespace.

The browser-side service should implement `IUserDataProfilesService`, expose
server-backed profile URIs, receive external-change events, and preserve stable
profile IDs. Remote extension profiles remain associated by those IDs through
the existing remote-profile mechanism.

This service must be available early enough to resolve the current profile
before normal workbench storage starts. Add a narrow, generic construction seam
to `BrowserMain` for selecting the profile and storage backends; keep the mode
decision and server implementation in Hucode-owned code. The existing
asynchronous Hucode web entrypoint should run bootstrap before selecting the
regular, hosted, or Omni `BrowserMain` subclass.

### 4. Server-authoritative workbench state

Host application, application-shared, profile, and workspace storage databases
under `WebUser/State`, and expose them through the existing common storage IPC
protocol where practical. Use `RemoteStorageService` on the browser side.

The Electron `StorageMainService` cannot simply be instantiated in the Node
server because its lifecycle and environment dependencies are Electron-main
specific. Factor the database/channel core into a Node-safe layer or implement
a narrow server host that preserves the same wire protocol.

Additional server-mode requirements:

- validate profile IDs and workspace storage identifiers instead of trusting
  caller-supplied paths;
- serialize writes per logical database and flush admitted writes before
  server shutdown completes;
- broadcast external changes for all scopes, including workspace storage;
- add workspace external-change support to the common client rather than
  retaining its desktop-only “one window” assumption;
- retain compare-and-swap semantics used by current Hucode browser state;
- close client listeners without allowing one browser to close a shared server
  database used by another browser.

Concurrent writes to the same setting, file, or storage key use
last-successful-write-wins semantics. There is no field-level merge in the
first version. File watching and state events should make other connected
clients observe committed changes, although consumers that only read at startup
may still require a reload.

### 5. Browser-local secrets

Leave the current secret and authentication providers untouched in both modes.
Do not migrate or server-store:

- values owned by `ISecretStorageService`;
- authentication session objects or tokens;
- cookies, connection tokens, or browser credential APIs;
- unrelated origin local-storage values.

Settings files can themselves contain user-entered sensitive values; opting
into server mode necessarily stores those files on the server. Documentation
should make that boundary clear rather than claiming that all sensitive text is
browser-local.

## Bootstrap and migration contract

### Server manifest

Do not infer initialization from whether arbitrary directories contain files.
Use a versioned server manifest with at least:

- format version;
- state: `uninitialized`, `staging`, or `ready`;
- committed generation;
- migration owner/lease and expiry while staging;
- creation and last-migration timestamps, without browser-identifying data.

The manifest and generation are the authority. A migration is prepared in a
temporary generation and becomes visible only through an atomic server-side
commit. Startup should recover or remove expired staging generations without
touching the last committed generation.

### Meaningful browser-data detection

The preflight reader should inventory known VS Code web stores rather than copy
opaque IndexedDB files. Data is meaningful when at least one of these exists:

- a profile file beyond an empty provider scaffold;
- a named profile or profile association;
- a non-internal application, profile, application-shared, or workspace state
  key.

Ignore initialization markers such as the storage `IS_NEW_KEY` and empty
databases. This avoids prompting a browser that has merely opened the page once.

### Startup outcomes

| Server manifest | Meaningful browser data | Behavior |
| --- | --- | --- |
| `ready` | either | Start from server; do not prompt or merge browser data |
| `uninitialized` | no | Atomically initialize an empty server generation, then start |
| `uninitialized` | yes | Prompt before starting normal workbench services |
| active `staging` lease | either | Wait briefly for completion, then retry/recover or offer retry |
| backend unavailable/corrupt | either | Show actionable error and retry; never use browser fallback |

### Prompt behavior

The bootstrap prompt offers:

1. **Use Browser Data** — import supported data into a staged server
   generation, atomically commit it, and start from the server.
2. **Start Fresh on Server** — atomically commit an empty server generation and
   start from it.
3. **Cancel** — make no changes and do not start the workbench; the choice is
   offered again on the next server-mode load.

The prompt must state that secrets and sign-ins stay in this browser and that
the browser copy is retained. It must not depend on `IStorageService` or the
normal notification service, since those services have not been selected yet;
use a small accessible bootstrap UI shared by all Hucode web entrypoints.

### Imported data

Import logical resources, not whole browser database blobs:

- default and named profile files;
- named profiles and associations;
- application and application-shared state;
- every named profile state database;
- all discoverable workspace state databases for the current origin.

Use `indexedDB.databases()` when available to inventory databases with the
known `vscode-web-state-db-` prefix. If the browser cannot enumerate databases,
import global/profile scopes and the currently opened workspace, then show an
explicit migration summary that older inactive workspace state remains only in
that browser. New state is server-backed from that point onward.

Preserve keys and values exactly, excluding only known storage-internal
initialization/migration markers. Preserve profile IDs so state, files, and
remote extension-profile associations continue to line up.

### Multi-browser race

Two browsers can reach an empty server at the same time. The bootstrap channel
must implement a lease plus generation compare-and-swap:

1. a browser claims the uninitialized generation before upload;
2. it uploads into a private staging generation;
3. commit succeeds only if the manifest is still at the claimed generation;
4. the first successful commit wins;
5. a losing browser discards its staging data, reports that another browser
   initialized the server, and starts from the committed server generation.

No client may overwrite a ready generation through the first-run migration
path. A later import/restore feature would need a separate explicit destructive
workflow.

## Failure, reset, and rollback behavior

- A server write failure is surfaced as a persistence error and logged with the
  logical scope and operation, without logging values.
- A transient disconnection may retry bounded, idempotent reads. Do not blindly
  replay a write whose delivery is ambiguous.
- The server drains accepted state writes and closes databases during orderly
  shutdown. Abrupt-process durability remains the responsibility of the
  database journal and atomic file writes.
- Starting the server again in browser mode exposes the untouched browser copy;
  it does not automatically merge changes made in server mode.
- Existing reset-user-data actions must say which backend they will erase. In
  server mode, confirmation must warn that the action affects every browser
  connected to this server.
- Resetting server user data must not delete browser secrets or the existing
  remote extension-host `data/User` tree.
- Export/import, scheduled backup, cross-server sync, and bidirectional merge
  are follow-up features, not implicit parts of reset or migration.

## Upgrade resilience and upstream patch budget

Hucode replays a curated patch series onto each selected VS Code release tag.
An upstream edit therefore has two distinct upgrade risks:

1. a textual conflict during replay; and
2. a clean replay whose assumptions are no longer valid after upstream changes
   initialization, lifecycle, or IPC behavior.

The second risk is more dangerous. Small diffs reduce conflict probability,
but provenance checks and tests against the real integration seam are required
to catch semantic drift.

Optimize for the **least Hucode-specific behavior embedded in upstream files**,
not the absolute fewest upstream files. Two small generic construction hooks
are preferable to one large conditional patch in a central bootstrap file.

### Patch-boundary rules

- Put manifest, migration, provider, profile, database, conflict, reset, and
  diagnostics logic in `src/vs/hucode/`, Hucode-owned server modules, or clearly
  named `hucode*` companions beside the required layer.
- Keep upstream-owned files as thin integration points limited to option
  declarations, feature detection, dependency injection, construction,
  registration, and delegation.
- Do not fork or copy `BrowserMain`, `RemoteStorageService`,
  `StorageDatabaseChannel`, or the Electron storage services.
- Add one deliberate browser user-data backend construction seam rather than
  scattering Hucode mode branches through file-provider, profile, and storage
  initialization.
- Keep the existing browser IndexedDB provider mounted in server mode as the
  migration and rollback source, but make server-backed profile resources and
  state authoritative after bootstrap completes.
- Reuse the existing asynchronous Hucode workbench entrypoint for preflight and
  factory selection. Do not add a second startup interception to upstream
  `workbench.ts`.
- Reuse the existing Hucode workbench-configuration spread and request
  delegation in `webClientServer.ts`; do not add migration or storage policy
  inline there.
- Implement the Node storage host in Hucode-owned code using Node-safe storage
  primitives. Do not import Electron-main lifecycle services into the server.
- Keep workspace external-change support as a standalone generic,
  upstream-quality patch. Retain it in the first version because concurrent
  workspace clients otherwise operate on stale state; consider contributing
  it upstream so the Hucode patch can later be dropped.
- Prefer Hucode-named test files. Modify an upstream test only for a narrow
  integration assertion that materially depends on its fixtures.

### Expected upstream touch budget

This table is a design constraint, not permission to add all listed edits. An
implementation should touch fewer surfaces whenever the established seams are
sufficient. Any additional upstream file requires a recorded rationale in the
implementation PR and plan decision log.

| Surface | Expected change |
| --- | --- |
| `cli/src/commands/args.rs` | Extend the existing Hucode serve-web argument topic with the typed public mode and parser tests |
| `cli/src/commands/serve_web.rs` | Forward the resolved internal mode beside the existing Hucode serve-web option |
| `src/vs/server/node/serverEnvironmentService.ts` | Declare and type the internal Hucode option only |
| `src/vs/server/node/webClientServer.ts` | Reuse its existing Hucode configuration and request-handler delegations; no inline policy |
| `src/vs/code/browser/workbench/workbench.ts` | No additional edit expected; use `hucodeWebWorkbenchEntrypoint.ts` |
| `src/vs/workbench/services/environment/browser/environmentService.ts` | Resolve server user-data home from trusted Hucode configuration in the existing Hucode patch |
| `src/vs/workbench/browser/web.main.ts` | Add the smallest generic profile/storage construction seam and interface generalization needed by a Hucode subclass |
| `src/vs/server/node/serverServices.ts` | One Hucode server-service registration/delegation call |
| Common and Electron storage IPC | Standalone generic workspace external-change support, with no server-mode policy |

New server, migration, provider, profile, and storage implementations should
otherwise live in Hucode-owned files. In particular, extending the existing
Hucode configuration builder should not require another structural patch to
`webClientServer.ts`.

### Provenance and semantic-drift tripwires

- Register every unavoidable, non-trivial upstream patch for this feature in
  `build/hucode/upstream-provenance.json`, including the upstream source blob,
  last reconciled baseline, rationale, and owning test suites.
- During every VS Code baseline upgrade, treat a changed tracked blob as a
  reconciliation task. Never refresh provenance metadata merely to make the
  check pass.
- Add focused contract tests that exercise the real `BrowserMain` backend
  selection, server channel registration, and workspace external-change path.
  Tests only against Hucode helper internals do not prove that upstream still
  calls the seam correctly.
- Keep a browser-mode integration assertion at the same construction boundary
  so an upstream refactor cannot accidentally select server behavior by
  default.
- Include the expected upstream-touch list in the upgrade overlap scan. A clean
  cherry-pick does not waive review of initialization order, URI/provider
  registration, shutdown, or event semantics.

### Durable replay boundaries

Keep the implementation separable into coherent replay topics:

1. CLI and trusted configuration plumbing;
2. generic browser backend construction seam;
3. Hucode server user-data providers and services;
4. generic workspace storage notifications;
5. migration and user-facing bootstrap behavior; and
6. documentation, provenance, and upgrade tripwires.

Do not combine these into one large feature commit. Generic changes should be
reviewable and potentially upstreamable without carrying Hucode product policy,
while Hucode-owned topics should replay without editing the generic seams.

## Implementation closure matrix

### Implemented surfaces and deviations

The implementation keeps policy and persistence in Hucode-owned companions:
`hucodeWebUserDataBootstrap.ts`, `hucodeWebUserDataBrowserMain.ts`, and the
three `hucodeWebUserData*` Node services. Upstream `BrowserMain` gained only
protected construction hooks and a small profile-service interface; the
default factory still constructs the original class. The generic common
storage patch adds workspace events and atomic operations without selecting a
Hucode mode.

Four upstream touches exceeded the initial table:

- `workbench.ts` explicitly selects the existing browser-local secret provider
  in server mode; leaving its remote fallback active would put secrets on the
  server and violate the product boundary.
- `web.factory.ts` accepts a `BrowserMain` constructor so all three Hucode web
  routes use one backend seam without copying the factory.
- `web.main.ts` also exposes the existing reset action through two protected
  hooks, keeping server reset policy and warning text in the Hucode subclass.
- `BrowserStorageService` and the Sessions automation storage adapter implement
  and consume a narrow atomic-storage capability, removing the previous
  concrete-class assumption.
- `sessions/browser/web.main.ts` forwards the now-explicit construction
  dependencies from its existing override. It adds no Hucode policy.

Every non-trivial upstream patch is recorded in
`build/hucode/upstream-provenance.json` against the `1.131.0` baseline. The
focused implementation suites collected before PR review are:

- `src/vs/server/test/node/hucodeWebUserDataServer.test.ts` for first-wins
  initialization, staged commit, ready-generation and long-upload lease
  protection, strict catalog restart behavior, profile/reset serialization,
  lifetime ownership, remote WebUser file admission and setup-service draining,
  empty initialization, and traversal rejection;
- `src/vs/server/test/node/hucodeWebUserDataStorage.test.ts` for durable reopen,
  all persisted scopes, serialized compare-and-swap, workspace external events,
  shutdown draining, and identifier rejection;
- `src/vs/server/test/node/hucodeWebClientServerIntegration.test.ts` for the
  browser default and trusted server route configuration;
- `src/vs/hucode/test/common/webUserDataMigration.test.ts` for secret and
  machine-ID exclusion plus benign bootstrap-conflict classification;
- `src/vs/platform/storage/test/electron-main/hucodeStorageIpc.test.ts` for
  workspace event rebinding after the desktop storage instance closes;
- Rust `commands::args::tests` for the public CLI default, valid values,
  invalid values, and argument interaction.

Real multi-browser migration and restart smokes remain final PR validation
evidence rather than being represented as complete by a browser mock.

The implementer owns focused evidence while building. The delivery orchestrator
owns evidence sufficiency and final-head gates; CI owns clean-environment and
supported-runner coverage. When final test paths differ from the proposed names
below, update this matrix with the exact collected paths before opening the PR.

| Material behavior or risk | Required evidence | Owner |
| --- | --- | --- |
| Omitted flag preserves browser-local behavior | Rust parser default test, real backend-selection contract test, and two isolated browser profiles remaining independent | Implementer |
| Only trusted server configuration selects server mode | Argument-forwarding and workbench-configuration unit tests; URL payload cannot override the selection | Implementer |
| Settings, keybindings, profile files, named profiles, and associations persist | Provider/profile service tests plus two-browser and server-restart runtime flow | Implementer |
| Application, application-shared, profile, workspace, extension global, and extension workspace state persist | Storage host/client integration tests for every scope plus representative runtime state across browser profiles | Implementer |
| Concurrent clients observe committed workspace state | Common/Electron IPC regression test, Node host multi-client test, and two-browser runtime check | Implementer |
| Same-key conflicts are deterministic | Two-client last-successful-write-wins integration test | Implementer |
| Secrets and authentication remain browser-local | Migration exclusion unit test and isolated-browser runtime check | Implementer |
| Empty server initializes without a prompt | Bootstrap state-machine test and fresh-browser runtime check | Implementer |
| Existing browser data offers migrate, start-fresh, and cancel | Bootstrap UI/state tests covering all three results; runtime migration of representative resources | Implementer |
| Migration is atomic and first complete commit wins | Lease/generation tests for race, stale and long-upload renewal, upload failure, commit failure, benign initialization conflict, and idle recovery | Implementer |
| Server paths and logical identifiers are confined | Traversal before folder creation, dot-segment profile IDs, strict catalog schema, unknown profile, invalid workspace, and staging-generation rejection tests | Implementer |
| Server outage never falls back to browser | Bootstrap/backend failure test and runtime retry/error observation | Implementer |
| Orderly shutdown drains admitted writes | Storage-host shutdown test followed by reopen/read verification; HTTP/profile/storage/remote-file lifetime-lease tests; blocked WebUser write and setup-owner drain test; dispose admission test | Implementer |
| Regular, Omni, hosted Omni, and `--no-omni` share the mode | Route/config unit tests and representative runtime smoke for each entrypoint | Implementer |
| Upstream integration remains narrow and detectable | Provenance check against `1.131.0`, real-seam contract tests, and final diff audit against the documented touch budget | Orchestrator |
| TypeScript, Rust, generated suite inventory, hygiene, and supported CI stay green | Final-head local gates below and required GitHub Actions checks | Orchestrator and CI |

### Focused implementation commands

Use these as the initial command contract; record the exact test names/counts
and any justified substitution in the evidence ledger:

```sh
cd cli && cargo test commands::args::tests
npm run gulp compile-client
npm run hucode:test-suites -- --write-snapshot
npm run hucode:check-test-suites
npm run test-node -- --run src/vs/server/test/node/hucodeWebUserDataServer.test.ts
npm run test-node -- --run src/vs/server/test/node/hucodeWebUserDataStorage.test.ts
npm run test-node -- --run src/vs/server/test/node/hucodeWebClientServerIntegration.test.ts
```

Browser/Electron-layer suites resolved by `hucode:test-suites` must run through
the assigned runner. For explicit local Electron suites, rebuild after source
changes and use the repository's headless sandbox contract:

```sh
npm run gulp compile-client
VSCODE_SKIP_PRELAUNCH=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run \
  ./scripts/test.sh --run <exact-source-suite>
```

### Intended final-head gates

Run once after declaring the final pushed head, except where the final CI job
provides the same clean-environment gate:

```sh
cd cli && cargo test commands::args::tests
npm run hucode:check-upstream-provenance -- --upstream-ref 1.131.0
npm run hucode:check-test-suites
npm run hucode:validate
npm run precommit
npm run hucode:compile
```

Also run the exact focused suites recorded by the implementer when later deltas
invalidate their evidence. CI supplies its configured clean checkout, Node,
Electron, platform, and packaging-oriented gates; do not treat an earlier PR
head as final evidence.

## Implementation sequence

### Phase 1 — Configuration and bootstrap protocol

- Add the Rust enum, help text, default, parsing tests, and process forwarding.
- Add the internal server argument and trusted workbench configuration field.
- Define the `WebUser` layout, manifest schema, path confinement, lease,
  staging, commit, and recovery operations.
- Add a narrow bootstrap endpoint or channel available before normal workbench
  service construction.
- Add the shared pre-workbench error/migration UI.

Exit criterion: browser mode is byte-for-byte equivalent at the provider
selection seams; server mode can reliably classify and initialize an empty
namespace without constructing normal user-data services.

### Phase 2 — Server profile files and catalog

- Add the generic browser backend construction seam so Hucode-owned code can
  select user-data home and profile service before resolving the current
  profile.
- Point server-mode file resources at the confined remote `WebUser/User` root.
- Implement the dedicated server web-profile service and IPC client.
- Preserve profile IDs and remote extension-profile association behavior.
- Add cross-client profile and file change events.

Exit criterion: settings, keybindings, snippets, tasks, prompts, named profiles,
and associations survive a browser-profile change and server restart.

### Phase 3 — Server state databases

- Implement a Hucode-owned, Node-safe storage database host under
  `WebUser/State`; do not copy or import Electron-main services.
- Register the `storage` channel only for Hucode server-user-data mode, or use a
  Hucode-specific channel name if collision risk makes that safer.
- Select `RemoteStorageService` in `BrowserMain.createStorageService()` for
  server mode.
- Add external-change events for workspace storage as a standalone generic,
  upstream-quality change and test multiple clients.
- Implement shutdown drain, error handling, path validation, and diagnostics.

Exit criterion: application/profile/workspace state and extension state survive
browser-profile changes, device changes, and server restart, with observable
updates between concurrently connected clients.

### Phase 4 — Migration

- Implement browser inventory and meaningful-data detection.
- Serialize supported files, profiles, associations, and state scopes.
- Implement staged upload, lease renewal, atomic commit, cleanup, and migration
  summaries.
- Keep browser data untouched and exclude secrets/authentication state.
- Cover cancel, start-fresh, retry, crash recovery, and competing-browser paths.

Exit criterion: an existing browser profile can opt into server mode without
losing supported data, and no interrupted or competing migration can expose a
partial generation.

### Phase 5 — Product integration and documentation

- Ensure regular, Omni shell, hosted Omni, and `--no-omni` entrypoints share
  the same provider-selection and bootstrap path.
- Update reset wording and add a user-visible diagnostic showing current mode
  and server namespace path.
- Update `docs/hucode/architecture.md`, CLI/serve-web documentation, and
  operational security notes.
- Register non-trivial upstream patches and their suites in
  `build/hucode/upstream-provenance.json`.
- Record the final upstream touch list and any deviation from the expected
  touch budget in the implementation PR.
- Add a `.changes` fragment when implementation is prepared as a `feat:` PR.

Exit criterion: behavior and limitations are discoverable without reading code,
and all Hucode web entrypoints satisfy the same contract.

## Validation strategy

### Focused unit and integration coverage

- CLI parsing: omitted flag, both valid values, invalid value, forwarding, and
  coexistence with `--server-data-dir` and `--no-omni`.
- Bootstrap manifest: empty initialization, lease expiry, generation mismatch,
  staged cleanup, atomic commit, corrupt manifest, and path traversal attempts.
- Profile files: read/write/watch/delete, named profiles, associations, atomic
  replace, and two-client change observation.
- State protocol: application, application-shared, profile, and workspace
  scopes; compare-and-swap; concurrent clients; external changes; shutdown
  flushing; invalid profile/workspace identifiers.
- Migration: no-data fast path, successful import, start fresh, cancel, browser
  data retained, secrets excluded, unsupported database enumeration fallback,
  upload failure, commit failure, stale lease, crash recovery, and two-browser
  first-commit-wins race.
- Regression: browser mode continues using IndexedDB and remains isolated
  between browser profiles.
- Integration seams: the real `BrowserMain` backend selection defaults to
  browser, selects server only from trusted configuration, and constructs each
  backend with the required profile, environment, remote, and lifecycle
  dependencies.
- Upgrade tripwires: provenance detects a changed upstream source blob, and
  contract tests fail when backend selection, server channel registration, or
  workspace external-change wiring is removed.

### End-to-end browser coverage

Use two isolated browser profiles against one server data directory:

1. In browser mode, confirm the existing isolation behavior remains the
   default.
2. In server mode, change settings, keybindings, snippets, a named profile,
   representative UI state, extension `globalState`, and extension
   `workspaceState` in browser A.
3. Open browser B and confirm it observes the same committed data.
4. Restart the server and confirm both browsers restore it.
5. Store a test secret/auth token in browser A and confirm browser B does not
   receive it.
6. Exercise `/`, `/workbench`, Omni shell, hosted workbench, and `--no-omni`.
7. Repeat with two simultaneously connected clients writing different keys,
   then the same key, and verify the documented last-write semantics.
8. Exercise migration with two browser profiles racing to initialize one empty
   server and verify only one complete generation becomes visible.

Run the relevant TypeScript compile, Rust tests, focused Node/Electron/browser
suites, generated Hucode suite snapshot checks when new suites are added,
`npm run hucode:validate`, and the repository precommit hygiene path for every
edited file. Run the upstream-provenance check against the current clean
baseline and inspect the final diff against that baseline. Record exact
commands, results, upstream files, and rationales in the implementation PR.

## Acceptance criteria

- Omitting the flag preserves current browser-local behavior.
- `--user-data-storage=server` makes one server namespace authoritative for
  profile files, profile metadata, application/profile/workspace state, and
  extension global/workspace state.
- A second browser or device sees committed server data without copying browser
  storage manually.
- Data survives a clean server restart and expected abrupt-process recovery.
- Secrets, authentication sessions, cookies, and connection credentials remain
  browser-local and are never included in migration payloads.
- An uninitialized server plus meaningful browser data prompts before normal
  workbench storage starts.
- Migration is atomic, keeps the browser source intact, and handles two-client
  races without overwrite or partial visibility.
- A ready server always wins at startup; browser data is neither merged nor
  silently uploaded.
- Backend failure never silently switches storage modes.
- Regular workbench, Omni shell, hosted workbench, and `--no-omni` use the same
  selected mode.
- Server paths and storage identifiers are confined and validated.
- Documentation states the single-user/token-sharing model and the exact
  browser-local secret boundary.
- No upstream module is copied or forked for this feature, and Hucode policy is
  confined to Hucode-owned or clearly named `hucode*` files.
- Upstream-owned files contain only narrow generic construction, registration,
  or delegation changes; every non-trivial patch has provenance and a contract
  test at the real integration seam.
- The implementation PR records the exact upstream touch list and explains any
  deviation from the documented touch budget.
- CLI/configuration, generic browser seam, server backend, generic workspace
  notifications, and migration UX remain separate durable replay topics.

## Non-goals

- Multi-account user partitioning inside one serve-web process.
- Syncing between different Hucode servers.
- Bidirectional merge or conflict-resolution UI.
- Moving secret storage or authentication sessions to the server.
- Replacing VS Code Settings Sync.
- A general backup/export/import feature.
- Automatically deleting browser data after migration.
- Making server mode the default in the first release.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Partial migration becomes authoritative | Stage by generation and atomically commit the manifest |
| Two browsers initialize simultaneously | Server lease plus generation CAS; first complete commit wins |
| Silent fallback creates divergent histories | Fail closed with retry in server mode |
| Existing remote extension data makes server appear non-empty | Separate `WebUser` namespace and explicit manifest |
| Generic storage IPC permits arbitrary paths | Resolve IDs against the server catalog and confine all paths |
| Workspace changes do not reach another browser | Add workspace external-change events to the common client/protocol |
| Browser startup writes before migration choice | Run bootstrap before profile/file/storage service construction |
| Users assume credentials roam | Explicit prompt/docs and tests proving secret isolation |
| Switching back to browser shows stale data | Document mode as separate authorities; no implicit merge |
| Server access is shared by multiple people | Document first version as single-user and require connection-token security |
| A clean VS Code replay silently changes bootstrap behavior | Contract-test the real construction and registration seams and track their upstream blobs |
| Hucode policy spreads through central upstream files | Enforce the upstream touch budget and delegate into Hucode-owned modules |
| A copied upstream storage implementation drifts | Use Node-safe primitives behind a Hucode-owned host; do not fork Electron services |
| Feature history becomes an indivisible replay commit | Preserve the documented durable topic boundaries |

## Decisions to confirm during plan review

There are no blocking product questions. The following are recommended defaults
that can be renamed or tightened during implementation review without changing
the architecture:

- public flag name: `--user-data-storage=browser|server`;
- server namespace: `<server-data-dir>/data/WebUser`;
- unsupported IndexedDB enumeration fallback: migrate global/profile state and
  the current workspace, then report inactive workspace state left behind;
- conflict semantics: last-successful-write-wins, with no field-level merge;
- backend outage semantics: retry/error UI, never automatic browser fallback;
- fork-maintenance priority: minimize Hucode-specific behavior in upstream
  files rather than minimizing the raw number of upstream files touched;
- live workspace-state propagation remains in the first version as a standalone
  generic patch suitable for an upstream contribution.

## External precedent

- code-server redirects web profile resources to a remote user-data URI, which
  validates the direct-provider approach but does not cover all workbench
  state: <https://github.com/coder/code-server/blob/main/patches/local-storage.diff>
- VS Code removed its web `--user-data-dir` option after confirming it was not
  implemented, so Hucode should introduce a working mode contract rather than
  revive the misleading flag:
  <https://github.com/microsoft/vscode/issues/238303> and
  <https://github.com/microsoft/vscode/pull/239731>
