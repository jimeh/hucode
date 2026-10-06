# Copyright Attribution Audit Plan

> Historical record. The completed audit is in
> [Copyright Attribution Audit](copyright-audit-1.129.1.md), and
> [Copyright Policy](../copyright.md) is the current source of truth.

## Objective

Correct copyright attribution across the Hucode patch set while keeping all
Code OSS and Hucode work under the MIT License.

The audit compares the current Hucode series with its immutable upstream
baseline:

- Upstream VS Code 1.129.1:
  `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8`
- Hucode series audit tip:
  `78a63c324bc2762996733befdbaef4e960b97562`

The initial diff contains 482 paths: 256 added, 121 modified, 87 deleted, and
18 renamed.

This is a historical audit of that pinned Hucode tree. Files created by the
attribution implementation itself must follow the resulting policy, but do
not change the 482-record audit boundary.

## Attribution Policy

Classify every path in the baseline diff:

| Provenance | Inline notice |
| --- | --- |
| Unchanged or modified upstream work | Preserve Microsoft |
| Original Hucode work | Hucode contributors |
| New file derived from upstream work | Microsoft and Hucode contributors |
| Third-party work | Preserve the third-party notice |
| Format without a practical inline notice | None; central attribution applies |
| Deleted path | No action |

Using VS Code APIs, implementing its interfaces, following its architecture,
or matching its conventions does not alone make a new file derived. Copying or
closely adapting implementation, comments, templates, markup, or other
expressive material does.

Use this notice for original Hucode source files:

```text
Copyright (c) Hucode contributors. All rights reserved.
Licensed under the MIT License. See LICENSE.txt in the project root for license information.
```

For a materially derived new file, retain the Microsoft line and add the
Hucode contributors line before the shared MIT license pointer. Preserve a
source format's established comment syntax.

Do not add a Hucode line to every modified upstream file. The Microsoft notice
remains in those files, while the repository-level notice covers Hucode's
modifications.

## Audit Procedure

1. Generate the complete name-status diff between the pinned commits.
2. Record every diff path exactly once in the audit report.
3. Apply the status defaults:
   - modified and renamed upstream paths preserve their notice;
   - deleted paths require no action;
   - added paths require provenance review.
4. For each added path, inspect:
   - its introducing Hucode commit and original patch;
   - Git rename and copy-similarity candidates;
   - related upstream implementations and templates;
   - generators and source assets for generated output;
   - existing third-party notices.
5. Treat similarity detection as evidence, not a decision. Common imports,
   boilerplate, and the existing Microsoft header create false positives.
6. Apply header changes only after the corresponding audit record is complete.
7. Regenerate the baseline inventory and prove that the report covers it
   without missing or duplicate paths.

## Audit Report

Create the completed historical report at:

```text
docs/hucode/archive/copyright-audit-1.129.1.md
```

Its header must record the baseline commit, audited Hucode tip, generation
command, diff counts, policy version, and completion date.

Each diff record uses this schema:

| Field | Values or contents |
| --- | --- |
| Status | `added`, `modified`, `renamed`, or `deleted` |
| Path | Current path, or the deleted path when none exists |
| Source | Previous path, upstream source path, generator/input, or `-` |
| Provenance | One of the provenance values below |
| Notice | `microsoft`, `hucode`, `dual`, `third-party`, or `none` |
| Action | `preserve`, `replace`, `add`, or `none` |
| Evidence | Commit, comparison, generator, or status-default rationale |

Provenance values are:

- `upstream`
- `hucode-original`
- `mixed-derived`
- `third-party`
- `deleted`

Group records by provenance and sort paths lexically within each group. Every
path must occur exactly once. Evidence for an added path must support its
individual classification; a directory name is not sufficient evidence.

## Implementation

After the audit is complete:

1. Add Hucode contributors to `LICENSE.txt` without removing Microsoft's
   notice or changing the MIT terms.
2. Clarify Code OSS and Hucode ownership in the root README.
3. Add a current copyright policy under `docs/hucode/` and link it from the
   documentation map and agent instructions.
4. State that Hucode contributions are submitted under MIT in the contribution
   guidance, without introducing copyright assignment.
5. Update hygiene documentation that currently requires Microsoft attribution
   for all files.
6. Teach the hygiene validator to accept the exact Microsoft, Hucode, and dual
   header forms.
7. Apply the audited notice decision to every applicable file.
8. Move this completed plan into `docs/hucode/archive/`.

Keep the functional changes limited to copyright-header validation. Do not
combine the work with an SPDX migration, third-party notice overhaul, product
metadata cleanup, or unrelated source changes.

## Verification

- Compare the audit report's paths and statuses with a fresh diff between the
  two pinned commits.
- Reject missing paths, duplicate paths, unknown provenance values, and
  inconsistent provenance/notice combinations.
- Confirm all `hucode-original` source files use the Hucode notice.
- Confirm all `mixed-derived` source files retain Microsoft and add Hucode.
- Confirm modified and renamed upstream source files retain Microsoft.
- Add focused tests for accepted Microsoft, Hucode, and dual headers and for
  malformed-header rejection.
- Run the focused build-script tests for the header validator.
- Run the repository precommit hygiene path over every edited file.
- Run `git diff --check`.
- Review the attribution implementation's final diff against the audit report
  and policy before committing.

## Proposed PR Structure

1. `docs(license): define Hucode copyright policy and audit`
2. `chore(license): correct Hucode source attribution`

No release change fragment is expected for these `docs` and `chore` changes.

## Unresolved Questions

None. The agreed holder for Hucode work is `Hucode contributors`; inherited
Microsoft and third-party notices remain intact.
