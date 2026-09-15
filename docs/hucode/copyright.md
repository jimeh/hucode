# Copyright Policy

Hucode combines inherited Code OSS work with original Hucode additions. Both
are distributed under the repository's MIT License, but their copyright
notices must reflect their provenance.

## File Classification

Use these classifications when adding or moving files:

| Provenance | Required notice |
| --- | --- |
| Unchanged or modified Code OSS work | Microsoft |
| Original Hucode work | Hucode contributors |
| Materially copied or adapted Code OSS work | Microsoft and Hucode contributors |
| Third-party work | Preserve the third-party notice |
| Format without a practical inline notice | None; `LICENSE.txt` applies |

Using VS Code APIs, implementing its interfaces, following its architecture,
or matching nearby conventions does not make original code Microsoft work.
Copying or closely adapting implementation, comments, templates, markup, or
other expressive material does require preserving Microsoft's notice.

Do not add a Hucode line to every modified upstream file. Preserve its
Microsoft notice; repository-level attribution covers Hucode modifications.

## Exact Source Headers

Original Hucode source files use:

```text
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
```

Materially derived source files use:

```text
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
```

Inherited Code OSS source files retain Microsoft's existing header and its
`License.txt` spelling. Preserve a file format's established comment syntax.

## Generated And Non-Source Files

JSON, Markdown, lockfiles, binaries, generated image assets, and similar
formats generally do not carry inline notices. Attribute their tracked source
or generator where practical and rely on `LICENSE.txt` for the repository
notice.

Generated files inherit the provenance of the expressive input, not merely the
generator executable. Preserve notices embedded by third-party generators.

## Contributions

Unless stated otherwise, contributions submitted to Hucode are provided under
the MIT License. Contributors retain copyright in their work; Hucode does not
require copyright assignment.

When provenance is unclear, inspect the file's introducing commit and compare
it with the upstream baseline before choosing a notice. Similarity tools are
evidence, not a substitute for review.
