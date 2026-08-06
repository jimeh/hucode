/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableMap } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IHucodeHostedShellBinding } from
	'../../../platform/window/common/hucodeHostedShellService.js';
import {
	acceptHucodeHostedShellPortRequest,
	IHucodeHostedShellPortController,
} from '../../electron-main/hostedShellPortAcceptor.js';

suite('HostedShellMainService capability port', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('derives identity from the sender and replaces its connection', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept('nonce-1'), true);
		assert.strictEqual(harness.accept('nonce-2'), true);

		assert.deepStrictEqual(harness.acquiredWebContentsIds, [7, 7]);
		assert.deepStrictEqual(harness.responses.map(response => ({
			channel: response.channel,
			nonce: response.nonce,
			portCount: response.ports.length,
		})), [
			{
				channel: 'vscode:hucodeHostedShellPortResult',
				nonce: 'nonce-1',
				portCount: 1,
			},
			{
				channel: 'vscode:hucodeHostedShellPortResult',
				nonce: 'nonce-2',
				portCount: 1,
			},
		]);
		assert.deepStrictEqual(harness.transferredConnectionIds, [1, 2]);
		assert.deepStrictEqual(harness.disposedConnectionIds, [1]);
		assert.strictEqual(harness.connections.size, 1);
	});

	test('denies invalid, destroyed, and unknown senders without authority', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept(''), false);
		harness.sender.destroyed = true;
		assert.strictEqual(harness.accept('destroyed'), false);
		harness.sender.destroyed = false;
		harness.owners.clear();
		assert.strictEqual(harness.accept('unknown'), false);

		assert.deepStrictEqual(harness.acquiredWebContentsIds, []);
		assert.deepStrictEqual(harness.responses, [{
			channel: 'vscode:hucodeHostedShellPortResult',
			nonce: 'unknown',
			ports: [],
		}]);
		assert.deepStrictEqual(harness.refusals, [
			'invalid nonce',
			'destroyed sender',
			'unknown sender',
		]);
	});

	test('releases mismatched and failed bindings', () => {
		const harness = createHarness();
		disposables.add(harness.connections);
		harness.binding = {
			windowId: 1,
			instanceId: 'different-instance',
			connectionGeneration: 1,
		};
		assert.strictEqual(harness.accept('mismatch'), false);
		assert.deepStrictEqual(
			harness.releasedBindings.map(binding => binding.instanceId),
			['different-instance']
		);

		harness.binding = {
			windowId: 1,
			instanceId: 'instance-1',
			connectionGeneration: 2,
		};
		let postCount = 0;
		harness.sender.postMessageHook = () => {
			if (postCount++ === 0) {
				throw new Error('transfer failed');
			}
		};
		assert.strictEqual(harness.accept('transfer-failure'), false);

		assert.deepStrictEqual(
			harness.releasedBindings.map(binding => binding.connectionGeneration),
			[1, 2]
		);
		assert.deepStrictEqual(harness.disposedConnectionIds, [1]);
		assert.strictEqual(harness.connections.size, 0);
		assert.strictEqual(harness.failures.length, 1);
		assert.deepStrictEqual(harness.responses.at(-1), {
			channel: 'vscode:hucodeHostedShellPortResult',
			nonce: 'transfer-failure',
			ports: [],
		});
	});
});

function createHarness() {
	const owners = new Map([[7, {
		windowId: 1,
		instanceId: 'instance-1',
	}]]);
	const connections = new DisposableMap<number>();
	const acquiredWebContentsIds: number[] = [];
	const releasedBindings: IHucodeHostedShellBinding[] = [];
	const disposedConnectionIds: number[] = [];
	const transferredConnectionIds: number[] = [];
	const responses: Array<{
		channel: string;
		nonce: string;
		ports: Electron.MessagePortMain[];
	}> = [];
	const refusals: string[] = [];
	const failures: unknown[] = [];
	let connectionId = 0;
	const sender = {
		id: 7,
		destroyed: false,
		postMessageHook: undefined as (() => void) | undefined,
		isDestroyed() {
			return this.destroyed;
		},
		postMessage(
			channel: string,
			nonce: string,
			ports: Electron.MessagePortMain[]
		) {
			this.postMessageHook?.();
			responses.push({ channel, nonce, ports });
		},
	};
	const controller = {
		acquireHostedShellBinding(webContentsId: number) {
			acquiredWebContentsIds.push(webContentsId);
			return harness.binding;
		},
		releaseHostedShellBinding(binding: IHucodeHostedShellBinding) {
			releasedBindings.push(binding);
		},
	} as IHucodeHostedShellPortController;
	const harness = {
		owners,
		connections,
		acquiredWebContentsIds,
		releasedBindings,
		disposedConnectionIds,
		transferredConnectionIds,
		responses,
		refusals,
		failures,
		sender,
		binding: {
			windowId: 1,
			instanceId: 'instance-1',
			connectionGeneration: 1,
		} as IHucodeHostedShellBinding | undefined,
		accept(nonce: unknown) {
			return acceptHucodeHostedShellPortRequest({
				ownersByWebContentsId: owners,
				getController: windowId => windowId === 1
					? controller
					: undefined,
				connections,
				createConnection: () => {
					const id = ++connectionId;
					return {
						transferPort: { id } as unknown as Electron.MessagePortMain,
						markTransferred: () =>
							transferredConnectionIds.push(id),
						dispose: () => disposedConnectionIds.push(id),
					};
				},
				logRefusal: reason => refusals.push(reason),
				logFailure: error => failures.push(error),
			}, {
				sender: sender as unknown as Electron.WebContents,
			}, nonce);
		},
	};
	return harness;
}
