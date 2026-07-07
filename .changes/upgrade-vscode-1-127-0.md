feat(deps): upgrade VS Code baseline to 1.127.0

Rebase the Hucode patch series onto upstream VS Code 1.127.0. Adapts the
Omni bootstrap to the removal of the remote file-system proxy, documents
the new managed-settings channels as deliberate Omni omissions, mirrors
the new onboarding contribution into the Omni common entrypoint, and
disables the new upstream `require-commit-trailer` workflow.
