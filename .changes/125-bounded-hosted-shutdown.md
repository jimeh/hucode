perf(omni): bound hosted-workbench shutdown latency

Shut down resident hosted workbenches concurrently so an unresponsive
workbench no longer multiplies Omni shell shutdown delays, while preserving
each platform's veto and restore-state behavior.
