/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	createHucodeOmniWindowPath,
	distinctHucodeOmniWindowPaths,
	filterHucodePreserveRestorePaths,
	getHucodeDefaultStartupWindowPath,
	getHucodeOmniBrowserWindowOptions,
	getHucodeOmniFileOpenPlan,
	getHucodeOmniPathFromWindowState,
	getHucodeRegularFileOpenWindows,
	isHucodeOmniPathToOpen,
	openHucodeOmniWithProfilePreflight,
	openNewHucodeOmniWindow,
	restoreHucodeOmniWindowPaths,
} from '../../electron-main/omniOpenPlan.js';
import {
	HucodeOmniProfileOwnerError,
	resolveHucodeOmniDesktopProfileOwner,
	resolveHucodeOmniProfileOwner,
	resolveHucodeOmniWebProfileOwner,
} from '../../../platform/userDataProfile/common/hucodeOmniProfileOwner.js';

suite('HucodeOmniOpenPlan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an Omni window for the default app startup window', () => {
		assert.deepStrictEqual(
			getHucodeDefaultStartupWindowPath({ initialStartup: true }),
			{ isOmniWindow: true }
		);
	});

	test('does not replace explicit or restorable empty windows', () => {
		const results = [
			getHucodeDefaultStartupWindowPath({ initialStartup: false }),
			getHucodeDefaultStartupWindowPath({}),
			getHucodeDefaultStartupWindowPath({
				initialStartup: true,
				hasRestorableWindows: true
			})
		];

		assert.deepStrictEqual(results, [undefined, undefined, undefined]);
	});

	test('resolves an existing Omni owner by stable ID across rename', () => {
		const profile = {
			id: 'stable-id',
			name: 'Renamed Work',
			isTransient: false,
			isAgentsWindowProfile: false,
		};
		assert.strictEqual(
			resolveHucodeOmniProfileOwner([profile] as never, 'stable-id'),
			profile
		);
		assert.throws(
			() => resolveHucodeOmniProfileOwner(
				[profile] as never,
				'missing-id'
			),
			/unavailable/
		);
	});

	test('desktop owner selection uses explicit ID and legacy fallbacks', () => {
		const defaultProfile = {
			id: 'default',
			name: 'Default',
		};
		const work = {
			id: 'work-id',
			name: 'Work renamed',
		};
		const legacy = {
			id: 'legacy-id',
			name: 'Legacy name',
		};
		const transient = {
			id: 'transient-id',
			name: 'Temporary',
			isTransient: true,
		};
		const profiles = [defaultProfile, work, legacy, transient] as never;

		assert.strictEqual(resolveHucodeOmniDesktopProfileOwner(profiles, {
			profileId: 'work-id',
			forceProfile: 'Legacy name',
			fallbackProfile: defaultProfile as never,
			defaultProfile: defaultProfile as never,
		}), work);
		assert.strictEqual(resolveHucodeOmniDesktopProfileOwner(profiles, {
			forceProfile: 'Legacy name',
			fallbackProfile: defaultProfile as never,
			defaultProfile: defaultProfile as never,
		}), legacy);
		assert.strictEqual(resolveHucodeOmniDesktopProfileOwner(profiles, {
			fallbackProfile: work as never,
			defaultProfile: defaultProfile as never,
		}), work);
		assert.strictEqual(resolveHucodeOmniDesktopProfileOwner(profiles, {
			fallbackProfile: transient as never,
			defaultProfile: defaultProfile as never,
		}), defaultProfile);
		assert.throws(() => resolveHucodeOmniDesktopProfileOwner(profiles, {
			forceProfile: 'Missing',
			fallbackProfile: defaultProfile as never,
			defaultProfile: defaultProfile as never,
		}), /unavailable/);
	});

	test('preflights explicit owners before allocating an Omni window', () => {
		const profiles = [{ id: 'work-id', name: 'Work' }] as never;
		let allocationCount = 0;
		const allocate = () => ++allocationCount;

		assert.strictEqual(openHucodeOmniWithProfilePreflight(
			profiles,
			{ omniProfileId: 'work-id' },
			allocate
		), 1);
		for (const options of [{
			omniProfileId: 'missing-id',
		}, {
			forceProfile: 'Missing name',
		}, {
			forceTempProfile: true,
		}]) {
			assert.throws(() => openHucodeOmniWithProfilePreflight(
				profiles,
				options,
				allocate
			), HucodeOmniProfileOwnerError);
		}
		assert.strictEqual(allocationCount, 1);
	});

	test('initial restore skips only stale Omni owners and continues',
		async () => {
			const stale = createHucodeOmniWindowPath({
				omniProfileId: 'deleted-profile',
			});
			const valid = createHucodeOmniWindowPath({
				omniProfileId: 'work-profile',
			});
			const attempts: string[] = [];
			const errors: string[] = [];
			const windows = await restoreHucodeOmniWindowPaths(
				[stale, valid],
				{
					initialStartup: true,
					hasOtherWindows: false,
					async open(path) {
						attempts.push(path.omniProfileId!);
						if (path === stale) {
							throw new HucodeOmniProfileOwnerError('stale owner');
						}
						return path.omniProfileId!;
					},
					async openFallback() {
						throw new Error('fallback should not open');
					},
					onOwnerError(path, error) {
						errors.push(`${path.omniProfileId}:${error.message}`);
					},
				}
			);

			assert.deepStrictEqual(attempts, [
				'deleted-profile',
				'work-profile',
			]);
			assert.deepStrictEqual(errors, [
				'deleted-profile:stale owner',
			]);
			assert.deepStrictEqual(windows, ['work-profile']);
		});

	test('fully stale initial restore opens one fresh Default Omni window',
		async () => {
			const stale = createHucodeOmniWindowPath({
				omniProfileId: 'deleted-profile',
				omniActiveWorktreePath: '/stale-session',
			});
			let fallbackCount = 0;
			const windows = await restoreHucodeOmniWindowPaths([stale], {
				initialStartup: true,
				hasOtherWindows: false,
				async open() {
					throw new HucodeOmniProfileOwnerError('stale owner');
				},
				async openFallback() {
					fallbackCount++;
					return createHucodeOmniWindowPath({
						omniProfileId: 'default-profile',
					});
				},
				onOwnerError() { },
			});

			assert.strictEqual(fallbackCount, 1);
			assert.deepStrictEqual(windows, [createHucodeOmniWindowPath({
				omniProfileId: 'default-profile',
			})]);
		});

	test('fully stale restore does not add fallback beside another window',
		async () => {
			let fallbackCount = 0;
			const windows = await restoreHucodeOmniWindowPaths([
				createHucodeOmniWindowPath({ omniProfileId: 'deleted-profile' }),
			], {
				initialStartup: true,
				hasOtherWindows: true,
				async open() {
					throw new HucodeOmniProfileOwnerError('stale owner');
				},
				async openFallback() {
					fallbackCount++;
					return 'unexpected';
				},
				onOwnerError() { },
			});

			assert.strictEqual(fallbackCount, 0);
			assert.deepStrictEqual(windows, []);
		});

	test('explicit non-startup Omni opens still reject stale owners',
		async () => {
			const stale = createHucodeOmniWindowPath({
				omniProfileId: 'deleted-profile',
			});
			let handled = false;
			await assert.rejects(restoreHucodeOmniWindowPaths([stale], {
				initialStartup: false,
				hasOtherWindows: false,
				async open() {
					throw new HucodeOmniProfileOwnerError('stale owner');
				},
				async openFallback() {
					throw new Error('fallback should not open');
				},
				onOwnerError() {
					handled = true;
				},
			}), /stale owner/);
			assert.strictEqual(handled, false);
		});

	test('web hosted startup requires and overrides with its owner ID', () => {
		const work = {
			id: 'work',
			name: 'Work',
			isTransient: false,
			isAgentsWindowProfile: false,
		};
		const personal = {
			id: 'personal',
			name: 'Personal',
			isTransient: false,
			isAgentsWindowProfile: false,
		};
		const profiles = [work, personal] as never;

		assert.strictEqual(resolveHucodeOmniWebProfileOwner(profiles, {
			hucodeHostedOmniWorkbench: true,
			hucodeOmniProfileId: 'work',
		}), work);
		assert.throws(() => resolveHucodeOmniWebProfileOwner(profiles, {
			hucodeHostedOmniWorkbench: true,
		}), /requires an owner profile/);
		assert.throws(() => resolveHucodeOmniWebProfileOwner(profiles, {
			hucodeHostedOmniWorkbench: true,
			hucodeOmniProfileId: 'missing',
		}), /unavailable/);
	});

	test('identifies and restores Omni window paths', () => {
		const retainedWorkbenches = [{
			id: 'scratch',
			folderUri: URI.file('/scratch').toJSON(),
			desiredState: 'unloaded' as const,
			order: 0,
		}];
		const omniPath = createHucodeOmniWindowPath({
			omniProfileId: 'profile-id',
			omniActiveWorktreePath: '/repo',
			omniResidentWorkspaces: [{
				projectId: 'project',
				worktreePath: '/repo',
				lastActiveAt: 1,
				state: 'active'
			}],
			omniRetainedWorkbenches: retainedWorkbenches,
		});

		assert.strictEqual(isHucodeOmniPathToOpen(omniPath), true);
		assert.strictEqual(isHucodeOmniPathToOpen({}), false);
		assert.deepStrictEqual(
			getHucodeOmniPathFromWindowState({
				windowKind: 'omni',
				omniProfileId: 'profile-id',
				omniActiveWorktreePath: '/repo',
				omniResidentWorkspaces: omniPath.omniResidentWorkspaces,
				omniRetainedWorkbenches: retainedWorkbenches,
			}),
			omniPath
		);
		assert.strictEqual(
			getHucodeOmniPathFromWindowState({ windowKind: 'workbench' }),
			undefined
		);
	});

	test('keeps Omni paths in preserve restore filtering', () => {
		const workspace = { kind: 'workspace' };
		const folder = { kind: 'folder' };
		const empty = { backupPath: 'empty-backup' };
		const omni = createHucodeOmniWindowPath();
		const ignored = { kind: 'file' };
		const paths: Array<{
			readonly kind?: string;
			readonly backupPath?: string;
			readonly isOmniWindow?: boolean;
		}> = [workspace, folder, empty, omni, ignored];

		assert.deepStrictEqual(
			filterHucodePreserveRestorePaths(
				paths,
				path => path.kind === 'workspace',
				path => path.kind === 'folder'
			),
			[workspace, folder, empty, omni]
		);
	});

	test('dedupes Omni restore paths by active and resident workspaces', () => {
		const first = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/repo'
		});
		const duplicate = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/repo'
		});
		const second = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/other'
		});

		assert.deepStrictEqual(
			distinctHucodeOmniWindowPaths([first, duplicate, second]),
			[first, second]
		);
	});

	test('keeps otherwise identical restore paths for different profiles', () => {
		const work = createHucodeOmniWindowPath({
			omniProfileId: 'work',
			omniActiveWorktreePath: '/repo'
		});
		const personal = createHucodeOmniWindowPath({
			omniProfileId: 'personal',
			omniActiveWorktreePath: '/repo'
		});

		assert.deepStrictEqual(
			distinctHucodeOmniWindowPaths([work, personal]),
			[work, personal]
		);
	});

	test('builds Omni browser window options from open config', () => {
		assert.deepStrictEqual(
			getHucodeOmniBrowserWindowOptions(
				{
					initialStartup: true,
					forceNewTabbedWindow: true,
					forceProfile: 'Profile',
					forceTempProfile: true
				},
				createHucodeOmniWindowPath({
					omniProfileId: 'profile-id',
					omniActiveWorktreePath: '/repo'
				}),
				true
			),
			{
				userEnv: undefined,
				cli: undefined,
				initialStartup: true,
				forceNewWindow: true,
				forceNewTabbedWindow: true,
				forceProfile: 'Profile',
				forceTempProfile: true,
				isOmniWindow: true,
				omniProfileId: 'profile-id',
				omniActiveWorktreePath: '/repo',
				omniResidentWorkspaces: undefined,
				omniRetainedWorkbenches: undefined,
			}
		);

		assert.strictEqual(getHucodeOmniBrowserWindowOptions(
			{ omniProfileId: 'source-profile-id' },
			createHucodeOmniWindowPath(),
			true
		).omniProfileId, 'source-profile-id');
		assert.strictEqual(getHucodeOmniBrowserWindowOptions(
			{},
			createHucodeOmniWindowPath(),
			true
		).omniProfileId, undefined);
	});

	test('opens and focuses a distinct Omni window for every request', async () => {
		const input = {
			context: 'api',
			forceNewWindow: false,
			forceOmniWindow: false,
			forceEmpty: true,
			noRecentEntry: false
		};
		const requests: object[] = [];
		const restoredWindows: Array<{
			readonly id: number;
			focusCount: number;
			focus(): void;
		}> = [];
		const openedWindows: Array<{
			readonly id: number;
			focusCount: number;
			focus(): void;
		}> = [];
		const open = async (configuration: object) => {
			requests.push(configuration);
			const restoredWindow = {
				id: -(restoredWindows.length + 1),
				focusCount: 0,
				focus() {
					this.focusCount++;
				}
			};
			const window = {
				id: openedWindows.length + 1,
				focusCount: 0,
				focus() {
					this.focusCount++;
				}
			};
			restoredWindows.push(restoredWindow);
			openedWindows.push(window);
			return [restoredWindow, window];
		};

		const first = await openNewHucodeOmniWindow(input, open);
		const second = await openNewHucodeOmniWindow(input, open);

		assert.deepStrictEqual(
			{
				distinctRequests: requests[0] !== requests[1],
				distinctWindows: first[1] !== second[1],
				returnedWindowIds: [first[1].id, second[1].id],
				restoredFocusCounts: restoredWindows.map(
					window => window.focusCount
				),
				focusCounts: openedWindows.map(window => window.focusCount),
				requests
			},
			{
				distinctRequests: true,
				distinctWindows: true,
				returnedWindowIds: [1, 2],
				restoredFocusCounts: [0, 0],
				focusCounts: [1, 1],
				requests: [
					{
						context: 'api',
						forceNewWindow: true,
						forceOmniWindow: true,
						forceEmpty: false,
						noRecentEntry: true
					},
					{
						context: 'api',
						forceNewWindow: true,
						forceOmniWindow: true,
						forceEmpty: false,
						noRecentEntry: true
					}
				]
			}
		);
	});

	test('plans Omni file routing before regular window fallback', async () => {
		const regular = { id: 1, isOmniWindow: false };
		const omni = { id: 2, isOmniWindow: true };
		let routedThroughOmni = false;

		assert.deepStrictEqual(
			await getHucodeOmniFileOpenPlan({
				windows: [regular, omni],
				async openInOmniWindow() {
					routedThroughOmni = true;
					return omni;
				}
			}),
			{ omniWindow: omni }
		);
		assert.strictEqual(routedThroughOmni, true);

		routedThroughOmni = false;
		assert.deepStrictEqual(
			await getHucodeOmniFileOpenPlan({
				forceNewWindow: true,
				windows: [regular, omni],
				async openInOmniWindow() {
					routedThroughOmni = true;
					return omni;
				}
			}),
			{ fallbackWindows: [regular] }
		);
		assert.strictEqual(routedThroughOmni, false);
	});

	test('excludes Omni shell windows from regular file fallback', () => {
		const regular = { id: 1, isOmniWindow: false };
		const legacy = { id: 2 };
		const omni = { id: 3, isOmniWindow: true };

		assert.deepStrictEqual(
			getHucodeRegularFileOpenWindows([regular, legacy, omni]),
			[regular, legacy]
		);
	});
});
