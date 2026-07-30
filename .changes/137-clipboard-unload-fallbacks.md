fix(omni): preserve clipboard and unload fallbacks

Keep local clipboard fallbacks from being forwarded recursively, and make
hosted unload commit failures follow the shell's remove-anyway recovery path.
