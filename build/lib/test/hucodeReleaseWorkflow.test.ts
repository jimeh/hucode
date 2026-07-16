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
const smokeScript = readFileSync(path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'hucode',
	'linux-package-smoke.sh'
), 'utf8');

suite('Hucode release workflow contract', () => {
	test('publishes only after packaged Linux smoke tests pass', () => {
		const job = workflow.slice(
			workflow.indexOf('  publish-release:'),
			workflow.indexOf('  refresh-update-service:')
		);
		assert.match(workflow, /^  linux-package-smoke:$/m);
		assert.match(job, /github\.event_name == 'push'/);
		assert.match(job, /needs\.linux-package-smoke\.result == 'success'/);
		assert.match(job, /needs:\n      - package\n      - linux-package-smoke/);
	});

	test('smokes clean DEB and RPM installs for public architectures', () => {
		assert.match(
			workflow,
			/\.filter\(item => item\.platform === 'linux' && item\.arch !== 'armhf'\)/
		);
		assert.match(
			workflow,
			/\.flatMap\(item => \['deb', 'rpm'\]\.map\(format => \(\{/
		);
		assert.match(workflow, /linux_smoke_matrix:/);
		assert.match(workflow, /build\/hucode\/linux-package-smoke\.sh/);
	});

	test('runs packaged Linux smoke tests for manual workflow builds', () => {
		const job = workflow.slice(
			workflow.indexOf('  linux-package-smoke:'),
			workflow.indexOf('  publish-release:')
		);
		assert.doesNotMatch(job, /github\.event_name == 'push'/);
		assert.match(job, /inputs\.linux_x64 \|\| inputs\.linux_arm64/);
	});

	test('runs arm64 package smoke natively', () => {
		const job = workflow.slice(
			workflow.indexOf('  linux-package-smoke:'),
			workflow.indexOf('  publish-release:')
		);
		assert.match(workflow, /\? 'ubuntu-24\.04-arm'/);
		assert.match(workflow, /: 'ubuntu-latest'/);
		assert.match(job, /runs-on: \$\{\{ matrix\.runner \}\}/);
		assert.doesNotMatch(job, /setup-qemu-action/);
		assert.match(
			workflow,
			/copilot-vsix:[\s\S]*?runs-on: ubuntu-latest[\s\S]*?linux-package-smoke:/
		);
	});

	test('removes node_modules archives before release work', () => {
		const jobs = [
			workflow.slice(
				workflow.indexOf('  app-build:'),
				workflow.indexOf('  package:')
			),
			workflow.slice(
				workflow.indexOf('  package:'),
				workflow.indexOf('  linux-package-smoke:')
			)
		];
		for (const job of jobs) {
			const extractIndex = job.lastIndexOf('- name: Extract node_modules cache');
			const saveIndex = job.indexOf('- name: Save node_modules cache');
			const removeIndex = job.indexOf('- name: Remove node_modules archive');
			assert.ok(extractIndex >= 0);
			assert.ok(saveIndex > extractIndex);
			assert.ok(removeIndex > saveIndex);
			assert.match(
				job,
				/- name: Remove node_modules archive\n        if: matrix\.platform != 'win32'\n        run: rm -rf \.build\/node_modules_cache \.build\/node_modules_list\.txt/
			);
			assert.strictEqual(job.indexOf('- name: Remove node_modules archive', removeIndex + 1), -1);
		}
	});

	test('retries transient package smoke response parse failures', () => {
		assert.match(smokeScript, /if ! omni_count=.*jq/s);
		assert.match(smokeScript, /if ! identity_count=.*jq/s);
		assert.match(smokeScript, /continue/);
		assert.match(
			smokeScript,
			/cat "\$log_file" >&2\nexit 1/
		);
	});

	test('downloads only public-containing producer artifacts', () => {
		const job = workflow.slice(workflow.indexOf('  publish-release:'));
		assert.match(
			workflow,
			/name: hucode-public-\$\{\{ steps\.version\.outputs\.safe_version \}\}-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/
		);
		assert.match(
			job,
			/pattern: hucode-public-\$\{\{ steps\.version\.outputs\.safe_version \}\}-\*/
		);
		assert.match(
			job,
			/pattern: hucode-server-web-\$\{\{ steps\.version\.outputs\.safe_version \}\}-\*/
		);
		assert.match(workflow, /matrix\.arch != 'armhf'/);
		assert.doesNotMatch(job, /name: hucode-app-/);
	});

	test('prepares source assets and checksums without copying payloads', () => {
		assert.match(
			workflow,
			/node build\/hucode\/release-assets\.ts prepare[\s\S]*--artifacts release-artifacts[\s\S]*--checksums SHA256SUMS[\s\S]*--manifest release-assets\.json/
		);
		assert.match(
			workflow,
			/node build\/hucode\/release-assets\.ts print-paths/
		);
	});

	test('publishes only after draft upload and remote verification', () => {
		const job = workflow.slice(workflow.indexOf('  publish-release:'));
		const steps = [
			'- name: Prepare release assets',
			'- name: Create or update draft release',
			'- name: Upload draft release assets',
			'- name: Verify remote release assets',
			'- name: Publish verified release'
		];
		let previousIndex = -1;
		for (const step of steps) {
			const index = job.indexOf(step);
			assert.ok(index > previousIndex, `Release step out of order: ${step}`);
			previousIndex = index;
		}
		assert.match(job, /gh release create "\$TAG_NAME"[\s\S]*--draft/);
		assert.match(job, /release_is_draft.*--json isDraft --jq \.isDraft/s);
		assert.match(job, /already published; refusing to mutate it/);
		assert.match(job, /gh release upload "\$TAG_NAME" "\$\{files\[@\]\}" --clobber/);
		assert.match(job, /gh release view "\$TAG_NAME"[\s\S]*--json assets/);
		assert.match(job, /release-assets\.ts verify/);
		assert.match(job, /gh release edit "\$TAG_NAME" --draft=false/);
	});
});
