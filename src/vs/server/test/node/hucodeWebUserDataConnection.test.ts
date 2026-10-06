/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IMessagePassingProtocol, IPCClient, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { SocketServer } from '../../node/serverServices.js';

interface TestConnectionContext {
	readonly remoteAuthority: string;
	readonly clientId: string;
}

suite('HucodeWebUserDataConnection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('channel calls and final removal share one server-side context object', async () => {
		const socketServer = disposables.add(new SocketServer<TestConnectionContext>());
		const disconnect = disposables.add(new Emitter<void>());
		const [clientProtocol, serverProtocol] = createProtocolPair();
		disposables.add(clientProtocol);
		disposables.add(serverProtocol);
		socketServer.acceptConnection(serverProtocol, disconnect.event);
		const serializedContext = { remoteAuthority: 'same', clientId: 'renderer' };
		const client = disposables.add(new IPCClient(clientProtocol, serializedContext));
		let callContext: TestConnectionContext | undefined;
		const channel: IServerChannel<TestConnectionContext> = {
			call: async <T>(context: TestConnectionContext): Promise<T> => {
				callContext = context;
				return undefined as T;
			},
			listen: () => Event.None,
		};
		socketServer.registerChannel('identity', channel);
		const removed = Event.toPromise(socketServer.onDidRemoveConnection);

		await client.getChannel('identity').call('capture');
		let removalObserved = false;
		void removed.then(() => removalObserved = true);
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(removalObserved, false, 'cleanup must wait for the supplied logical-disconnect event');

		disconnect.fire();
		const removedConnection = await removed;
		assert.notStrictEqual(callContext, serializedContext, 'the server must own a deserialized context object');
		assert.strictEqual(removedConnection.ctx, callContext);
	});

	test('serialized-equal clients receive distinct server-side context identities', async () => {
		const socketServer = disposables.add(new SocketServer<TestConnectionContext>());
		const contexts: TestConnectionContext[] = [];
		socketServer.registerChannel('identity', {
			call: async <T>(context: TestConnectionContext): Promise<T> => {
				contexts.push(context);
				return undefined as T;
			},
			listen: () => Event.None,
		});
		const first = createClient(socketServer, { remoteAuthority: 'same', clientId: 'renderer' });
		const second = createClient(socketServer, { remoteAuthority: 'same', clientId: 'renderer' });

		await first.client.getChannel('identity').call('capture');
		await second.client.getChannel('identity').call('capture');

		assert.deepStrictEqual(contexts, [
			{ remoteAuthority: 'same', clientId: 'renderer' },
			{ remoteAuthority: 'same', clientId: 'renderer' },
		]);
		assert.notStrictEqual(contexts[0], contexts[1]);

		first.disconnect.fire();
		second.disconnect.fire();
	});

	function createClient(socketServer: SocketServer<TestConnectionContext>, context: TestConnectionContext): { client: IPCClient<TestConnectionContext>; disconnect: Emitter<void> } {
		const disconnect = disposables.add(new Emitter<void>());
		const [clientProtocol, serverProtocol] = createProtocolPair();
		disposables.add(clientProtocol);
		disposables.add(serverProtocol);
		socketServer.acceptConnection(serverProtocol, disconnect.event);
		return {
			client: disposables.add(new IPCClient(clientProtocol, context)),
			disconnect,
		};
	}
});

class BufferedTestProtocol implements IMessagePassingProtocol, IDisposable {
	private buffering = true;
	private buffers: VSBuffer[] = [];
	private readonly emitter = new Emitter<VSBuffer>({
		onDidAddFirstListener: () => {
			for (const buffer of this.buffers) {
				this.emitter.fire(buffer);
			}
			this.buffers = [];
			this.buffering = false;
		},
		onDidRemoveLastListener: () => this.buffering = true,
	});
	readonly onMessage = this.emitter.event;
	other: BufferedTestProtocol | undefined;

	send(buffer: VSBuffer): void {
		this.other?.receive(buffer);
	}

	dispose(): void {
		this.emitter.dispose();
		this.buffers = [];
	}

	private receive(buffer: VSBuffer): void {
		if (this.buffering) {
			this.buffers.push(buffer);
		} else {
			this.emitter.fire(buffer);
		}
	}
}

function createProtocolPair(): [BufferedTestProtocol, BufferedTestProtocol] {
	const first = new BufferedTestProtocol();
	const second = new BufferedTestProtocol();
	first.other = second;
	second.other = first;
	return [first, second];
}
