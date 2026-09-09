/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getSingleFolderWorkspaceIdentifier } from '../../../platform/workspaces/node/workspaces.js';
import { resolveOnboardingWorkspaceIdentifier } from '../../electron-main/onboarding/onboardingHandoff.js';

suite('Hucode onboarding native folder identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the same local identity as ordinary native creation and rejects missing or non-folder targets', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'hucode-onboarding-folder-'));
		try {
			const identity = await resolveOnboardingWorkspaceIdentifier(root);
			assert.deepStrictEqual(identity, getSingleFolderWorkspaceIdentifier(URI.file(root), await fs.stat(root)));
			assert.ok(identity.id);
			await assert.rejects(resolveOnboardingWorkspaceIdentifier(join(root, 'missing')));
			const file = join(root, 'file');
			await fs.writeFile(file, 'fixture');
			await assert.rejects(resolveOnboardingWorkspaceIdentifier(file), /folder is unavailable/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
