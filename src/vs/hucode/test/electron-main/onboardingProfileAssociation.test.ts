/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IUserDataProfile, toUserDataProfile } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { setHucodeProfileForWorkspace } from '../../../platform/userDataProfile/electron-main/hucodeProfileAssociation.js';
import { IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier } from '../../../platform/workspace/common/workspace.js';

suite('Hucode onboarding folder profile association', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const folder = { id: 'feature', uri: URI.file('/repo/feature') };
	const sibling = URI.file('/repo/main').toString();
	const imported = toUserDataProfile('imported', 'Imported', URI.file('/profiles/imported'), URI.file('/cache'));
	const previous = toUserDataProfile('previous', 'Previous', URI.file('/profiles/previous'), URI.file('/cache'));

	function setup(current: IUserDataProfile | undefined = previous, target: IUserDataProfile = imported) {
		const associations = new Map<string, IUserDataProfile>([[sibling, previous]]);
		if (current) { associations.set(folder.uri.toString(), current); }
		const persisted: Record<string, string> = Object.fromEntries([...associations].map(([key, profile]) => [key, profile.id]));
		let writes = 0;
		const key = (workspace: IAnyWorkspaceIdentifier) => { assert.ok(isSingleFolderWorkspaceIdentifier(workspace)); return workspace.uri.toString(); };
		const profiles = {
			profiles: [target, previous],
			getProfileForWorkspace: (workspace: IAnyWorkspaceIdentifier) => associations.get(key(workspace)),
			setProfileForWorkspace: async (workspace: IAnyWorkspaceIdentifier, profile: IUserDataProfile) => { writes++; associations.set(key(workspace), profile); },
			unsetWorkspace: (workspace: IAnyWorkspaceIdentifier) => { writes++; associations.delete(key(workspace)); },
		};
		const flush = async (matches: (value: unknown) => boolean) => {
			for (const property of Object.keys(persisted)) { delete persisted[property]; }
			for (const [property, profile] of associations) { persisted[property] = profile.id; }
			if (!matches({ workspaces: persisted })) { throw new Error('association mismatch'); }
		};
		return { profiles, associations, persisted, flush, writes: () => writes };
	}

	test('saves only the exact folder and keeps sibling associations', async () => {
		const fixture = setup();
		assert.strictEqual(await setHucodeProfileForWorkspace(fixture.profiles, folder, imported.id, previous.id, fixture.flush), true);
		assert.deepStrictEqual(fixture.persisted, { [folder.uri.toString()]: imported.id, [sibling]: previous.id });
	});

	test('rejects changed association, deleted profile, Default, transient, and agents targets before writes', async () => {
		for (const [target, expected, chosen] of [
			[imported, 'stale', imported.id],
			[imported, previous.id, 'deleted'],
			[{ ...imported, isDefault: true }, previous.id, imported.id],
			[{ ...imported, isTransient: true }, previous.id, imported.id],
			[{ ...imported, isAgentsWindowProfile: true }, previous.id, imported.id],
		] as const) {
			const fixture = setup(previous, target);
			assert.strictEqual(await setHucodeProfileForWorkspace(fixture.profiles, folder, chosen, expected, fixture.flush), false);
			assert.strictEqual(fixture.writes(), 0);
		}
	});

	test('keeping the current profile revalidates the expected association without writing', async () => {
		const fixture = setup();
		let flushes = 0;
		const flush = async () => { flushes++; };
		assert.strictEqual(await setHucodeProfileForWorkspace(fixture.profiles, folder, undefined, previous.id, flush), true);
		assert.strictEqual(await setHucodeProfileForWorkspace(fixture.profiles, folder, undefined, 'stale', flush), false);
		assert.deepStrictEqual({ writes: fixture.writes(), flushes }, { writes: 0, flushes: 0 });
	});

	test('failed persistence restores the prior association before returning failure', async () => {
		for (const current of [previous, undefined]) {
			const fixture = setup(current);
			if (!current) { fixture.associations.delete(folder.uri.toString()); delete fixture.persisted[folder.uri.toString()]; }
			let flushes = 0;
			await assert.rejects(setHucodeProfileForWorkspace(fixture.profiles, folder, imported.id, current?.id, async matches => {
				if (++flushes === 1) { throw new Error('disk failed'); }
				await fixture.flush(matches);
			}), /disk failed/);
			assert.strictEqual(fixture.associations.get(folder.uri.toString())?.id, current?.id);
			assert.strictEqual(fixture.persisted[folder.uri.toString()], current?.id);
		}
	});

	test('accepts another folder changing during flush without rolling this folder back', async () => {
		const fixture = setup();
		const saved = await setHucodeProfileForWorkspace(fixture.profiles, folder, imported.id, previous.id, async matches => {
			fixture.associations.set(sibling, imported);
			await fixture.flush(matches);
		});
		assert.deepStrictEqual({ saved, persisted: fixture.persisted }, { saved: true, persisted: { [folder.uri.toString()]: imported.id, [sibling]: imported.id } });
	});

	test('does not undo a concurrent association change when persistence fails', async () => {
		const fixture = setup();
		const concurrent = { ...previous, id: 'concurrent' };
		await assert.rejects(setHucodeProfileForWorkspace(fixture.profiles, folder, imported.id, previous.id, async () => {
			fixture.associations.set(folder.uri.toString(), concurrent);
			throw new Error('disk failed');
		}));
		assert.strictEqual(fixture.associations.get(folder.uri.toString())?.id, 'concurrent');
	});
});
