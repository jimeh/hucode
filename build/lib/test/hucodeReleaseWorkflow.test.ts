/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
const prepareMatrixJob = workflow.slice(
	workflow.indexOf('  prepare-matrix:'),
	workflow.indexOf('  copilot-vsix:')
);
const linuxSmokeMatrixBuilder = prepareMatrixJob.slice(
	prepareMatrixJob.indexOf('const linuxSmokeInclude'),
	prepareMatrixJob.indexOf('const output =')
);
const linuxPackageSmokeJob = workflow.slice(
	workflow.indexOf('  linux-package-smoke:'),
	workflow.indexOf('  publish-release:')
);
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
		assert.deepStrictEqual({
			publicArchitecturesOnly:
				/\.filter\(item => item\.platform === 'linux' && item\.arch !== 'armhf'\)/
					.test(linuxSmokeMatrixBuilder),
			formats:
				/\.flatMap\(item => \['deb', 'rpm'\]\.map\(format => \(\{/
					.test(linuxSmokeMatrixBuilder),
			matrixOutput: /linux_smoke_matrix:/.test(prepareMatrixJob),
			smokeScript: /build\/hucode\/linux-package-smoke\.sh/.test(linuxPackageSmokeJob)
		}, {
			publicArchitecturesOnly: true,
			formats: true,
			matrixOutput: true,
			smokeScript: true
		});
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
		assert.match(linuxSmokeMatrixBuilder, /\? 'ubuntu-24\.04-arm'/);
		assert.match(linuxSmokeMatrixBuilder, /: 'ubuntu-latest'/);
		assert.match(linuxPackageSmokeJob, /runs-on: \$\{\{ matrix\.runner \}\}/);
		assert.doesNotMatch(linuxPackageSmokeJob, /setup-qemu-action/);
		assert.match(
			workflow,
			/copilot-vsix:[\s\S]*?runs-on: ubuntu-latest[\s\S]*?linux-package-smoke:/
		);
	});

	test('serializes release mutation without cancelling an active run', () => {
		const concurrency = workflow.slice(
			workflow.indexOf('concurrency:'),
			workflow.indexOf('permissions:')
		);
		const publishJob = workflow.slice(
			workflow.indexOf('  publish-release:'),
			workflow.indexOf('  refresh-update-service:')
		);
		assert.deepStrictEqual({
			refScoped: /group: .*\$\{\{ github\.ref \}\}/.test(concurrency),
			queuesReruns: /cancel-in-progress: false/.test(concurrency),
			rechecksDraftState: /release_is_draft=.*gh release view/s.test(publishJob),
			refusesPublishedRelease: /already published; refusing to mutate it/.test(publishJob)
		}, {
			refScoped: true,
			queuesReruns: true,
			rechecksDraftState: true,
			refusesPublishedRelease: true
		});
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
				/- name: Remove node_modules archive\n        if: matrix\.platform != 'win32'\n        run: rm -rf \.build\/node_modules_cache \.build\/node_modules_list\.txt$/m
			);
			assert.strictEqual(job.indexOf('- name: Remove node_modules archive', removeIndex + 1), -1);
		}
	});

	test('removes the downloaded app archive before packaging', () => {
		const packageJob = workflow.slice(
			workflow.indexOf('  package:'),
			workflow.indexOf('  linux-package-smoke:')
		);
		const restoreStep = packageJob.slice(
			packageJob.indexOf('- name: Restore release app'),
			packageJob.indexOf('- name: Package release artifacts')
		);
		assert.deepStrictEqual({
			extractsApp: /tar -xf "\$archive" -C \.\./.test(restoreStep),
			removesDownloadedArchive: /rm -rf \.build\/hucode\/app/.test(restoreStep),
			cleanupPrecedesPackaging:
				packageJob.indexOf('rm -rf .build/hucode/app') <
				packageJob.indexOf('- name: Package release artifacts')
		}, {
			extractsApp: true,
			removesDownloadedArchive: true,
			cleanupPrecedesPackaging: true
		});
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

	test('waits for the packaged app before removing its profile', () => {
		const cleanup = smokeScript.slice(
			smokeScript.indexOf('cleanup() {'),
			smokeScript.indexOf('trap cleanup EXIT')
		);
		const terminateIndex = cleanup.indexOf('pkill -TERM');
		const waitIndex = cleanup.indexOf('wait "$launcher_pid"');
		const removeIndex = cleanup.indexOf('rm -rf "$user_data_dir"');
		assert.deepStrictEqual({
			capturesLauncher: /&\nlauncher_pid="\$!"/.test(smokeScript),
			terminatesBeforeWait: terminateIndex >= 0 && terminateIndex < waitIndex,
			waitsBeforeRemove: waitIndex >= 0 && waitIndex < removeIndex,
			boundsGracePeriod: /for _ in \$\(seq 1 50\)/.test(cleanup),
			cleanupCannotMaskResult: /rm -rf .* \|\| true/.test(cleanup)
		}, {
			capturesLauncher: true,
			terminatesBeforeWait: true,
			waitsBeforeRemove: true,
			boundsGracePeriod: true,
			cleanupCannotMaskResult: true
		});
	});

	suite('packaged Omni startup smoke', () => {
		const job = workflow.slice(
			workflow.indexOf('  linux-omni-smoke:'),
			workflow.indexOf('  package:')
		);

		test('consumes the built app instead of rebuilding one', () => {
			// Rebuilding outside app-build means duplicating its environment
			// -- sysroots, OpenSSL, arch variables -- which then drifts.
			assert.match(job, /needs:\n      - app-build/);
			assert.match(job, /name: hucode-app-\$\{\{ steps\.version\.outputs\.safe_version \}\}-linux-x64/);
			// The download path and the untar path have to agree; asserting
			// only the untar leaves them free to diverge into `tar: Cannot
			// open`.
			assert.match(job, /path: \.build\/hucode\/app\n/);
			assert.match(job, /tar -xf \.build\/hucode\/app\/VSCode-linux-x64\.tar -C \.\./);
			assert.doesNotMatch(job, /release-build\.ts/);
		});

		// Scoped to the launch step. Asserting against the whole job lets the
		// environment drift onto a different step, where the packaged app
		// never inherits it.
		const launchStep = job.slice(
			job.indexOf('- name: Run packaged Omni startup smoke')
		);

		test('runs the declared smoke script under a display and bus', () => {
			// Matched as one contract: dropping the `--` separator while
			// leaving the `--app` line behind stops npm forwarding the path.
			assert.match(
				launchStep,
				/dbus-run-session -- xvfb-run -a npm run hucode:smoke:linux-omni -- \\\n\s+--app \.\.\/VSCode-linux-x64/
			);
		});

		test('disables the sandbox the artifact cannot carry', () => {
			// tar cannot restore chrome-sandbox as root-owned mode 4755 for a
			// non-root extraction, so the setuid bit is gone from the artifact
			// and Electron aborts in the SUID sandbox helper without this.
			assert.match(launchStep, /env:\n          ELECTRON_DISABLE_SANDBOX: 1/);
		});

		test('keeps the composite action build toolchain', () => {
			// apt-packages replaces the action's defaults rather than adding
			// to them, so dropping these breaks `npm ci` on a cold cache.
			for (const pkg of [
				'build-essential',
				'libkrb5-dev',
				'libx11-dev',
				'libxkbfile-dev',
				'pkg-config',
			]) {
				assert.ok(
					job.includes(`\n            ${pkg}\n`),
					`apt-packages must still install ${pkg}`
				);
			}
		});

		test('installs what Electron needs to start on a runner', () => {
			for (const pkg of ['dbus-x11', 'libgbm1', 'libgtk-3-0', 'xvfb']) {
				assert.ok(
					job.includes(`\n            ${pkg}\n`),
					`apt-packages must install ${pkg}`
				);
			}
		});

		test('runs on tag pushes, and skips only a dispatch without x64', () => {
			// Matched whole. Asserting the operands separately passes over an
			// inverted condition that never runs on a tag push, and over `&&`
			// becoming `||`, which would run the smoke after a failed
			// app-build and fail downloading an artifact that does not exist.
			assert.match(
				job,
				/if: >-\n      needs\.app-build\.result == 'success' &&\n      \(github\.event_name != 'workflow_dispatch' \|\| inputs\.linux_x64\)/
			);
		});

		test('does not gate publication yet', () => {
			// Real-app smokes are the flakiest thing in any suite; this one
			// reports on its own until it has proven stable.
			const publish = workflow.slice(
				workflow.indexOf('  publish-release:'),
				workflow.indexOf('  refresh-update-service:')
			);
			const needs = publish.slice(
				publish.indexOf('    needs:'),
				publish.indexOf('    runs-on:')
			);

			assert.doesNotMatch(needs, /- linux-omni-smoke/);
			assert.doesNotMatch(publish, /needs\.linux-omni-smoke/);
		});
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
