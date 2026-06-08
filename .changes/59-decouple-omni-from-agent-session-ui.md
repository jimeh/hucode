refactor: decouple Omni from agent-session UI

Omni now uses Hucode-owned shell entrypoints instead of carrying upstream
Agent Sessions UI plumbing that is not part of the Hucode Omni surface.
