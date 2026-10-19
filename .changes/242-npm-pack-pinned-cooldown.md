fix(build): fetch integrity-verified package pins despite the npm release-age gate

Release builds no longer fail when a cross-build platform package, such as
`@github/copilot-sdk-linux-arm64`, is pinned to a version published less than
three days earlier. `npm ci` installs that pin, but the build's separate
`npm pack` fetch was rejected by the repository's `min-release-age` setting.
The fetch now skips the age gate when the tarball is verified against the
lockfile's `sha512` integrity, and keeps it otherwise.
