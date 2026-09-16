# Desktop first-launch onboarding

New Hucode desktop user-data installations open the existing onboarding modal
after the Omni shell restores. Existing installations without an onboarding
record stay unchanged. **Hucode: Open Onboarding** remains available manually.
Serve-web keeps its existing startup behavior.

## Admission and completion

Application storage seeds `inProgress/bring` before writing its ordinary
new-installation marker and before main admits windows. The seed survives a
skip-welcome launch, which defers automatic presentation until an eligible
launch. A main-owned coordinator admits one trusted Omni shell per process,
allows that owner to resume on reload, and releases ownership on close or crash.
Hosted, regular, auxiliary, and extension-test windows do not auto-open it.

The shared modal opener serializes startup with manual import and onboarding
commands. An existing setup input is revealed. Closing during restoration or
admission prevents a late modal from appearing. Dismissal does not reopen it in
the same window lifecycle; reload or relaunch can resume it.

| Stored state | Automatic behavior |
| --- | --- |
| Missing on an existing installation | Leave unchanged |
| Valid `notStarted` or `inProgress` | Open or resume |
| `completed` or `skipped` | Leave closed |
| Malformed | Preserve bytes, log one diagnostic without contents, leave closed |
| Newer schema | Preserve bytes and leave closed |

Do This Later, Escape, the close button, and outside-click preserve a resume
point. Skip Import chooses appearance and Meet Omni; it does not complete
onboarding. Explicit Skip records `skipped`. Finish, Add Project, and Open Folder
as Workbench record `completed` before closing and starting any folder picker.
Cancelling that picker leaves onboarding completed. Dismissing a manual rerun
preserves the earlier terminal record.

Native Hucode never starts upstream experimental onboarding automatically.
Automatic Getting Started/Copilot-first selection is also suppressed throughout
the first process, including children opened after completion. Later processes
retain their normal configured startup behavior. Manual Getting Started,
onboarding, account, Sync, and Copilot commands remain registered.

## Persistence and recovery

The record uses application storage with the MACHINE target. Version 2 adds an
optional `handoffProfileId` and an `importHadIssues` flag to navigation state.
Version 1 is read and upgraded on the next legitimate write. Newer versions are
not downgraded.

Main serializes onboarding writes and acknowledges the underlying persistent
database update plus readback before publishing accepted cache state. It rejects
in-memory fallback and closing storage. Ordinary `whenFlushed()` is insufficient
because its waiters settle even after failed writes; SQLite can also swallow
statement errors, which makes readback necessary. Retrying performs a real write
even when the requested value matches a previous attempt. A failed checkpoint
leaves the current step open with a visible retry path.

The acknowledged storage API assumes one ordering authority per key. The
onboarding coordinator owns this record; ordinary buffered writers must not
write it independently.

A restored `migrate` stage initializes the existing migration flow immediately.
That flow reads its durable journal and presents recovery choices or results.
Navigation never invokes Apply, Retry, Resume, rollback, or acknowledgement.
Without a recoverable operation, the user must discover, plan, and review again.
Continue keeps recovery data available through the standalone import command.

## Exact folder/profile handoff

Continue from settled, attached, non-rolled-back results may retain the actual
target profile ID. Only a currently existing ordinary non-Default profile is
offered. Skip Import and distinct reruns clear the reference. Deleted, transient,
agents, Default, and rolled-back targets produce no offer. Partial results retain
a visible warning at Meet Omni.

Add Project uses the updated catalog to resolve the selected worktree. A
repository-root selection falls back to a valid last-active worktree, then the
main worktree, or asks the user to choose. Open Folder as Workbench uses the same
typed folder selection and canonicalization as its ordinary command.

The offer names the canonical folder and imported profile. Keeping the existing
association is first and safe; replacing a different profile requires another
explicit confirmation. Main rechecks the expected association and profile under
the same path reservation that guards owner creation. A conflict is returned to
the caller for a fresh choice. The profile state file is written and read back
before native workbench configuration is created. Failed persistence restores
the prior in-memory association and attempts to persist that restoration without
overwriting a concurrent different association.

Only that folder receives the association. Sibling worktrees and the Default
shell remain unchanged. An existing normal or hosted owner is focused without
an offer, profile write, or reload. If an owner appears while confirmation is
open, admission follows that same focus-only path. If association succeeds but
opening fails, the error explicitly says the profile was saved and opening
failed.

The privileged methods belong only to the trusted shell/main facade. The
hosted-workbench channel receives no profile mutation authority.

## Verification

Focused suites cover admission and failed checkpoint retry, navigation and
recovery, folder offers and conflicts, file persistence, startup suppression,
modal serialization, and owner reservation before native view creation. The
suite snapshot records their CI runner assignments. Linux desktop checks must
use isolated user-data and source fixtures, build Copilot separately, and include
whole-process termination after acknowledged checkpoints. Renderer termination
alone leaves main storage alive and does not prove disk durability.

Build with `npm run hucode:compile` and `npm run compile-copilot`, then run
`mise run test:onboarding-desktop`. On a headless Linux host, use
`ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a mise run test:onboarding-desktop`.
The task prepares the Hucode Electron binary and requires bubblewrap for the
synthetic import phase. It masks the real home directory, mounts only the
checkout back into it, and uses temporary source, user, shared, and extension
paths. It retains screenshots and app logs under the printed temporary root.

The smoke reads SQLite only after stopping the app. It covers initial and
terminal process-kill durability, dismissal and native reload, explicit Skip,
pre-Apply review, journal recovery without reapplying, and an explicit imported
profile on the selected linked worktree. The ordinary Linux Omni lifecycle
smoke separately covers hosted unload, suspension, renderer crash, and recovery.

Native macOS and Windows focus and folder-dialog behavior require platform spot
checks before release.
