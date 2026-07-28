fix(projects): preserve worktrees through transient Git failures

Keep last-known-good worktrees and metadata watchers visible when Git discovery
temporarily fails, expose stale and unavailable states in the project switcher,
and recover through cancellable bounded backoff.
