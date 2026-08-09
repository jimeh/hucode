fix(omni): harden shell capability recovery

Recover the desktop shell capability after transient connection failures,
enforce its declared remote surface, and require the current typed serve-web
hosted-shell protocol.
