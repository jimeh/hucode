fix(projects): harden serve-web operation lifecycles

Bound serve-web Git work, preserve completed worktree mutations across
disconnects and refresh failures, and publish project events only after state
is durable.
