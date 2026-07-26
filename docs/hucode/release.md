# Hucode Release Guide

Hucode has two related versions:

- Root `package.json` `version` is the selected upstream VS Code compatibility
  version.
- `build/hucode/mixin/stable/product.json` `hucodeVersion` is the Hucode app
  release version shown to users and used by Hucode packages.

Do not bump the root version to prepare a Hucode release.

## Change Fragments

User-visible changes are collected in `.changes/*.md`. Pull requests titled
with `feat`, `fix`, `perf`, `revert`, or a breaking `!` marker require a
fragment. Its first non-empty line must match the pull request's Conventional
Commit header.

Before a pull request number exists, use a descriptive unnumbered filename. It
may be renamed to `.changes/<pr-number>-<slug>.md` later.

Prepare release metadata with:

```sh
npm run hucode:prepare-release -- --version <version>
```

This consumes the fragments, updates `CHANGELOG.md`, and changes
`hucodeVersion`. Review those changes together, then run:

```sh
npm run hucode:prepare
npm run hucode:validate
```

For the complete release-commit procedure, use the project-local
[`hucode-bump-version`](../../.agents/skills/hucode-bump-version/SKILL.md)
skill.

## Local Release Builds

Useful entry points are:

- `npm run hucode:build:production` builds a minified desktop app into `dist/`.
- `npm run hucode:build:release` also creates the default archive.
- `node build/hucode/release-build.ts --phase build` assembles the unsigned app
  in the upstream handoff directory.
- `node build/hucode/release-build.ts --phase package --artifacts <list>`
  packages an already assembled app.

Local release builds strip packaged source maps by default. Pass
`--include-source-maps` only when the output is specifically intended for
debugging. A local build without `--copilot-vsix <path>` packages Copilot from
source and can be substantially larger than CI output.

## CI Release Shape

The `Hucode release build` workflow builds a target matrix, compiles Copilot
once as a production VSIX, injects that VSIX into each desktop app, produces
size reports, and smoke-tests the Linux packages before publication. App
assembly and packaging are separate phases so signing happens only after the
payload is final.

Every published tag release must contain:

| Product | Public targets |
| --- | --- |
| macOS desktop | x64 and arm64 DMG plus ZIP |
| Linux desktop | x64 and arm64 ZIP, DEB, and RPM |
| Standalone CLI | macOS, Linux, and Windows x64 and arm64 |
| Server-web | macOS, Linux, and Windows x64 and arm64 |
| Metadata | release metadata and `SHA256SUMS` |

The workflow can build additional internal matrix targets, but Windows desktop
and Linux armhf are not part of the required public release asset contract.
Linux armhf also has no standalone CLI or server-web archive.

The canonical public asset list and checksum validation live in
`build/hucode/release-assets.ts`. Treat that machine-checked list as the source
of truth if this summary and the build disagree.

## Signing and Publication

macOS publication signs the app before packaging, then signs, notarizes,
staples, and validates DMGs. Release CI uses a temporary keychain; local
signing uses the current keychain search list and explicit Apple credentials.

The publication job gathers the required public assets, generates checksums,
verifies the complete set, and publishes the GitHub Release. Update-service
metadata is generated from those verified assets rather than inferred from
arbitrary workflow artifacts.

### Verifying Release Provenance

`SHA256SUMS` proves that a download matches what the release lists, but not
that the release itself came from this repository's build. The publication job
therefore records a GitHub build provenance attestation for every asset listed
in `SHA256SUMS`.

Verify a downloaded asset against it:

```sh
gh attestation verify hucode-linux-x64.zip --repo jimeh/hucode
```

This succeeds only when the file's digest matches an attestation GitHub issued
to a workflow run in `jimeh/hucode`. A tampered or substituted asset fails with
`no attestations found` — its digest is simply not in any attestation. Add
`--format json` to inspect the workflow, commit, and run that produced it.

`SHA256SUMS` is attested too, so it can serve as a root of trust when checking
downloads by hand:

```sh
gh attestation verify SHA256SUMS --repo jimeh/hucode
```

That needs its own attestation because a checksums file cannot list itself.
Every published asset is covered: the release assets through the digests
recorded in `SHA256SUMS`, and `SHA256SUMS` through a second attestation over
the file. Verification therefore works directly against the artifact you
downloaded rather than against a file that merely vouches for it.

Attestation is currently **non-blocking**: a failure is reported but does not
stop a release. That is deliberate while the wiring proves itself across a real
tag build — a misconfiguration should not strand a release that is otherwise
ready.

Because `continue-on-error` would otherwise make a failure look like success,
the job writes a warning and a step-summary entry when either attestation
fails, naming which one.

The two are independent, so a partial failure still leaves a working path. If
only the `SHA256SUMS` attestation failed, per-asset verification is unaffected.
If only the per-asset attestation failed, `SHA256SUMS` is still attested, so
checking a download against it by hand remains trustworthy. The step summary
spells out which applies. In either case the assets themselves are fine —
a failed attestation says nothing about the download.

Once a tag build has produced attestations that actually verify, remove
`continue-on-error` from both attest steps so a release cannot silently ship
without provenance.

## Updates

Stable builds use `https://updates.hucode.dev`.

- macOS uses signed ZIP assets for Squirrel.Mac automatic updates. DMGs remain
  manual installation assets.
- Linux x64 and arm64 builds report available versions in Hucode, then open the
  latest GitHub Release so the user can choose a ZIP, DEB, or RPM. Hucode does
  not modify package repositories or guess the installed package format.
- `hucode serve-web` resolves the matching server-web archive through the
  update service.

The machine-facing update routes are part of this contract:

- Desktop update checks use
  `/api/update/<platform>/<quality>/<commit>`. Stable macOS builds use `darwin`
  for x64 and `darwin-arm64` for arm64 as the platform segment.
- The CLI resolves server-web builds through
  `/api/latest/server-<platform>-<arch>-web/<quality>`, such as
  `/api/latest/server-linux-x64-web/stable`.

Builds from before the product overlay acquired `updateUrl` cannot discover a
new release automatically; the first updater-enabled build is the bootstrap
for later upgrades.

For the historical size investigation that shaped the current pipeline, see
[Release Build Size Analysis](archive/release-build-size-analysis.md). Its
measurements and interim recommendations are preserved as history, not as the
current release contract.
