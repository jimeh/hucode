feat(deps): upgrade VS Code baseline to 1.141.2

Upgrade the underlying VS Code baseline to 1.141.2. This includes upstream's
fix for webview resources failing to load from remote workspaces whose
authority uses mixed case, such as WSL and SSH remotes.
