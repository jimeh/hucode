fix(omni): restrict hosted shell action forwarding

Hosted workbenches can only request the six shell actions they use, with the
shell owning command arguments and invocation metadata on desktop and web.
