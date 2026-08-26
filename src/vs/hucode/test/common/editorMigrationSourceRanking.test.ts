/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationSourceRanking } from '../../common/migration/editorMigrationSource.js';
import { compareEditorMigrationCodePoints, compareEditorMigrationSourceRanking } from '../../common/migration/editorMigrationSourceRanking.js';

suite('EditorMigrationSourceRanking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('orders every ranking field lexicographically', () => {
		const baseline = ranking();
		const preferred = [
			ranking({ completeness: 4 }),
			ranking({ newestModificationTime: 11 }),
			ranking({ stableChannelPreference: 1 }),
			ranking({ adapterOrder: 0 }),
			ranking({ normalizedProfileName: 'aaa' }),
			ranking({ canonicalReference: 'aaa' }),
		];

		assert.deepStrictEqual(
			preferred.map(value => Math.sign(compareEditorMigrationSourceRanking(value, baseline))),
			[-1, -1, -1, -1, -1, -1]
		);
	});

	test('returns equality for identical evidence', () => {
		assert.strictEqual(compareEditorMigrationSourceRanking(ranking(), ranking()), 0);
	});

	test('uses locale-independent Unicode code-point tie-breaks', () => {
		const privateUse = '\uE000';
		const supplementary = '\u{1F600}';

		assert.strictEqual(compareEditorMigrationCodePoints(privateUse, supplementary), -1);
		assert.strictEqual(compareEditorMigrationCodePoints(supplementary, privateUse), 1);
		assert.strictEqual(compareEditorMigrationSourceRanking(
			ranking({ normalizedProfileName: privateUse }),
			ranking({ normalizedProfileName: supplementary })
		), -1);
	});
});

function ranking(overrides: Partial<EditorMigrationSourceRanking> = {}): EditorMigrationSourceRanking {
	return {
		completeness: 3,
		newestModificationTime: 10,
		stableChannelPreference: 0,
		adapterOrder: 1,
		normalizedProfileName: 'bbb',
		canonicalReference: 'bbb',
		...overrides,
	};
}
