/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import { fileURLToPath } from 'url';
import { getVersion } from '../lib/getVersion.ts';
import { runEsbuildBundle } from '../lib/esbuild.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const commit = getVersion(repoRoot);
const isCI = Boolean(
	process.env.CI
	|| process.env.BUILD_ARTIFACTSTAGINGDIRECTORY
	|| process.env.GITHUB_WORKSPACE
);
const sourceMapBaseUrl = isCI
	? `https://main.vscode-cdn.net/sourcemaps/${commit}/core`
	: undefined;

await runEsbuildBundle(
	'out-vscode-min',
	true,
	true,
	'desktop',
	sourceMapBaseUrl
);

await runEsbuildBundle(
	'out-vscode-reh-web-min',
	true,
	true,
	'server-web',
	sourceMapBaseUrl
);
