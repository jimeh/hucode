perf(omni): resolve desktop workbench paths asynchronously

The desktop Electron main process no longer resolves workbench folder paths
with a synchronous `realpath` when it decides which window owns a folder,
restores hosted workbenches, or reconciles regular windows. Restoring several
windows now resolves each path once instead of once per candidate comparison.
