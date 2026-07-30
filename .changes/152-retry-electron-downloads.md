fix(ci): retry transient Electron downloads

Release builds now retry Electron downloads before packaging so temporary
network timeouts do not fail the entire platform build.
