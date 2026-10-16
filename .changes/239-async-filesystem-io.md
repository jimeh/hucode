perf: replace Hucode synchronous filesystem calls with async I/O

`hucode serve-web` no longer blocks its server process on synchronous file
reads and writes for project state, server-side user data, profile catalogs,
or Git metadata watching. On desktop, the Electron main process no longer runs
synchronous folder checks or `realpath` calls when it attaches, reloads, or
recovers a hosted workbench, decides which window owns a folder, or restores
windows. Restoring several windows now resolves each folder path once instead
of once per candidate comparison.
