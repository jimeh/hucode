fix(projects): prevent Git operations from hanging

Project and worktree Git operations now enforce per-operation timeouts and
output limits, disable interactive credential prompts, and support
cancellation without leaving child process trees running.
