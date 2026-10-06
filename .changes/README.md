# Hucode Change Fragments

Pull requests that should appear in Hucode release notes add a change fragment
under this directory.

Name fragments with the pull request number and a short lowercase slug when the
PR already exists:

```text
.changes/1234-publish-macos-releases.md
```

For work prepared before a PR number exists, use only the short lowercase slug:

```text
.changes/upgrade-vscode-1-122-0.md
```

The first non-empty line must be a Conventional Commit header using the same
type, scope, breaking marker, and subject as the pull request title:

```md
feat(release): publish macOS GitHub releases

Release tags now create GitHub Releases and upload signed macOS DMG assets.
```

Fragments are required for `feat`, `fix`, `perf`, `revert`, and every breaking
change. Fragments are optional for `build`, `chore`, `ci`, `docs`, `refactor`,
`style`, and `test`; if present, release prep includes them in the generated
`CHANGELOG.md`.
