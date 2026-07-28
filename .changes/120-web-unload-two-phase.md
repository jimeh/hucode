fix(omni): stop discarding hosted web workbench shutdown vetoes

Closing, suspending or dismissing a hosted workbench in the web Omni shell ran
the workbench's shutdown as its preflight. `BrowserLifecycleService.shutdown()`
collects every `onBeforeShutdown` veto and then throws it away, so a workbench
with a modified, unbacked-up working copy was shut down anyway and its iframe
removed. The same call was irreversible before the shell had decided the
workbench could go: an unload the shell then aborted — because the workbench
had been reactivated, or its path no longer matched — left a workbench that
looked live in the page but was dead and unresponsive.

Unload is now the two-phase handshake the desktop shell already uses.
Preparation asks the workbench for its veto without shutting it down, the shell
re-checks that nothing superseded the request, and only then does the workbench
commit. A vetoed or abandoned unload leaves the workbench running and usable —
its shutdown listeners still run, as they always have on the browser's own
unload path, and a few of those do not reset themselves — and a successful
unload shuts the workbench down exactly once, however many requests raced for
it.
