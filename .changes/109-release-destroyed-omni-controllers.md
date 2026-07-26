fix(omni): release destroyed hosted workspace controllers

Closing an Omni-window disposed its hosted workspace controller but left the
shell service holding a reference to it, so one disposed controller per closed
window was retained for the lifetime of the main process.
