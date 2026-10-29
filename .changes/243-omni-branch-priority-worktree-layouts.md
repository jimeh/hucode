feat(omni): add branch-priority worktree layouts

The `hucode.omni.worktreeItemLayout` setting accepts `branchPriority` and
`compactBranchPriority`. Project worktree rows then lead with the branch. The
two-line layout shows the worktree name beside the branch and the path on the
second line; the compact layout shows the branch and path on one line. A
worktree with a custom name leads with that name instead.
