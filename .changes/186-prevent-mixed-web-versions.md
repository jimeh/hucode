fix(web): prevent mixed Hucode versions in Omni

Keep the Omni shell and its hosted web workbenches on the same Hucode build,
and require a full browser reload if their versions do not match.
