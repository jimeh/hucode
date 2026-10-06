/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { createLockfileRegenerationSeed, findLockfileDifferences } from '../../azure-pipelines/common/validatePackageLocks.ts';

suite('validatePackageLocks', () => {
	test('forces pnpm to resolve every importer dependency changed by the PR', () => {
		const base = {
			lockfileVersion: '9.0',
			importers: {
				'.': {
					dependencies: {
						refreshed: { specifier: '^1.0.0', version: '1.0.0' },
						unchanged: { specifier: '^1.0.0', version: '1.0.0' },
					},
					devDependencies: {
						removed: { specifier: '^1.0.0', version: '1.0.0' },
					},
				},
			},
			packages: {
				'unchanged@1.0.0': { resolution: { integrity: 'sha512-unchanged' } },
			},
		};
		const submitted = {
			lockfileVersion: '9.0',
			importers: {
				'.': {
					dependencies: {
						added: { specifier: '^2.0.0', version: '2.0.0' },
						refreshed: { specifier: '^1.0.0', version: '1.1.0' },
						unchanged: { specifier: '^1.0.0', version: '1.0.0' },
					},
				},
			},
			packages: {
				'unchanged@1.0.0': { resolution: { tarball: 'https://private.example/unchanged-1.0.0.tgz' } },
			},
		};

		assert.deepStrictEqual(createLockfileRegenerationSeed(base, submitted), {
			lockfileVersion: '9.0',
			importers: {
				'.': {
					dependencies: {
						unchanged: { specifier: '^1.0.0', version: '1.0.0' },
					},
					devDependencies: {},
				},
			},
			packages: {
				'unchanged@1.0.0': { resolution: { integrity: 'sha512-unchanged' } },
			},
		});
		assert.strictEqual(createLockfileRegenerationSeed(undefined, submitted), undefined);
	});

	test('reports resolutions pnpm does not produce while ignoring mirror integrity', () => {
		const expected = {
			packages: {
				'native@1.0.0': { resolution: { integrity: 'sha1-registry-value' }, os: ['linux'] },
			},
		};
		const submitted = {
			packages: {
				'native@1.0.0': { resolution: { integrity: 'sha512-mirror-value', tarball: 'https://private.example/native-1.0.0.tgz' } },
			},
		};

		assert.deepStrictEqual(findLockfileDifferences(expected, submitted), [
			'packages.native@1.0.0.os: expected ["linux"], submitted <missing>',
			'packages.native@1.0.0.resolution.tarball: expected <missing>, submitted "https://private.example/native-1.0.0.tgz"',
		]);
	});
});
