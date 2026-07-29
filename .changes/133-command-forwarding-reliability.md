fix(omni): harden command forwarding ownership and fallback

Isolate command-forwarding suppression per renderer and recover clipboard
commands locally when workspace forwarding fails.
