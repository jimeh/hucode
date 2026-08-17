fix(omni): restore stalled desktop hosted-shell commands

Desktop hosted workbenches now reconnect promptly when their narrow shell
command channel closes, without invalidating healthy connections during
subframe activity.
