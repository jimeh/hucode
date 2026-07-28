/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

/** Platform-neutral lifecycle state observed by the shared contract. */
export interface IHostedWorkspaceContractState {
	readonly activePath?: string;
	readonly instances: readonly {
		readonly path: string;
		readonly state: string;
	}[];
	readonly retainedDesiredState?: string;
}

/** Outcome of reactivating a workbench during its unload preparation. */
export interface IHostedWorkspaceGenerationGuardResult {
	readonly state: IHostedWorkspaceContractState;
	readonly commitCount: number;
}

/** Outcome of closing one retained workbench. */
export interface IHostedWorkspaceCoherentCloseResult {
	readonly state: IHostedWorkspaceContractState;
	readonly emittedState?: IHostedWorkspaceContractState;
	readonly emissionCount: number;
}

/** State transitions produced by active-only startup restoration. */
export interface IHostedWorkspaceRestoreResult {
	readonly beforeReady: IHostedWorkspaceContractState;
	readonly afterReady: IHostedWorkspaceContractState;
	readonly createdHosts: number;
}

/** Outcome of closing the active workbench when another is resident. */
export interface IHostedWorkspaceCloseNextResult {
	readonly state: IHostedWorkspaceContractState;
	readonly unloadPhases: readonly string[];
}

/** Observable close and teardown outcomes around an initial veto. */
export interface IHostedWorkspaceShutdownResult {
	readonly closeState: IHostedWorkspaceContractState;
	readonly closePhases: readonly string[];
	readonly shutdownState: IHostedWorkspaceContractState;
	readonly shutdownPhases: readonly string[];
	readonly restorePathsBeforeShutdown: readonly string[];
	readonly restorePathsAfterShutdown: readonly string[];
}

/**
 * Platform adapter for the lifecycle outcomes whose policy desktop and web
 * Omni must keep identical. Each method owns only the platform mechanics
 * needed to drive the named scenario.
 */
export interface IHostedWorkspaceLifecycleContractAdapter {
	generationGuard(): Promise<IHostedWorkspaceGenerationGuardResult>;
	coherentRetainedClose(): Promise<IHostedWorkspaceCoherentCloseResult>;
	restoreActiveOnly(): Promise<IHostedWorkspaceRestoreResult>;
	closeActiveAndPromoteNext(): Promise<IHostedWorkspaceCloseNextResult>;
	vetoThenShutdown(): Promise<IHostedWorkspaceShutdownResult>;
}

/**
 * Registers the shared hosted-workspace lifecycle contract against one
 * platform adapter. The same assertions intentionally run in both controller
 * suites while their native host mechanics remain separate.
 */
export function registerHostedWorkspaceLifecycleContract(
	createAdapter: () => IHostedWorkspaceLifecycleContractAdapter
): void {
	suite('hosted workspace lifecycle contract', () => {
		test('a reactivation supersedes an in-flight close', async () => {
			const result = await createAdapter().generationGuard();

			assertState(result.state, {
				activePath: 'alpha',
				instances: [
					{ path: 'alpha', state: 'active' },
					{ path: 'beta', state: 'loaded' },
				],
			});
			assert.strictEqual(result.commitCount, 0);
		});

		test('a retained close publishes one coherent final state', async () => {
			const result = await createAdapter().coherentRetainedClose();

			assert.strictEqual(result.emissionCount, 1);
			assertState(result.state, {
				instances: [],
				retainedDesiredState: 'unloaded',
			});
			assertState(result.emittedState, result.state);
		});

		test('active-only restoration defers readiness and dormancy',
			async () => {
				const result = await createAdapter().restoreActiveOnly();

				assertState(result.beforeReady, {
					activePath: 'alpha',
					instances: [
						{ path: 'alpha', state: 'loading' },
						{ path: 'beta', state: 'dormant' },
					],
				});
				assertState(result.afterReady, {
					activePath: 'alpha',
					instances: [
						{ path: 'alpha', state: 'active' },
						{ path: 'beta', state: 'dormant' },
					],
				});
				assert.strictEqual(result.createdHosts, 1);
			}
		);

		test('closing the active workbench promotes the next MRU',
			async () => {
				const result = await createAdapter().closeActiveAndPromoteNext();

				assertState(result.state, {
					activePath: 'beta',
					instances: [
						{ path: 'alpha', state: 'loaded' },
						{ path: 'beta', state: 'active' },
					],
				});
				assert.deepStrictEqual(
					result.unloadPhases,
					['prepare', 'commit']
				);
			}
		);

		test('a veto preserves state before ordered shell shutdown', async () => {
			const result = await createAdapter().vetoThenShutdown();

			assertState(result.closeState, {
				activePath: 'alpha',
				instances: [{ path: 'alpha', state: 'active' }],
			});
			assert.deepStrictEqual(result.closePhases, ['prepare']);
			assert.deepStrictEqual(result.shutdownPhases, [
				'prepare',
				'commit',
			]);
			assert.deepStrictEqual(
				result.restorePathsAfterShutdown,
				result.restorePathsBeforeShutdown
			);
			assert.strictEqual(
				result.shutdownState.instances.some(instance =>
					instance.state !== 'unloaded'
				),
				false
			);
		});
	});
}

function assertState(
	actual: IHostedWorkspaceContractState | undefined,
	expected: IHostedWorkspaceContractState
): void {
	assert.ok(actual);
	assert.deepStrictEqual({
		activePath: actual.activePath,
		instances: [...actual.instances].sort((a, b) =>
			a.path.localeCompare(b.path)),
		retainedDesiredState: actual.retainedDesiredState,
	}, {
		activePath: expected.activePath,
		instances: [...expected.instances].sort((a, b) =>
			a.path.localeCompare(b.path)),
		retainedDesiredState: expected.retainedDesiredState,
	});
}
