fix(omni): apply the desktop extension policy to the web shell

The web Omni shell loaded built-in extensions it has no surface for. Copilot
Chat enumerated every saved session and force-opened each repository through
the Git extension, and each opened repository took a recursive filesystem
watcher; an empty shell consumed roughly 291,600 of the host's inotify watches
and broke unrelated development servers with ENOSPC.

Desktop already skipped these built-ins, but through `skipBuiltinExtensions`,
a native scanner setting the server-web extension scanner never reads. The
shell now drops them at enablement instead, which keeps them out of the
extension registry and therefore out of the remote extension host. Hosted
workbenches and the standalone workbench route are unaffected.
