/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { errorHandler } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ProjectRecord, WorktreeRecord } from '../../../platform/projectManager/common/projectManager.js';
import { IProjectManagerMainService } from '../../../platform/projectManager/electron-main/projectManager.js';
import { ICodeWindow } from '../../../platform/window/electron-main/window.js';
import { IHucodeShellMainService } from '../../electron-main/omniWindow.js';
import { tryOpenFolderInHucodeHostedWorkspace } from '../../electron-main/omniWorkspaceOpen.js';

suite('HucodeOmniWorkspaceOpen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('ignores non-file folders before loading services', async () => {
		const accessor = {
			get() {
				throw new Error('Should not load services');
			}
		} as unknown as ServicesAccessor;

		assert.strictEqual(
			await tryOpenFolderInHucodeHostedWorkspace(
				accessor,
				[],
				URI.parse('vscode-remote://ssh-remote/repo'),
				undefined,
				undefined
			),
			undefined
		);
	});

	test('ignores folders without hosted owners', async () => {
		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IHucodeShellMainService) {
					return {
						async findHostedWorkspaceByPath() {
							return undefined;
						}
					};
				}

				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							throw new Error('Should not load projects');
						},
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.strictEqual(
			await tryOpenFolderInHucodeHostedWorkspace(
				accessor,
				[],
				URI.file('/repo'),
				undefined,
				undefined
			),
			undefined
		);
	});

	test('focuses existing hosted workspace for matching folder', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
		} as ICodeWindow;
		let persistedProjectId: string | undefined;
		let persistedWorktreePath: string | undefined;
		let focusedWorktreePath: string | undefined;
		let focusedProjectId: string | undefined;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [project('project', [worktree('/repo')])];
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
						async findHostedWorkspaceByPath(worktreePath: string) {
							assert.strictEqual(worktreePath, '/repo');
							return {
								windowId: omni.id,
								instanceId: 'instance',
								worktreePath: '/repo',
							};
						},
						async focusHostedWorkspaceByPath(
							worktreePath: string,
							projectId?: string
						) {
							focusedWorktreePath = worktreePath;
							focusedProjectId = projectId;
							return true;
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.deepStrictEqual(
			await tryOpenFolderInHucodeHostedWorkspace(
				accessor,
				[omni],
				URI.file('/repo'),
				undefined,
				undefined
			),
			{ window: omni, openedFiles: false }
		);
		assert.strictEqual(persistedProjectId, 'project');
		assert.strictEqual(persistedWorktreePath, '/repo');
		assert.strictEqual(focusedWorktreePath, '/repo');
		assert.strictEqual(focusedProjectId, 'project');
	});

	test('focuses hosted workspace when last active persistence fails',
		async () => {
			const omni = {
				id: 1,
				isOmniWindow: true,
			} as ICodeWindow;
			let focusedWorktreePath: string | undefined;
			let focusedProjectId: string | undefined;

			const accessor = {
				get(serviceId: unknown): unknown {
					if (serviceId === IProjectManagerMainService) {
						return {
							async getProjects() {
								return [project('project', [worktree('/repo')])];
							},
							async setLastActiveWorktree() {
								throw new Error('persistence failed');
							}
						};
					}

					if (serviceId === IHucodeShellMainService) {
						return {
							async findHostedWorkspaceByPath() {
								return {
									windowId: omni.id,
									instanceId: 'instance',
									worktreePath: '/repo',
								};
							},
							async focusHostedWorkspaceByPath(
								worktreePath: string,
								projectId?: string
							) {
								focusedWorktreePath = worktreePath;
								focusedProjectId = projectId;
								return true;
							}
						};
					}

					throw new Error('Unexpected service lookup');
				}
			} as ServicesAccessor;

			await withExpectedUnexpectedError(async () =>
				assert.deepStrictEqual(
					await tryOpenFolderInHucodeHostedWorkspace(
						accessor,
						[omni],
						URI.file('/repo'),
						undefined,
						undefined
					),
					{ window: omni, openedFiles: false }
				)
			);
			assert.strictEqual(focusedWorktreePath, '/repo');
			assert.strictEqual(focusedProjectId, 'project');
		}
	);

	test('opens files in existing hosted workspace', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
		} as ICodeWindow;
		const fileUri = URI.file('/repo/file.txt');
		let openedRequest: unknown;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [project('project', [worktree('/repo')])];
						},
						async setLastActiveWorktree() { }
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async findHostedWorkspaceByPath() {
							return {
								windowId: omni.id,
								instanceId: 'instance',
								worktreePath: '/repo',
							};
						},
						async openFilesInWorkspace(
							windowId: number,
							worktreePath: string,
							request: unknown,
							projectId?: string
						) {
							assert.strictEqual(windowId, omni.id);
							assert.strictEqual(worktreePath, '/repo');
							assert.strictEqual(projectId, 'project');
							openedRequest = request;
							return true;
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.deepStrictEqual(
			await tryOpenFolderInHucodeHostedWorkspace(
				accessor,
				[omni],
				URI.file('/repo'),
				{
					filesToOpenOrCreate: [{ fileUri }],
					filesToDiff: [],
					filesToMerge: [],
				},
				'vscode'
			),
			{ window: omni, openedFiles: true }
		);
		assert.deepStrictEqual(openedRequest, {
			filesToOpenOrCreate: [{ fileUri }],
			filesToDiff: [],
			filesToMerge: [],
			filesToWait: undefined,
			termProgram: 'vscode',
		});
	});

	test('focuses hosted workspace when opening files fails', async () => {
		const omni = {
			id: 1,
			isOmniWindow: true,
		} as ICodeWindow;
		let focusedWorktreePath: string | undefined;

		const accessor = {
			get(serviceId: unknown): unknown {
				if (serviceId === IProjectManagerMainService) {
					return {
						async getProjects() {
							return [project('project', [worktree('/repo')])];
						},
						async setLastActiveWorktree() { }
					};
				}

				if (serviceId === IHucodeShellMainService) {
					return {
						async findHostedWorkspaceByPath() {
							return {
								windowId: omni.id,
								instanceId: 'instance',
								worktreePath: '/repo',
							};
						},
						async openFilesInWorkspace() {
							return false;
						},
						async focusHostedWorkspaceByPath(worktreePath: string) {
							focusedWorktreePath = worktreePath;
							return true;
						}
					};
				}

				throw new Error('Unexpected service lookup');
			}
		} as ServicesAccessor;

		assert.deepStrictEqual(
			await tryOpenFolderInHucodeHostedWorkspace(
				accessor,
				[omni],
				URI.file('/repo'),
				{
					filesToOpenOrCreate: [{ fileUri: URI.file('/repo/a.ts') }],
					filesToDiff: [],
					filesToMerge: [],
				},
				undefined
			),
			{ window: omni, openedFiles: false }
		);
		assert.strictEqual(focusedWorktreePath, '/repo');
	});
});
