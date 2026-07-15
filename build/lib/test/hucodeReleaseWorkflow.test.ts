/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { readFileSync } from 'fs';
import path from 'path';

const workflowPath = path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'.github',
	'workflows',
	'hucode-release-build.yml'
);
const workflow = readFileSync(workflowPath, 'utf8');

suite('Hucode release workflow contract', () => {
	test('publishes only after packaged Linux smoke tests pass', () => {
		assert.match(workflow, /^  linux-package-smoke:$/m);
		assert.match(workflow, /needs\.linux-package-smoke\.result == 'success'/);
		assert.match(workflow, /needs:\n      - package\n      - linux-package-smoke/);
	});

	test('smokes clean DEB and RPM installs for public architectures', () => {
		for (const value of [
			".filter(item => item.platform === 'linux' && item.arch !== 'armhf')",
			".flatMap(item => ['deb', 'rpm'].map(format => ({",
			'linux_smoke_matrix:',
			'build/hucode/linux-package-smoke.sh'
		]) {
			assert.ok(workflow.includes(value), `Missing workflow contract: ${value}`);
		}
	});

	test('runs packaged Linux smoke tests for manual workflow builds', () => {
		const job = workflow.slice(
			workflow.indexOf('  linux-package-smoke:'),
			workflow.indexOf('  publish-release:')
		);
		assert.doesNotMatch(job, /github\.event_name == 'push'/);
		assert.match(job, /inputs\.linux_x64 \|\| inputs\.linux_arm64/);
	});

	test('prepares validated public assets and checksums before upload', () => {
		assert.match(
			workflow,
			/node build\/hucode\/release-assets\.ts[\s\S]*--artifacts release-artifacts[\s\S]*--out release-assets/
		);
		assert.match(
			workflow,
			/gh release upload "\$TAG_NAME" release-assets\/\* --clobber/
		);
	});
});
