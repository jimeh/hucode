/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { DisposableMap } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	acceptHucodeShellControllerPortRequest,
	IHucodeShellControllerPortOwner,
	registerHucodeShellControllerOwnerLifecycle,
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

	test('denies invalid, destroyed, unknown, and non-owner renderers', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept(''), false);
		harness.sender.destroyed = true;
		assert.strictEqual(harness.accept('destroyed'), false);
		harness.sender.destroyed = false;
		harness.owner = undefined;
		assert.strictEqual(harness.accept('unknown'), false);
		harness.owner = { windowId: 3, webContentsId: 8 };
		assert.strictEqual(harness.accept('non-owner'), false);

		assert.deepStrictEqual(harness.acquiredOwners, []);
		assert.deepStrictEqual(harness.refusals, [
			'invalid nonce',
			'destroyed sender',
			'unknown or non-owner sender',
			'unknown or non-owner sender',
		]);
		assert.deepStrictEqual(harness.responses.at(-1), {
			nonce: 'non-owner',
			ports: [],
		});
	});

	test('preserves an existing connection when replacement creation fails', () => {
		const harness = createHarness();
		disposables.add(harness.connections);

		assert.strictEqual(harness.accept('connected'), true);
		harness.onCreateConnection = () => {
			throw new Error('replacement failed');
		};
		assert.strictEqual(harness.accept('failed-replacement'), false);

		assert.strictEqual(harness.connections.size, 1);
		assert.deepStrictEqual(harness.transferred, [1]);
		assert.deepStrictEqual(harness.disposed, []);
		assert.deepStrictEqual(harness.responses.at(-1), {
			nonce: 'failed-replacement',
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

	test('keeps the connection across subframe loading', () => {
		const webContents = new EventEmitter() as EventEmitter & {
			isLoadingMainFrame(): boolean;
		};
		let isLoadingMainFrame = false;
		webContents.isLoadingMainFrame = () => isLoadingMainFrame;
		let disposeCalls = 0;
		const registration = disposables.add(
			registerHucodeShellControllerOwnerLifecycle(
				webContents as unknown as Electron.WebContents,
				() => disposeCalls++
			)
		);

		webContents.emit('did-start-loading');
		assert.strictEqual(disposeCalls, 0);
		isLoadingMainFrame = true;
		webContents.emit('did-start-loading');
		assert.strictEqual(disposeCalls, 1);
		registration.dispose();
		webContents.emit('render-process-gone');
		assert.strictEqual(disposeCalls, 1);
	});

	test('disposes an active connection when the renderer exits', () => {
		const webContents = new EventEmitter() as EventEmitter & {
			isLoadingMainFrame(): boolean;
		};
		webContents.isLoadingMainFrame = () => false;
		let disposeCalls = 0;
		const registration = disposables.add(
			registerHucodeShellControllerOwnerLifecycle(
				webContents as unknown as Electron.WebContents,
				() => disposeCalls++
			)
		);

		webContents.emit('render-process-gone');
		assert.strictEqual(disposeCalls, 1);
		registration.dispose();
	});

	test('disposes an active connection when WebContents is destroyed', () => {
		const webContents = new EventEmitter() as EventEmitter & {
			isLoadingMainFrame(): boolean;
		};
		webContents.isLoadingMainFrame = () => false;
		let disposeCalls = 0;
		const registration = disposables.add(
			registerHucodeShellControllerOwnerLifecycle(
				webContents as unknown as Electron.WebContents,
				() => disposeCalls++
			)
		);

		webContents.emit('destroyed');
		assert.strictEqual(disposeCalls, 1);
		registration.dispose();
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
