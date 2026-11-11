feat(deps): upgrade VS Code baseline to 1.146.0

Upgrade the underlying VS Code baseline to 1.146.0. Hucode now builds with pnpm, following the upstream move from npm, and an Omni window no longer restarts unattended to apply an update, because its shell cannot report the state of the workbenches it hosts.
