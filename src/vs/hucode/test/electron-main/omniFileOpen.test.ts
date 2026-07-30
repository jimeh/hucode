/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { errorHandler } from '../../../base/common/errors.js';
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
		worktreeState: 'current',
		worktrees
	});

	const withExpectedUnexpectedError = async <T>(
		callback: () => Promise<T>
	): Promise<T> => {
		const originalHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: unknown[] = [];
		errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
		try {
			const result = await callback();
			assert.strictEqual(errors.length, 1);
			return result;
		} finally {
			errorHandler.setUnexpectedErrorHandler(originalHandler);
		}
	};

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

	test('opens known files in the matching hosted workspace', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;
		const fileUri = URI.file('/repo/src/file.txt');
		const waitMarkerFileUri = URI.file('/tmp/hucode-wait-marker');
		let persistedProjectId: string | undefined;
		let persistedWorktreePath: string | undefined;
		let openedProjectId: string | undefined;
		let openedWorktreePath: string | undefined;
		let openedRequest: unknown;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [
								project('project', [worktree('/repo')])
							];
						},
						async setLastActiveWorktree(
							projectId: string,
							worktreePath: string
						) {
							persistedProjectId = projectId;
							persistedWorktreePath = worktreePath;
						}
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async openFilesInWorkspace(
							windowId: number,
							worktreePath: string,
							request: unknown,
							projectId?: string
						) {
							assert.strictEqual(windowId, omni.id);
							openedProjectId = projectId;
							openedWorktreePath = worktreePath;
							openedRequest = request;
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
				filesToMerge: [],
				filesToWait: {
					paths: [{ fileUri }],
					waitMarkerFileUri,
				}
			}, 'hucode'),
			omni
		);
		assert.strictEqual(persistedProjectId, 'project');
		assert.strictEqual(persistedWorktreePath, '/repo');
		assert.strictEqual(openedProjectId, 'project');
		assert.strictEqual(openedWorktreePath, '/repo');
		assert.deepStrictEqual(openedRequest, {
			filesToOpenOrCreate: [{ fileUri }],
			filesToWait: {
				paths: [{ fileUri }],
				waitMarkerFileUri,
			},
			termProgram: 'hucode',
		});
	});

	test('does not route diff or merge requests through Omni', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;

		const accessor = {
			get() {
				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
				filesToOpenOrCreate: [],
				filesToDiff: [
					{
						fileUri: URI.file('/repo/one.txt')
					},
					{
						fileUri: URI.file('/repo/two.txt')
					}
				],
				filesToMerge: []
			}, undefined),
			undefined
		);

		assert.strictEqual(
			await tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
				filesToOpenOrCreate: [],
				filesToDiff: [],
				filesToMerge: [
					{
						fileUri: URI.file('/repo/current.txt')
					},
					{
						fileUri: URI.file('/repo/incoming.txt')
					}
				]
			}, undefined),
			undefined
		);
	});

	test('falls back when project lookup fails', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							throw new Error('lookup failed');
						}
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await withExpectedUnexpectedError(() =>
				tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
					filesToOpenOrCreate: [{ fileUri: URI.file('/repo/file.txt') }],
					filesToDiff: [],
					filesToMerge: []
				}, undefined)
			),
			undefined
		);
	});

	test('falls back when active workspace file open fails', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [];
						}
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async openFilesInActiveWorkspace() {
							throw new Error('open failed');
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await withExpectedUnexpectedError(() =>
				tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
					filesToOpenOrCreate: [{ fileUri: URI.file('/outside/file.txt') }],
					filesToDiff: [],
					filesToMerge: []
				}, undefined)
			),
			undefined
		);
	});

	test('falls back when hosted workspace file open fails', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [
								project('project', [worktree('/repo')])
							];
						},
						async setLastActiveWorktree() { }
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async openFilesInWorkspace() {
							throw new Error('open failed');
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await withExpectedUnexpectedError(() =>
				tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
					filesToOpenOrCreate: [
						{ fileUri: URI.file('/repo/src/file.txt') }
					],
					filesToDiff: [],
					filesToMerge: []
				}, undefined)
			),
			undefined
		);
	});

	test('continues when last active worktree persistence fails', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
			lastFocusTime: 10
		} as ICodeWindow;
		let workspaceOpenUri: URI | undefined;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [
								project('project', [worktree('/repo')])
							];
						},
						async setLastActiveWorktree() {
							throw new Error('persistence failed');
						}
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async openFilesInWorkspace(
							windowId: number,
							worktreePath: string,
							request: { filesToOpenOrCreate: { fileUri?: URI }[] }
						) {
							assert.strictEqual(windowId, omni.id);
							assert.strictEqual(worktreePath, '/repo');
							workspaceOpenUri =
								request.filesToOpenOrCreate[0].fileUri;
							return true;
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		const fileUri = URI.file('/repo/src/file.txt');
		assert.strictEqual(
			await withExpectedUnexpectedError(() =>
				tryOpenFilesInHucodeOmniWindow(accessor, [omni], {
					filesToOpenOrCreate: [{ fileUri }],
					filesToDiff: [],
					filesToMerge: []
				}, undefined)
			),
			omni
		);
		assert.strictEqual(workspaceOpenUri, fileUri);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
