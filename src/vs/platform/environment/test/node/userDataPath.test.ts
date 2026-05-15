/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join, resolve } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { OPTIONS, parseArgs } from '../../node/argv.js';
import { getUserDataPath } from '../../node/userDataPath.js';
import product from '../../../product/common/product.js';

suite('User data path', () => {

	function withEnv<T>(
		values: Record<string, string | undefined>,
		run: () => T
	): T {
		const previousValues = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(values)) {
			previousValues.set(key, process.env[key]);
			if (typeof value === 'string') {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}

		try {
			return run();
		} finally {
			for (const [key, value] of previousValues) {
				if (typeof value === 'string') {
					process.env[key] = value;
				} else {
					delete process.env[key];
				}
			}
		}
	}

	test('getUserDataPath - default', () => {
		const path = getUserDataPath(parseArgs(process.argv, OPTIONS), product.nameShort);
		assert.ok(path.length > 0);
	});

	test('getUserDataPath - portable mode', () => {
		const origPortable = process.env['VSCODE_PORTABLE'];
		try {
			const portableDir = 'portable-dir';
			process.env['VSCODE_PORTABLE'] = portableDir;

			const path = getUserDataPath(parseArgs(process.argv, OPTIONS), product.nameShort);
			assert.ok(path.includes(portableDir));
		} finally {
			if (typeof origPortable === 'string') {
				process.env['VSCODE_PORTABLE'] = origPortable;
			} else {
				delete process.env['VSCODE_PORTABLE'];
			}
		}
	});

	test('getUserDataPath - --user-data-dir', () => {
		const cliUserDataDir = 'cli-data-dir';
		const args = parseArgs(process.argv, OPTIONS);
		args['user-data-dir'] = cliUserDataDir;

		const path = getUserDataPath(args, product.nameShort);
		assert.ok(path.includes(cliUserDataDir));
	});

	test('getUserDataPath - VSCODE_APPDATA', () => {
		const origAppData = process.env['VSCODE_APPDATA'];
		try {
			const appDataDir = 'appdata-dir';
			process.env['VSCODE_APPDATA'] = appDataDir;

			const path = getUserDataPath(parseArgs(process.argv, OPTIONS), product.nameShort);
			assert.ok(path.includes(appDataDir));
		} finally {
			if (typeof origAppData === 'string') {
				process.env['VSCODE_APPDATA'] = origAppData;
			} else {
				delete process.env['VSCODE_APPDATA'];
			}
		}
	});

	test('getUserDataPath - VSCODE_DEV uses product-specific suffix', () => {
		const origDev = process.env['VSCODE_DEV'];
		try {
			process.env['VSCODE_DEV'] = '1';

			const path = getUserDataPath(parseArgs(process.argv, OPTIONS), 'Hucode');
			assert.ok(path.endsWith('Hucode-dev'));
		} finally {
			if (typeof origDev === 'string') {
				process.env['VSCODE_DEV'] = origDev;
			} else {
				delete process.env['VSCODE_DEV'];
			}
		}
	});

	test('getUserDataPath - Hucode built identity uses Hucode folder', () => {
		withEnv({
			VSCODE_APPDATA: 'appdata-dir',
			VSCODE_DEV: undefined,
			VSCODE_PORTABLE: undefined
		}, () => {
			const path = getUserDataPath(
				parseArgs(process.argv, OPTIONS),
				'Hucode'
			);

			assert.strictEqual(path, resolve(join('appdata-dir', 'Hucode')));
		});
	});

	test('getUserDataPath - Hucode dev identity uses Hucode-dev folder', () => {
		withEnv({
			VSCODE_APPDATA: 'appdata-dir',
			VSCODE_DEV: '1',
			VSCODE_PORTABLE: undefined
		}, () => {
			const path = getUserDataPath(
				parseArgs(process.argv, OPTIONS),
				'Hucode'
			);

			assert.strictEqual(path, resolve(join('appdata-dir', 'Hucode-dev')));
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
