/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { DeferredPromise } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { DefaultURITransformer } from '../../../base/common/uriIpc.js';
import { createURITransformer } from '../../../base/common/uriTransformer.js';
import { URI } from '../../../base/common/uri.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { HucodeWebUserDataProfilesChannel, validateWebProfileCatalog } from '../../node/hucodeWebUserDataProfiles.js';
import { HUCODE_WEB_USER_DATA_API_PATH, HucodeWebUserDataServer, HucodeWebUserDataServerOptions, isHucodeWebUserDataNonGetRequestAllowed } from '../../node/hucodeWebUserDataServer.js';
import { ServerEnvironmentService } from '../../node/serverEnvironmentService.js';

suite('HucodeWebUserDataServer', () => {
	let testHome: string;
	let fileService: FileService;
	let diskProvider: DiskFileSystemProvider;
	let server: HucodeWebUserDataServer;
	let logService: RecordingLogService;
	let uriIdentityService: UriIdentityService;

	teardown(async () => {
		await server.close();
		server.dispose();
		fileService.dispose();
		diskProvider.dispose();
		await fs.rm(testHome, { recursive: true, force: true });
	});

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		testHome = await fs.mkdtemp(join(tmpdir(), 'hucode-web-user-data-server-'));
		logService = new RecordingLogService();
		fileService = disposables.add(new FileService(logService));
		diskProvider = disposables.add(new DiskFileSystemProvider(logService));
		disposables.add(fileService.registerProvider(Schemas.file, diskProvider));
		uriIdentityService = disposables.add(new UriIdentityService(fileService));
		server = createServer();
	});

	function createServer(options: HucodeWebUserDataServerOptions = {}, mode: 'browser' | 'server' = 'server'): HucodeWebUserDataServer {
		return disposables.add(new HucodeWebUserDataServer(
			testHome,
			mode,
			new ServerEnvironmentService({
				_: [],
				'user-data-dir': testHome,
			} as never, { _serviceBrand: undefined, ...product }),
			fileService,
			uriIdentityService,
			logService,
			options,
		));
	}

	async function reopenServer(options: HucodeWebUserDataServerOptions = {}): Promise<void> {
		await server.close();
		server.dispose();
		server = createServer(options);
	}

	test('first claimant commits one authoritative generation', async () => {
		const initial = await invoke(server, 'GET', '/bootstrap');
		assert.strictEqual(initial.status, 200);
		assert.strictEqual(initial.value.state, 'uninitialized');

		const first = await invoke(server, 'POST', '/claim', {});
		const losing = await invoke(server, 'POST', '/claim', {});
		assert.strictEqual(first.status, 200);
		assert.strictEqual(first.value.claimed, true);
		assert.strictEqual(losing.status, 409);
		assert.strictEqual(losing.value.claimed, false);

		const lease = first.value as { owner: string; generation: number };
		const renewed = await invoke(server, 'POST', '/renew', lease);
		assert.strictEqual(renewed.status, 200);
		assert.strictEqual(renewed.value.generation, lease.generation);
		const rejectedRenewal = await invoke(server, 'POST', '/renew', { ...lease, generation: lease.generation + 1 });
		assert.strictEqual(rejectedRenewal.status, 400);
		assert.match(String(rejectedRenewal.value.error), /lease or generation does not match/);
		const migration = {
			files: [{ path: '/User/settings.json', contents: Buffer.from('{"editor.fontSize":14}').toString('base64') }],
			profiles: [],
			associations: {},
			state: [{ id: 'global', items: [['theme', 'dark']] }],
		};
		const rejectedUpload = await invoke(server, 'POST', '/upload', {
			...lease,
			generation: lease.generation + 1,
			migration,
		});
		assert.strictEqual(rejectedUpload.status, 400);
		assert.match(String(rejectedUpload.value.error), /lease or generation does not match/);
		assert.strictEqual((await invoke(server, 'GET', '/bootstrap')).value.state, 'staging');
		const upload = await invoke(server, 'POST', '/upload', {
			...lease,
			migration,
		});
		assert.strictEqual(upload.status, 200);

		const rejectedCommit = await invoke(server, 'POST', '/commit', { ...lease, generation: lease.generation + 1 });
		assert.strictEqual(rejectedCommit.status, 400);
		assert.match(String(rejectedCommit.value.error), /lease or generation does not match/);
		assert.strictEqual((await invoke(server, 'GET', '/bootstrap')).value.state, 'staging');
		const committed = await invoke(server, 'POST', '/commit', lease);
		assert.strictEqual(committed.status, 200);
		assert.strictEqual(committed.value.committed, true);
		assert.strictEqual(await fs.readFile(join(testHome, 'WebUser', 'User', 'settings.json'), 'utf8'), '{"editor.fontSize":14}');

		const ready = await invoke(server, 'GET', '/bootstrap');
		assert.strictEqual(ready.value.state, 'ready');
		assert.strictEqual(ready.value.generation, lease.generation);
		const lateCommit = await invoke(server, 'POST', '/commit', lease);
		assert.strictEqual(lateCommit.status, 409);
		assert.strictEqual(lateCommit.value.committed, false);
	});

	test('rejects migration paths outside the web user namespace', async () => {
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };
		const upload = await invoke(server, 'POST', '/upload', {
			...lease,
			migration: {
				files: [{ path: '/User/../../outside', contents: '' }],
				profiles: [],
				associations: {},
				state: [],
			},
		});

		assert.strictEqual(upload.status, 400);
		assert.match(String(upload.value.error), /escapes the server namespace/);
		await assert.rejects(fs.stat(join(testHome, 'outside')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
		assert.strictEqual((await invoke(server, 'GET', '/bootstrap')).value.state, 'staging');
	});

	test('rejects non-string migrated state identifiers as request errors', async () => {
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };
		const upload = await invoke(server, 'POST', '/upload', {
			...lease,
			migration: {
				files: [],
				profiles: [],
				associations: {},
				state: [{ id: 42, items: [] }],
			},
		});

		assert.strictEqual(upload.status, 400);
		assert.strictEqual(upload.value.error, 'Invalid migrated workspace state identifier.');
	});

	test('rejects profile traversal before creating a folder', async () => {
		await invoke(server, 'POST', '/initialize-empty', {});
		const channel = new HucodeWebUserDataProfilesChannel(server.profilesService!, () => DefaultURITransformer);

		await assert.rejects(
			channel.call(null, 'createProfile', ['../../escaped-profile', 'Escape']),
			/Invalid web user-data profile identifier/,
		);
		await assert.rejects(
			fs.stat(join(testHome, 'WebUser', 'escaped-profile')),
			error => (error as NodeJS.ErrnoException).code === 'ENOENT',
		);
	});

	test('rejects case-folded profile collisions before creating a folder', async () => {
		await invoke(server, 'POST', '/initialize-empty', {});
		const channel = new HucodeWebUserDataProfilesChannel(server.profilesService!, () => DefaultURITransformer);
		await channel.call(null, 'createProfile', ['Foo', 'First']);

		await assert.rejects(
			channel.call(null, 'createProfile', ['foo', 'Second']),
			/Invalid web user-data profile identifier/,
		);
		assert.deepStrictEqual(await fs.readdir(join(testHome, 'WebUser', 'User', 'profiles')), ['Foo']);
	});

	test('rejects case-folded migrated profile collisions before staging files', async () => {
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };
		const sentinel = join(testHome, 'WebUser', '.staging', lease.owner, 'sentinel');
		await fs.writeFile(sentinel, 'preserved');

		const upload = await invoke(server, 'POST', '/upload', {
			...lease,
			migration: {
				files: [{ path: '/User/profiles/Foo/settings.json', contents: '' }],
				profiles: [{ id: 'Foo', name: 'First' }, { id: 'foo', name: 'Second' }],
				associations: {},
				state: [],
			},
		});

		assert.strictEqual(upload.status, 400);
		assert.match(String(upload.value.error), /Invalid migrated profile identifier/);
		assert.strictEqual(await fs.readFile(sentinel, 'utf8'), 'preserved');
	});

	test('rejects all-dot migrated profile identifiers', async () => {
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };

		for (const id of ['.', '..', '...']) {
			const upload = await invoke(server, 'POST', '/upload', {
				...lease,
				migration: {
					files: [],
					profiles: [{ id, name: 'Escape' }],
					associations: {},
					state: [],
				},
			});

			assert.strictEqual(upload.status, 400);
			assert.match(String(upload.value.error), /Invalid migrated profile identifier/);
		}
	});

	test('validates every stored catalog field', () => {
		const invalidCatalogs = [
			{ profiles: [{ id: 'duplicate', name: 'One' }, { id: 'duplicate', name: 'Two' }], associations: {} },
			{ profiles: [{ id: 'Foo', name: 'One' }, { id: 'foo', name: 'Two' }], associations: {} },
			{ profiles: [{ id: '..', name: 'Unsafe' }], associations: {} },
			{ profiles: [{ id: 'valid', name: '' }], associations: {} },
			{ profiles: [{ id: 'valid', name: 'Valid' }], associations: { workspaces: [] } },
			{ profiles: [{ id: 'valid', name: 'Valid' }], associations: { emptyWindows: { window: '..' } } },
			{ profiles: [{ id: 'valid', name: 'Valid' }], associations: { workspaces: { workspace: 'missing' } } },
		];

		for (const catalog of invalidCatalogs) {
			assert.throws(() => validateWebProfileCatalog(catalog, 'stored'), /Invalid stored/);
		}
		assert.doesNotThrow(() => validateWebProfileCatalog({
			profiles: [{ id: 'valid', name: 'Valid' }],
			associations: { workspaces: { profile: 'valid', default: '__default__profile__' } },
		}, 'stored'));
	});

	test('ready restart rejects corrupt catalog without replacing it', async () => {
		await invoke(server, 'POST', '/initialize-empty', {});
		const catalogPath = join(testHome, 'WebUser', 'profiles.json');
		const corrupt = '{not json';
		await fs.writeFile(catalogPath, corrupt);
		await reopenServer();

		const bootstrap = await invoke(server, 'GET', '/bootstrap');
		const reset = await invoke(server, 'POST', '/reset', {});

		assert.strictEqual(bootstrap.status, 500);
		assert.strictEqual(bootstrap.value.error, 'Unable to complete the serve-web user-data request.');
		assert.strictEqual(reset.status, 500);
		assert.strictEqual(reset.value.error, 'Unable to complete the serve-web user-data request.');
		assert.strictEqual(await fs.readFile(catalogPath, 'utf8'), corrupt);
	});

	test('ready restart rejects malformed catalog without replacing it', async () => {
		await invoke(server, 'POST', '/initialize-empty', {});
		const catalogPath = join(testHome, 'WebUser', 'profiles.json');
		const malformed = JSON.stringify({ profiles: [], associations: { workspaces: [] } });
		await fs.writeFile(catalogPath, malformed);
		await reopenServer();

		const bootstrap = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(bootstrap.status, 500);
		assert.strictEqual(bootstrap.value.error, 'Unable to complete the serve-web user-data request.');
		assert.strictEqual(await fs.readFile(catalogPath, 'utf8'), malformed);
	});

	test('ready restart rejects a missing catalog without recreating it', async () => {
		await invoke(server, 'POST', '/initialize-empty', {});
		const catalogPath = join(testHome, 'WebUser', 'profiles.json');
		await fs.rm(catalogPath);
		await reopenServer();

		const bootstrap = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(bootstrap.status, 500);
		assert.strictEqual(bootstrap.value.error, 'Unable to complete the serve-web user-data request.');
		await assert.rejects(fs.stat(catalogPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
	});

	test('does not publish an incomplete migration', async () => {
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };

		const commit = await invoke(server, 'POST', '/commit', lease);

		assert.strictEqual(commit.status, 400);
		assert.match(String(commit.value.error), /Migration upload is incomplete/);
		const status = await invoke(server, 'GET', '/bootstrap');
		assert.strictEqual(status.value.state, 'staging');
		assert.strictEqual(status.value.generation, lease.generation);
	});

	test('initializes an empty server once', async () => {
		const nonJson = await invoke(server, 'POST', '/initialize-empty', {}, 'text/plain');
		assert.strictEqual(nonJson.status, 415);

		const initialized = await invoke(server, 'POST', '/initialize-empty', {});
		assert.strictEqual(initialized.status, 200);
		assert.strictEqual(initialized.value.committed, true);

		const repeated = await invoke(server, 'POST', '/initialize-empty', {});
		assert.strictEqual(repeated.status, 409);
		assert.strictEqual(repeated.value.committed, false);
	});

	test('resets shared server data without returning to uninitialized state', async () => {
		const initialized = await invoke(server, 'POST', '/initialize-empty', {});
		const initialGeneration = initialized.value.generation as number;
		await fs.writeFile(join(testHome, 'WebUser', 'User', 'settings.json'), '{}');
		await server.storageChannel!.call(null as never, 'updateItems', {
			profile: undefined,
			workspace: undefined,
			insert: [['layout', 'wide']],
		});
		await server.profilesService!.createNamedProfile('Work');

		const reset = await invoke(server, 'POST', '/reset', {});

		assert.strictEqual(reset.status, 200);
		assert.strictEqual(reset.value.reset, true);
		assert.strictEqual(reset.value.generation, initialGeneration + 1);
		await assert.rejects(fs.stat(join(testHome, 'WebUser', 'User', 'settings.json')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
		assert.deepStrictEqual(await server.storageChannel!.call(null as never, 'getItems', { profile: undefined, workspace: undefined }), []);
		assert.strictEqual(server.profilesService!.profiles.length, 1);
		const ready = await invoke(server, 'GET', '/bootstrap');
		assert.strictEqual(ready.value.state, 'ready');
	});

	test('serializes profile mutation with reset and holds operation leases while blocked', async () => {
		let activeLeases = 0;
		let acquiredLeases = 0;
		const acquireOperationLease = (): IDisposable => {
			activeLeases++;
			acquiredLeases++;
			return toDisposable(() => activeLeases--);
		};
		await reopenServer({ acquireOperationLease });
		await invoke(server, 'POST', '/initialize-empty', {});
		const channel = server.createProfilesChannel(() => DefaultURITransformer);
		const createStarted = new DeferredPromise<void>();
		const allowCreate = new DeferredPromise<void>();
		disposables.add(server.profilesService!.onWillCreateProfile(event => {
			createStarted.complete();
			event.join(allowCreate.p);
		}));

		const create = channel.call(null, 'createProfile', ['race-profile', 'Race']);
		await createStarted.p;
		assert.strictEqual(activeLeases, 1);
		const reset = invoke(server, 'POST', '/reset', {});
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(activeLeases, 2, 'waiting reset must retain its operation lease');

		allowCreate.complete();
		await create;
		assert.strictEqual((await reset).status, 200);
		assert.strictEqual(activeLeases, 0);
		assert.deepStrictEqual(server.profilesService!.profiles.map(profile => profile.id), ['__default__profile__']);
		await assert.rejects(
			fs.stat(join(testHome, 'WebUser', 'User', 'profiles', 'race-profile')),
			error => (error as NodeJS.ErrnoException).code === 'ENOENT',
		);

		const beforeStorage = acquiredLeases;
		await server.storageChannel!.call(null as never, 'getItems', { profile: undefined, workspace: undefined });
		assert.strictEqual(acquiredLeases, beforeStorage + 1, 'state storage must acquire an operation lease');
		assert.strictEqual(activeLeases, 0);
	});

	test('holds an HTTP response lease until response settlement', async () => {
		let activeResponses = 0;
		await reopenServer({
			acquireResponseLease: () => {
				activeResponses++;
				return toDisposable(() => activeResponses--);
			},
		});
		const responseEvents = new EventEmitter();

		const bootstrap = await invoke(server, 'GET', '/bootstrap', undefined, 'application/json', responseEvents);

		assert.strictEqual(bootstrap.status, 200);
		assert.strictEqual(activeResponses, 1);
		responseEvents.emit('finish');
		assert.strictEqual(activeResponses, 0);
	});

	test('refreshes a lease after a long upload so queued renewal and commit succeed', async () => {
		let now = 0;
		const uploadStaged = new DeferredPromise<void>();
		const releaseUpload = new DeferredPromise<void>();
		await reopenServer({
			now: () => now,
			leaseMs: 10,
			beforeUploadLeaseRefresh: async () => {
				uploadStaged.complete();
				await releaseUpload.p;
			},
		});
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };
		const upload = invoke(server, 'POST', '/upload', {
			...lease,
			migration: { files: [], profiles: [], associations: {}, state: [] },
		});
		await uploadStaged.p;
		const renewal = invoke(server, 'POST', '/renew', lease);
		now = 11;
		releaseUpload.complete();

		assert.strictEqual((await upload).status, 200);
		const renewed = await renewal;
		assert.strictEqual(renewed.status, 200);
		assert.strictEqual(renewed.value.expiresAt, 21);
		assert.strictEqual((await invoke(server, 'POST', '/commit', lease)).status, 200);
	});

	test('logs unexpected failures without exposing host paths', async () => {
		const failure = new Error(`ENOENT: unable to open ${join(testHome, 'private', 'state.vscdb')}`);
		await reopenServer({ beforeUploadLeaseRefresh: async () => { throw failure; } });
		const claim = await invoke(server, 'POST', '/claim', {});
		const lease = claim.value as { owner: string; generation: number };

		const upload = await invoke(server, 'POST', '/upload', {
			...lease,
			migration: { files: [], profiles: [], associations: {}, state: [] },
		});

		assert.strictEqual(upload.status, 500);
		assert.strictEqual(upload.value.error, 'Unable to complete the serve-web user-data request.');
		assert.ok(!JSON.stringify(upload.value).includes(testHome));
		assert.ok(logService.errors.some(args => args.includes(failure)), 'the original failure must be logged server-side');
	});

	test('allows user-data methods only in server storage mode', () => {
		assert.strictEqual(isHucodeWebUserDataNonGetRequestAllowed('server', `${HUCODE_WEB_USER_DATA_API_PATH}/reset`), true);
		assert.strictEqual(isHucodeWebUserDataNonGetRequestAllowed('browser', `${HUCODE_WEB_USER_DATA_API_PATH}/reset`), false);
		assert.strictEqual(isHucodeWebUserDataNonGetRequestAllowed(undefined, `${HUCODE_WEB_USER_DATA_API_PATH}/reset`), false);
		assert.strictEqual(isHucodeWebUserDataNonGetRequestAllowed('server', '/unrelated'), false);
	});

	test('recovers an idle staging lease after expiry', async () => {
		let now = 0;
		await reopenServer({ now: () => now, leaseMs: 10 });
		assert.strictEqual((await invoke(server, 'POST', '/claim', {})).status, 200);

		now = 11;
		const bootstrap = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(bootstrap.status, 200);
		assert.strictEqual(bootstrap.value.state, 'uninitialized');
	});

	test('close prevents late operation admission', async () => {
		const closing = server.close();

		const rejected = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(rejected.status, 503);
		assert.match(String(rejected.value.error), /server is shutting down/);
		await closing;
	});

	test('server disposal drains admitted remote WebUser writes and rejects late ones', async () => {
		let acquiredLeases = 0;
		let activeLeases = 0;
		await reopenServer({
			acquireOperationLease: () => {
				acquiredLeases++;
				activeLeases++;
				return toDisposable(() => activeLeases--);
			},
		});
		const writeStarted = new DeferredPromise<void>();
		const releaseWrite = new DeferredPromise<void>();
		let blockWrite = true;
		let delegatedCalls = 0;
		const delegate: IServerChannel<null> = {
			async call<T>(_context: null, command: string): Promise<T> {
				delegatedCalls++;
				if (command === 'open') {
					return 7 as T;
				}
				if (command === 'writeFile' && blockWrite) {
					blockWrite = false;
					writeStarted.complete();
					await releaseWrite.p;
				}
				return undefined as T;
			},
			listen: () => Event.None,
		};
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const remote = (path: string) => URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(path).path });
		const managed = remote(join(server.webUserHome, 'User', 'settings.json')).with({ query: 'cache=1' });
		const outside = remote(join(testHome, 'outside.json'));

		await channel.call(null, 'copy', [outside, managed, {}]);
		await channel.call(null, 'rename', [managed, outside, {}]);
		const handle = await channel.call<number>(null, 'open', [managed, {}]);
		await channel.call(null, 'write', [handle, 0, VSBuffer.fromString('{}'), 0, 2]);
		await channel.call(null, 'close', [handle]);
		assert.strictEqual(acquiredLeases, 5, 'resource endpoints and open handles must recognize WebUser paths');
		assert.strictEqual(activeLeases, 0);

		const write = channel.call(null, 'writeFile', [managed, VSBuffer.fromString('{}'), {}]);
		await writeStarted.p;
		assert.strictEqual(activeLeases, 1);

		const setupDisposed = new DeferredPromise<void>();
		const setupServices = new DisposableStore();
		setupServices.add(toDisposable(() => setupDisposed.complete()));
		const serverServices = server.createServerServicesDisposal(setupServices);
		serverServices.dispose();
		assert.strictEqual(setupDisposed.isSettled, false, 'setup services must remain available while an admitted write is blocked');
		await assert.rejects(channel.call(null, 'writeFile', [managed, VSBuffer.fromString('{}'), {}]), /server is shutting down/);
		await channel.call(null, 'writeFile', [outside, VSBuffer.fromString('{}'), {}]);
		assert.strictEqual(delegatedCalls, 7, 'late non-WebUser operations remain outside Hucode admission');

		releaseWrite.complete();
		await write;
		await setupDisposed.p;
		assert.strictEqual(activeLeases, 0);
	});

	test('disconnect closes only the managed handles owned by that connection', async () => {
		const delegate = new RecordingFileSystemChannel<object>(41);
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const remote = (path: string) => URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(path).path });
		const firstContext = { remoteAuthority: 'test', clientId: 'renderer' };
		const secondContext = { remoteAuthority: 'test', clientId: 'renderer' };
		const firstHandle = await channel.call<number>(firstContext, 'open', [remote(join(server.webUserHome, 'User', 'settings.json')), {}]);
		const secondHandle = await channel.call<number>(secondContext, 'open', [remote(join(server.webUserHome, 'User', 'keybindings.json')), {}]);

		for (const command of ['read', 'write', 'close']) {
			await assert.rejects(
				channel.call(secondContext, command, [firstHandle, 0, 1]),
				error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.Unknown,
			);
		}
		await channel.releaseConnection(firstContext);

		assert.deepStrictEqual(
			delegate.calls.filter(call => call.command === 'close').map(call => ({ context: call.context, handle: (call.arg as [number])[0] })),
			[{ context: firstContext, handle: firstHandle }],
		);
		await channel.call(secondContext, 'read', [secondHandle, 0, 1]);
	});

	test('disconnect queues behind a delayed open before taking its handle snapshot', async () => {
		const openStarted = new DeferredPromise<void>();
		const releaseOpen = new DeferredPromise<void>();
		const context = { remoteAuthority: 'test', clientId: 'renderer' };
		const delegate = new RecordingFileSystemChannel<object>(51);
		delegate.handlers.set('open', async () => {
			openStarted.complete();
			await releaseOpen.p;
			return 51;
		});
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const managed = URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(join(server.webUserHome, 'User', 'settings.json')).path });

		const opening = channel.call<number>(context, 'open', [managed, {}]);
		await openStarted.p;
		const cleanup = channel.releaseConnection(context);
		releaseOpen.complete();

		assert.strictEqual(await opening, 51);
		await cleanup;
		assert.deepStrictEqual(delegate.closeHandles, [51]);
	});

	test('queued reads and writes recheck a handle claimed by close', async () => {
		const blockerStarted = new DeferredPromise<void>();
		const releaseBlocker = new DeferredPromise<void>();
		const context = { remoteAuthority: 'test', clientId: 'renderer' };
		const delegate = new RecordingFileSystemChannel<object>(61);
		delegate.handlers.set('writeFile', async () => {
			blockerStarted.complete();
			await releaseBlocker.p;
		});
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const managed = URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(join(server.webUserHome, 'User', 'settings.json')).path });
		const handle = await channel.call<number>(context, 'open', [managed, {}]);
		const blocker = channel.call(context, 'writeFile', [managed, VSBuffer.fromString('{}'), {}]);
		await blockerStarted.p;
		const close = channel.call(context, 'close', [handle]);
		const read = channel.call(context, 'read', [handle, 0, 1]);
		const write = channel.call(context, 'write', [handle, 0, VSBuffer.fromString('x'), 0, 1]);
		const cleanup = channel.releaseConnection(context);

		releaseBlocker.complete();
		await blocker;
		await close;
		await assert.rejects(read, error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.Unknown);
		await assert.rejects(write, error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.Unknown);
		await cleanup;
		assert.deepStrictEqual(delegate.calls.filter(call => call.command === 'read' || call.command === 'write'), []);
		assert.deepStrictEqual(delegate.closeHandles, [61]);
	});

	test('disconnect attempts every owned close once when one fails', async () => {
		const context = { remoteAuthority: 'test', clientId: 'renderer' };
		const delegate = new RecordingFileSystemChannel<object>(71);
		delegate.handlers.set('close', (_context, arg) => {
			if ((arg as [number])[0] === 71) {
				throw new Error('close failed');
			}
		});
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const remote = (name: string) => URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(join(server.webUserHome, 'User', name)).path });
		await channel.call(context, 'open', [remote('settings.json'), {}]);
		await channel.call(context, 'open', [remote('keybindings.json'), {}]);

		await assert.rejects(channel.releaseConnection(context), error => error instanceof AggregateError && error.errors.length === 1);
		await channel.releaseConnection(context);

		assert.deepStrictEqual(delegate.closeHandles, [71, 72]);
	});

	test('server close drains a delayed open and closes its handle without a disconnect event', async () => {
		const openStarted = new DeferredPromise<void>();
		const releaseOpen = new DeferredPromise<void>();
		const context = { remoteAuthority: 'test', clientId: 'renderer' };
		const delegate = new RecordingFileSystemChannel<object>(81);
		delegate.handlers.set('open', async () => {
			openStarted.complete();
			await releaseOpen.p;
			return 81;
		});
		const channel = server.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const managed = URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(join(server.webUserHome, 'User', 'settings.json')).path });
		const opening = channel.call<number>(context, 'open', [managed, {}]);
		await openStarted.p;
		const closing = server.close();
		releaseOpen.complete();

		assert.strictEqual(await opening, 81);
		await closing;
		await channel.releaseConnection(context);
		assert.deepStrictEqual(delegate.closeHandles, [81]);
	});

	test('browser-backed mode leaves remote filesystem handles untracked', async () => {
		const browserServer = createServer({}, 'browser');
		const context = { remoteAuthority: 'test', clientId: 'renderer' };
		const delegate = new RecordingFileSystemChannel<object>(91);
		const channel = browserServer.createFileSystemChannel(delegate, () => createURITransformer('test'));
		const resource = URI.from({ scheme: Schemas.vscodeRemote, authority: 'test', path: URI.file(join(browserServer.webUserHome, 'User', 'settings.json')).path });
		const handle = await channel.call<number>(context, 'open', [resource, {}]);

		await channel.releaseConnection(context);
		assert.deepStrictEqual(delegate.closeHandles, []);
		await channel.call(context, 'close', [handle]);
		assert.deepStrictEqual(delegate.closeHandles, [91]);
		await browserServer.close();
	});

	test('disposal initiates close admission before synchronous teardown', async () => {
		server.dispose();

		const rejected = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(rejected.status, 503);
		assert.match(String(rejected.value.error), /server is shutting down/);
		await server.close();
	});
});

