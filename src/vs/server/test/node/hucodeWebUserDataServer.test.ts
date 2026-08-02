/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { join } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { HUCODE_WEB_USER_DATA_API_PATH, HucodeWebUserDataServer } from '../../node/hucodeWebUserDataServer.js';
import { ServerEnvironmentService } from '../../node/serverEnvironmentService.js';

suite('HucodeWebUserDataServer', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let testHome: string;
	let fileService: FileService;
	let diskProvider: DiskFileSystemProvider;
	let server: HucodeWebUserDataServer;

	setup(async () => {
		testHome = await fs.mkdtemp(join(tmpdir(), 'hucode-web-user-data-server-'));
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		diskProvider = disposables.add(new DiskFileSystemProvider(logService));
		disposables.add(fileService.registerProvider(Schemas.file, diskProvider));
		server = disposables.add(new HucodeWebUserDataServer(
			testHome,
			'server',
			new ServerEnvironmentService({
				_: [],
				'user-data-dir': testHome,
			} as never, { _serviceBrand: undefined, ...product }),
			fileService,
			disposables.add(new UriIdentityService(fileService)),
			logService,
		));
	});

	teardown(async () => {
		await server.close();
		server.dispose();
		fileService.dispose();
		diskProvider.dispose();
		await fs.rm(testHome, { recursive: true, force: true });
	});

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

	test('close prevents late operation admission', async () => {
		const closing = server.close();

		const rejected = await invoke(server, 'GET', '/bootstrap');

		assert.strictEqual(rejected.status, 503);
		assert.match(String(rejected.value.error), /server is shutting down/);
		await closing;
	});
});

async function invoke(
	server: HucodeWebUserDataServer,
	method: 'GET' | 'POST',
	operation: string,
	body?: unknown,
	contentType = 'application/json',
): Promise<{ status: number; value: Record<string, unknown> }> {
	const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as http.IncomingMessage;
	request.method = method;
	request.headers = method === 'POST' ? { 'content-type': contentType } : {};
	let status = 0;
	let responseBody = '';
	const response = {
		writeHead(value: number) { status = value; },
		end(value?: string) { responseBody = value ?? ''; },
	} as unknown as http.ServerResponse;

	assert.strictEqual(await server.handle(request, response, `${HUCODE_WEB_USER_DATA_API_PATH}${operation}`), true);
	return { status, value: JSON.parse(responseBody) };
}
