fix(omni): apply the desktop extension policy to the web shell

The web Omni shell loaded built-in extensions it has no surface for. Copilot
Chat enumerated every saved session and force-opened each repository through
the Git extension, and each opened repository took a recursive filesystem
watcher; an empty shell consumed roughly 291,600 of the host's inotify watches
and broke unrelated development servers with ENOSPC.

Desktop already skipped these built-ins from its *local* scan, through
`skipBuiltinExtensions` — a native scanner setting the server-web extension
scanner never reads, and one that never applied to remotely scanned extensions
either. The shell now drops them at enablement instead, which keeps them out of
the extension registry and therefore out of the extension host, on both
platforms and for both local and remote extensions. Hosted workbenches and the
standalone workbench route are unaffected.
