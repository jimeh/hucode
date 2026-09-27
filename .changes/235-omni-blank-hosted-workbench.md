fix(omni): keep workbenches visible after shell overlays close

Closing a shell dialog or quick pick no longer leaves the active workbench as a
blank gray area until the window is resized. The Omni shell also stops
capturing the active workbench every second, and captures it only when an
overlay is about to cover it.
