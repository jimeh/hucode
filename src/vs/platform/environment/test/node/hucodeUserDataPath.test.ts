/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join, resolve } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { OPTIONS, parseArgs } from '../../node/argv.js';
import { getUserDataPath } from '../../node/userDataPath.js';

suite('HucodeUserDataPath', () => {

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

	test('VSCODE_DEV uses product-specific suffix', () => {
		withEnv({ VSCODE_DEV: '1' }, () => {
			const path = getUserDataPath(parseArgs(process.argv, OPTIONS), 'Hucode');

			assert.ok(path.endsWith('Hucode-dev'));
		});
	});

	test('built identity uses Hucode folder', () => {
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

	test('dev identity uses Hucode-dev folder', () => {
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

	test('dev display identity uses Hucode-dev folder', () => {
		withEnv({
			VSCODE_APPDATA: 'appdata-dir',
			VSCODE_DEV: '1',
			VSCODE_PORTABLE: undefined
		}, () => {
			const path = getUserDataPath(
				parseArgs(process.argv, OPTIONS),
				'Hucode Dev'
			);

			assert.strictEqual(path, resolve(join('appdata-dir', 'Hucode-dev')));
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
