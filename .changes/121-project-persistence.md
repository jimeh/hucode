fix(projects): make serve-web project state durable

Persist serve-web project mutations atomically before acknowledging them, preserve corrupt state without relocating transiently unreadable files, and validate worktree start points at the HTTP boundary.
