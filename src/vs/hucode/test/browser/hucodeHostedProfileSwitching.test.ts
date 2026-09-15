/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	DidChangeProfilesEvent,
	IUserDataProfile,
	toUserDataProfile,
} from '../../../platform/userDataProfile/common/userDataProfile.js';
import {
	IHucodeHostedShellService,
	withHucodeHostedShellCachedAvailability,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { UserDataProfileManagementService } from
	'../../../workbench/services/userDataProfile/browser/userDataProfileManagement.js';

suite('Hucode hosted profile switching', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('reloads a hosted web workbench without a second confirmation', async () => {
		assert.deepStrictEqual(await switchHostedProfile(true), {
			currentProfileId: 'selected',
			confirmationCount: 0,
		});
	});

	test('keeps confirmation for unauthenticated hosted URL flags', async () => {
		assert.deepStrictEqual(await switchHostedProfile(false), {
			currentProfileId: 'selected',
			confirmationCount: 1,
		});
	});

	async function switchHostedProfile(authenticated: boolean): Promise<{
		readonly currentProfileId: string;
		readonly confirmationCount: number;
	}> {
		const workspace = URI.file('/workspace');
		const defaultProfile = profile('default', [], true);
		const selectedProfile = profile('selected', [workspace]);
		const profileChanges = disposables.add(
			new Emitter<DidChangeProfilesEvent>()
		);
		const reloaded = new DeferredPromise<void>();
		let currentProfile = defaultProfile;
		let confirmationCount = 0;
		const service = disposables.add(new UserDataProfileManagementService(
			{
				profiles: [defaultProfile, selectedProfile],
				defaultProfile,
				onDidChangeProfiles: profileChanges.event,
			} as never,
			{
				get currentProfile() { return currentProfile; },
				onDidChangeCurrentProfile: Event.None,
				updateCurrentProfile: async (next: IUserDataProfile) => {
					currentProfile = next;
				},
			} as never,
			{
				reload: async () => reloaded.complete(),
			} as never,
			{
				confirm: async () => {
					confirmationCount++;
					return { confirmed: true };
				},
			} as never,
			{
				getWorkspace: () => ({
					id: 'workspace',
					folders: [{ uri: workspace }],
				}),
			} as never,
			{} as never,
			{
				remoteAuthority: 'test',
				isHostedOmniWorkspace: true,
				hostedInstanceId: 'instance-1',
			} as never,
			authenticated
				? withHucodeHostedShellCachedAvailability(
					{} as IHucodeHostedShellService,
					() => true
				)
				: {} as IHucodeHostedShellService,
			{} as never,
			{} as never,
			{ getValue: () => undefined } as never,
			{ extUri: { isEqual: (left: URI, right: URI) => left.toString() === right.toString() } } as never,
			{ error: () => undefined } as never,
		));
		assert.ok(service);

		profileChanges.fire({
			added: [],
			removed: [],
			updated: [defaultProfile],
			all: [defaultProfile, selectedProfile],
		});
		await reloaded.p;

		return {
			currentProfileId: currentProfile.id,
			confirmationCount,
		};
	}
});

function profile(
	id: string,
	workspaces: readonly URI[],
	isDefault = false
): IUserDataProfile {
	return {
		...toUserDataProfile(
			id,
			id,
			URI.file(`/profiles/${id}`),
			URI.file('/profile-cache'),
			{ workspaces }
		),
		isDefault,
	};
}
