fix(omni): allow independent serve-web tabs

Serve-web no longer requires Web Locks or blocks a workbench because another
browser tab appears to own the same path. Each Omni tab now manages its hosted
workbenches independently while still deduplicating concurrent opens locally.
