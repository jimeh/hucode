feat(deps): upgrade VS Code baseline to 1.128.0

Rebase the Hucode patch series onto the upstream VS Code 1.128.0 release.
Notable adaptations:

- Adopt upstream's deferred first-show behavior for browser views in the
  Hucode `BrowserViewNativeHost` (initial view bounds are now on-screen
  placeholders that must not be shown before the first real layout).
- Mirror the new system-wide (OS global) keybindings contribution into the
  Omni desktop entrypoint.
- Forward upstream's `systemWideKeybinding` run-action source through Omni
  command forwarding without appending a `{ from }` argument sentinel.
