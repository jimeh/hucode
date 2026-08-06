/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableMap } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	acceptHucodeShellControllerPortRequest,
	IHucodeShellControllerPortOwner,
} from '../../electron-main/shellControllerPortAcceptor.js';

suite('ShellControllerMainService capability port', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('binds the sender-derived owner and replaces its connection', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept('nonce-1'), true);
		assert.strictEqual(harness.accept('nonce-2'), true);

		assert.deepStrictEqual(harness.acquiredOwners, [
			{ windowId: 3, webContentsId: 7 },
			{ windowId: 3, webContentsId: 7 },
		]);
		assert.deepStrictEqual(harness.transferred, [1, 2]);
		assert.deepStrictEqual(harness.disposed, [1]);
		assert.deepStrictEqual(harness.responses.map(response => ({
			nonce: response.nonce,
			portCount: response.ports.length,
		})), [
			{ nonce: 'nonce-1', portCount: 1 },
			{ nonce: 'nonce-2', portCount: 1 },
		]);
	});

	test('denies invalid, destroyed, and non-owner renderers', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept(''), false);
		harness.sender.destroyed = true;
		assert.strictEqual(harness.accept('destroyed'), false);
		harness.sender.destroyed = false;
		harness.owner = undefined;
		assert.strictEqual(harness.accept('ordinary'), false);

		assert.deepStrictEqual(harness.acquiredOwners, []);
		assert.deepStrictEqual(harness.refusals, [
			'invalid nonce',
			'destroyed sender',
			'unknown or non-owner sender',
		]);
		assert.deepStrictEqual(harness.responses.at(-1), {
			nonce: 'ordinary',
			ports: [],
		});
	});

	test('fails closed if the shell renderer changes during setup', () => {
		const harness = createHarness();
		disposables.add(harness.connections);
		harness.onCreateConnection = () => {
			harness.owner = { windowId: 3, webContentsId: 8 };
		};

		assert.strictEqual(harness.accept('replaced'), false);
		assert.deepStrictEqual(harness.disposed, [1]);
		assert.deepStrictEqual(harness.transferred, []);
		assert.strictEqual(harness.connections.size, 0);
		assert.deepStrictEqual(harness.responses.at(-1), {
			nonce: 'replaced',
			ports: [],
		});
	});
});

function createHarness() {
	const connections = new DisposableMap<number>();
	const acquiredOwners: IHucodeShellControllerPortOwner[] = [];
	const disposed: number[] = [];
	const transferred: number[] = [];
	const refusals: string[] = [];
	const failures: unknown[] = [];
	const responses: Array<{
		readonly nonce: string;
		readonly ports: Electron.MessagePortMain[];
	}> = [];
	let nextConnectionId = 0;
	const sender = {
		id: 7,
		destroyed: false,
		isDestroyed() { return this.destroyed; },
		postMessage(
			_channel: string,
			nonce: string,
			ports: Electron.MessagePortMain[]
		) {
			responses.push({ nonce, ports });
		},
	};
	const harness = {
		connections,
		acquiredOwners,
		disposed,
		transferred,
		refusals,
		failures,
		responses,
		sender,
		owner: { windowId: 3, webContentsId: 7 } as
			IHucodeShellControllerPortOwner | undefined,
		onCreateConnection: undefined as (() => void) | undefined,
		accept(nonce: unknown) {
			return acceptHucodeShellControllerPortRequest({
				resolveOwner: () => harness.owner,
				connections,
				createConnection: owner => {
					acquiredOwners.push(owner);
					harness.onCreateConnection?.();
					const id = ++nextConnectionId;
					return {
						transferPort: { id } as unknown as
							Electron.MessagePortMain,
						markTransferred: () => transferred.push(id),
						dispose: () => disposed.push(id),
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
