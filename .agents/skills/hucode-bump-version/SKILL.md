---
name: hucode-bump-version
description: Bump Hucode's app release version and prepare release metadata. Use when the user asks to bump Hucode version, prepare a Hucode patch release, consume Hucode .changes fragments, update CHANGELOG.md for a Hucode release, or create the release commit after feature/fix work is ready to ship.
---

# Hucode Version Bump

## Core Rule

Use the release helper first when change fragments exist. Do not hand-edit only
`build/hucode/mixin/stable/product.json` and stop there, because fragment-backed
releases must also update `CHANGELOG.md` and delete consumed `.changes` files.

Hucode's release version is `hucodeVersion` in:

```text
build/hucode/mixin/stable/product.json
```

Do not bump root `package.json` `version` or root `product.json`; those stay on
the upstream VS Code compatibility line.

## Preflight

Read `AGENTS.md` and `docs/hucode/agent-instructions.md` before editing.
Confirm branch and dirt:

```sh
git status --short --branch
rg --files .changes -g '*.md' -g '!README.md'
node -e "const p=require('./build/hucode/mixin/stable/product.json'); console.log(p.hucodeVersion)"
```

If the user does not provide a target version, bump the patch component of the
current `hucodeVersion` unless nearby release context clearly calls for a
different semver bump.

## Fragment-Backed Release

When `rg --files .changes -g '*.md' -g '!README.md'` returns fragments, use the
helper:

```sh
npm run hucode:prepare-release -- --version <target-version>
npm run hucode:prepare
npm run hucode:validate
```

Then run the repository hygiene path on the release artifacts. If changes are
already staged, follow `AGENTS.md` and run full `npm run -s precommit`.
Otherwise run targeted hygiene on:

```sh
npm run -s precommit -- CHANGELOG.md build/hucode/mixin/stable/product.json <consumed-.changes-files>
```

Expected diff shape:

- `CHANGELOG.md` gains the new version section with today's date.
- `build/hucode/mixin/stable/product.json` changes only `hucodeVersion`.
- Consumed `.changes/*.md` fragments are deleted.

If `hucode:prepare-release` fails with a missing package such as
`@commitlint/parse`, run `npm install`, re-check `git status --short`, then
retry without widening the release diff.

## No Fragment Present

If there are no `.changes` fragments and the user asked for a release bump,
pause and ask whether this should be a metadata-only bump or whether a fragment
is missing. A metadata-only bump will not update `CHANGELOG.md`.

For an explicitly metadata-only bump:

1. Edit only `hucodeVersion` in
   `build/hucode/mixin/stable/product.json`.
2. Run:

   ```sh
   npm run hucode:prepare
   npm run hucode:validate
   npm run -s precommit -- build/hucode/mixin/stable/product.json
   ```

3. Report that no changelog entry was generated because no `.changes` fragment
   was consumed.

## Commit

Commit only when the user asks. Use the release scope:

```text
CHANGELOG.md
build/hucode/mixin/stable/product.json
<consumed .changes deletions>
```

Use the existing release subject style:

```text
chore(release): bump Hucode to <target-version>
```

Start the commit body with why the release metadata is being prepared, then
summarize the fragment consumption, changelog entry, and overlay bump.