class RecordingLogService extends NullLogService {
	readonly errors: unknown[][] = [];

	override error(message: string | Error, ...args: unknown[]): void {
		this.errors.push([message, ...args]);
	}
}

class RecordingFileSystemChannel<TContext> implements IServerChannel<TContext> {
	readonly calls: { context: TContext; command: string; arg: unknown }[] = [];
	readonly handlers = new Map<string, (context: TContext, arg: unknown) => unknown | Promise<unknown>>();
	private nextHandle: number;

	constructor(firstHandle: number) {
		this.nextHandle = firstHandle;
	}

	get closeHandles(): number[] {
		return this.calls.filter(call => call.command === 'close').map(call => (call.arg as [number])[0]);
	}

	async call<T>(context: TContext, command: string, arg?: unknown): Promise<T> {
		this.calls.push({ context, command, arg });
		const handler = this.handlers.get(command);
		if (handler) {
			return await handler(context, arg) as T;
		}
		if (command === 'open') {
			return this.nextHandle++ as T;
		}
		return undefined as T;
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}

async function invoke(
	server: HucodeWebUserDataServer,
	method: 'GET' | 'POST',
	operation: string,
	body?: unknown,
	contentType = 'application/json',
	responseEvents?: EventEmitter,
): Promise<{ status: number; value: Record<string, unknown> }> {
	const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as http.IncomingMessage;
	request.method = method;
	request.headers = method === 'POST' ? { 'content-type': contentType } : {};
	let status = 0;
	let responseBody = '';
	const response = Object.assign(responseEvents ?? {}, {
		writeHead(value: number) { status = value; },
		end(value?: string) { responseBody = value ?? ''; },
	}) as unknown as http.ServerResponse;

	assert.strictEqual(await server.handle(request, response, `${HUCODE_WEB_USER_DATA_API_PATH}${operation}`), true);
	return { status, value: JSON.parse(responseBody) };
}
