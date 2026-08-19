fix(web): prevent mixed Hucode versions in Omni

Keep the Omni shell and its hosted web workbenches on the same Hucode build,
and require a full browser reload if their versions do not match.

When using `--server-base-path`, update the `hucode` CLI with this release;
older CLI binaries cannot route the new build-pinned web paths.
