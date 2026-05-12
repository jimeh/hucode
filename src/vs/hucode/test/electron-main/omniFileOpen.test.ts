/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { URI } from '../../../base/common/uri.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IProjectManagerMainService } from '../../../platform/projectManager/electron-main/projectManager.js';
import { ProjectRecord, WorktreeRecord } from '../../../platform/projectManager/common/projectManager.js';
import { ICodeWindow } from '../../../platform/window/electron-main/window.js';
import {
	findHucodeProjectWorktreeForFiles,
	getLastActiveHucodeOmniWindow,
	tryOpenFilesInHucodeOmniWindow
} from '../../electron-main/omniFileOpen.js';
import { IHucodeShellMainService } from '../../electron-main/omniWindow.js';

suite('HucodeOmniFileOpen', () => {

	const worktree = (path: string): WorktreeRecord => ({
		path,
		label: path.split('/').at(-1) ?? path,
		isMain: false,
		isDetached: false
	});

	const project = (
		id: string,
		worktrees: readonly WorktreeRecord[]
	): ProjectRecord => ({
		id,
		label: id,
		rootUri: URI.file(`/projects/${id}`),
		pinned: false,
		order: 0,
		worktrees
	});

	test('matches files to the most specific known worktree', () => {
		const projects = [
			project('project', [
				worktree('/repo'),
				worktree('/repo/.worktrees/feature')
			])
		];

		assert.deepStrictEqual(
			findHucodeProjectWorktreeForFiles(projects, [
				URI.file('/repo/.worktrees/feature/src/file.ts')
			]),
			{
				projectId: 'project',
				worktreePath: '/repo/.worktrees/feature'
			}
		);
	});

	test('requires all files to belong to the same worktree', () => {
		const projects = [
			project('project', [
				worktree('/repo/.worktrees/one'),
				worktree('/repo/.worktrees/two')
			])
		];

		assert.strictEqual(
			findHucodeProjectWorktreeForFiles(projects, [
				URI.file('/repo/.worktrees/one/a.ts'),
				URI.file('/repo/.worktrees/two/b.ts')
			]),
			undefined
		);
	});

	test('selects the last active Omni window', () => {
		const normal = {
			isOmniWindow: false,
			lastFocusTime: 5
		} as ICodeWindow;
		const oldOmni = {
			isOmniWindow: true,
			lastFocusTime: 1
		} as ICodeWindow;
		const activeOmni = {
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;

		assert.strictEqual(
			getLastActiveHucodeOmniWindow([normal, oldOmni, activeOmni]),
			activeOmni
		);
	});

	test('opens unknown files in the active Omni hosted workspace', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;
		const fileUri = URI.file('/outside/repo/file.txt');
		let activeWorkspaceRequestUri: URI | undefined;
		let setLastActiveWorktreeCalled = false;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [];
						},
						async setLastActiveWorktree() {
							setLastActiveWorktreeCalled = true;
						}
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async openFilesInActiveWorkspace(
							windowId: number,
							request: { filesToOpenOrCreate: { fileUri?: URI }[] }
						) {
							assert.strictEqual(windowId, omni.id);
							activeWorkspaceRequestUri =
								request.filesToOpenOrCreate[0].fileUri;
							return true;
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
				filesToOpenOrCreate: [{ fileUri }],
				filesToDiff: [],
				filesToMerge: []
			}, undefined),
			omni
		);
		assert.strictEqual(activeWorkspaceRequestUri, fileUri);
		assert.strictEqual(setLastActiveWorktreeCalled, false);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
