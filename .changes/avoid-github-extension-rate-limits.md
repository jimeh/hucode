fix(build): avoid GitHub API rate limits for built-in extensions

Download pinned built-in extensions directly from their checksum-verified
GitHub release assets. Authenticate the remaining latest-release API requests
with `GITHUB_TOKEN` or `GH_TOKEN` when available.
