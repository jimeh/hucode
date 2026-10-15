perf: replace synchronous filesystem calls in serve-web and hosted workbenches

`hucode serve-web` no longer blocks its server process on synchronous file
reads and writes for project state, server-side user data, profile catalogs,
or Git metadata watching. On desktop, the Electron main process no longer runs
synchronous folder checks when attaching, reloading, or recovering a crashed
hosted workbench.
