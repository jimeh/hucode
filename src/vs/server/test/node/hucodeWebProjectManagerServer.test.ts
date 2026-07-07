/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import { raceTimeout } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import {
	HUCODE_WEB_PROJECTS_API_PATH,
	HucodeNodeProjectMetadataWatcher,
	HucodeWebProjectManagerServer,
	isHucodeWebProjectsApiPath,
} from '../../node/hucodeWebProjectManagerServer.js';

interface ProjectManagerResponse<TBody = unknown> {
	readonly statusCode: number;
	readonly body: TBody;
}

interface ProjectManagerEventResponse {
	readonly statusCode: number;
	readonly headers: Record<string, unknown>;
	readonly body: string;
	close(): void;
}

interface ProjectResponseBody {
	readonly project: {
		readonly id: string;
		readonly label: string;
		readonly rootUri: { readonly path: string };
		readonly worktrees: readonly { readonly isMain: boolean }[];
	};
	readonly projects: readonly unknown[];
}

interface ProjectsResponseBody {
	readonly projects: readonly unknown[];
}

const execFile = promisify(cp.execFile);

suite('HucodeWebProjectManagerServer', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let serverDataPath: string;
	let projectPath: string;
	let servers: HucodeWebProjectManagerServer[];

	setup(async () => {
		serverDataPath = await fs.mkdtemp(join(os.tmpdir(), 'hucode-projects-'));
		projectPath = join(serverDataPath, 'example');
		await createGitProject(projectPath);
		projectPath = await fs.realpath(projectPath);
		servers = [];
	});

	teardown(async () => {
		// Project state writes are queued asynchronously; settle them before
		// removing the temp dir or cleanup races the queued write.
		await Promise.all(servers.map(server => server.flushState()));
		await fs.rm(serverDataPath, { recursive: true, force: true });
	});

	test('persists projects under the server data dir', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		assert.strictEqual(add.statusCode, 201);
		assert.deepStrictEqual({
			label: add.body.project.label,
			rootPath: add.body.project.rootUri.path,
			worktreeCount: add.body.project.worktrees.length,
			isMainWorktree: add.body.project.worktrees[0].isMain,
		}, {
			label: 'example',
			rootPath: projectPath,
			worktreeCount: 1,
			isMainWorktree: true,
		});

		await server.flushState();

		const loaded = await handle<ProjectsResponseBody>(
			createServer(serverDataPath, disposables, servers),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual(loaded.body.projects, [add.body.project]);
		assert.ok(await fs.stat(join(serverDataPath, 'hucode', 'projects.json')));
	});

	test('deduplicates projects by path', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const first = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const second = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		assert.strictEqual(second.statusCode, 201);
		assert.deepStrictEqual(second.body.projects, [first.body.project]);
	});

	test('removes projects by id', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const remove = await handle<ProjectsResponseBody>(
			server,
			'DELETE',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}`
		);

		assert.strictEqual(remove.statusCode, 200);
		assert.deepStrictEqual(remove.body.projects, []);
	});

	test('rejects nested delete routes without removing the project', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const remove = await handle<{ readonly error: string }>(
			server,
			'DELETE',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/extra`
		);
		const projects = await handle<ProjectsResponseBody>(
			server,
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual(remove, {
			statusCode: 404,
			body: { error: 'Not found.' },
		});
		assert.deepStrictEqual(projects.body.projects, [add.body.project]);
	});

	test('streams project changes to event clients', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const events = await handleEvents(server);

		assert.strictEqual(events.statusCode, 200);
		assert.strictEqual(
			headersValue(events.headers, 'Content-Type'),
			'text/event-stream'
		);
		assert.deepStrictEqual(readProjectEvents(events.body), [
			{ projects: [] },
		]);

		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		assert.deepStrictEqual(
			readProjectEvents(events.body).at(-1),
			{ projects: add.body.projects }
		);

		events.close();
	});

	test('returns bad request for malformed JSON', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const response = await handle<{ readonly error: string }>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			'{'
		);

		assert.deepStrictEqual(response, {
			statusCode: 400,
			body: { error: 'Invalid JSON request body.' },
		});
	});

	test('recovers from a malformed projects.json state file', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		await fs.mkdir(join(serverDataPath, 'hucode'), { recursive: true });
		await fs.writeFile(storagePath, '{ not json');

		const loaded = await handle<ProjectsResponseBody>(
			createServer(serverDataPath, disposables, servers),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual({
			statusCode: loaded.statusCode,
			projects: loaded.body.projects,
			preservedState: await fs.readFile(`${storagePath}.corrupt`, 'utf8'),
		}, {
			statusCode: 200,
			projects: [],
			preservedState: '{ not json',
		});
	});

	test('returns bad request for oversized JSON bodies', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const response = await handle<{ readonly error: string }>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			'x'.repeat(1024 * 1024 + 1)
		);

		assert.deepStrictEqual(response, {
			statusCode: 400,
			body: { error: 'Request body exceeds 1048576 bytes.' },
		});
	});

	test('rejects cross-origin browser requests', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const crossOrigin = await handle<{ readonly error: string }>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath },
			{
				'content-type': 'application/json',
				host: 'localhost:9888',
				origin: 'https://evil.example',
			}
		);
		const opaqueOrigin = await handle<{ readonly error: string }>(
			server,
			'DELETE',
			`${HUCODE_WEB_PROJECTS_API_PATH}/some-id`,
			undefined,
			{ host: 'localhost:9888', origin: 'null' }
		);

		assert.deepStrictEqual(crossOrigin, {
			statusCode: 403,
			body: { error: 'Cross-origin request rejected.' },
		});
		assert.deepStrictEqual(opaqueOrigin, {
			statusCode: 403,
			body: { error: 'Invalid request origin.' },
		});
	});

	test('accepts same-origin requests including forwarded hosts', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const sameOrigin = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath },
			{
				'content-type': 'application/json',
				host: 'localhost:9888',
				origin: 'http://localhost:9888',
			}
		);
		const forwarded = await handle<ProjectsResponseBody>(
			server,
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH,
			undefined,
			{
				host: 'internal:8000',
				'x-forwarded-host': 'hucode.example, proxy.internal',
				origin: 'https://hucode.example',
			}
		);

		assert.deepStrictEqual({
			sameOrigin: sameOrigin.statusCode,
			forwarded: forwarded.statusCode,
		}, {
			sameOrigin: 201,
			forwarded: 200,
		});
	});

	test('treats a default port on the forwarded host as same-origin', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const response = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath },
			{
				'content-type': 'application/json',
				host: 'internal:8000',
				'x-forwarded-host': 'hucode.example:443',
				origin: 'https://hucode.example',
			}
		);

		assert.strictEqual(response.statusCode, 201);
	});

	test('rejects mutations without a JSON content type', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const response = await handle<{ readonly error: string }>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			JSON.stringify({ rootPath: projectPath }),
			{ 'content-type': 'text/plain', host: 'localhost:9888' }
		);

		assert.deepStrictEqual(response, {
			statusCode: 415,
			body: { error: 'Content-Type must be application/json.' },
		});
	});

	test('ignores API requests when Omni web is disabled', async () => {
		const server = disposables.add(new HucodeWebProjectManagerServer(
			serverDataPath,
			new NullLogService(),
			{ enabled: false }
		));
		const req = {
			method: 'GET',
			async *[Symbol.asyncIterator]() { },
		};
		const res = {
			writeHead() {
				throw new Error('not expected to respond');
			},
			end() {
				throw new Error('not expected to respond');
			},
		};

		assert.strictEqual(
			await server.handle(req, res, HUCODE_WEB_PROJECTS_API_PATH),
			false
		);
		assert.deepStrictEqual(await server.getProjects(), []);
	});

	test('watches a metadata path created after the watch starts', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'hucode-watch-'));
		disposables.add(toDisposable(() => {
			void fs.rm(root, { recursive: true, force: true });
		}));
		const target = join(root, 'worktrees');

		const watcher = new HucodeNodeProjectMetadataWatcher(new NullLogService());
		let changed = false;
		const done = new Promise<void>(resolve => {
			disposables.add(watcher.watch(target, () => {
				changed = true;
				resolve();
			}));
		});

		await fs.mkdir(target);
		await raceTimeout(done, 3000);

		assert.strictEqual(changed, true);
	});

	test('matches project API paths', () => {
		assert.strictEqual(
			isHucodeWebProjectsApiPath(HUCODE_WEB_PROJECTS_API_PATH),
			true
		);
		assert.strictEqual(
			isHucodeWebProjectsApiPath(`${HUCODE_WEB_PROJECTS_API_PATH}/id`),
			true
		);
		assert.strictEqual(
			isHucodeWebProjectsApiPath('/_hucode/projects-old'),
			false
		);
	});
});

function createServer(
	serverDataPath: string,
	disposables: ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>,
	servers: HucodeWebProjectManagerServer[]
): HucodeWebProjectManagerServer {
	const server = disposables.add(new HucodeWebProjectManagerServer(
		serverDataPath,
		new NullLogService()
	));
	servers.push(server);
	return server;
}

async function createGitProject(projectPath: string): Promise<void> {
	await fs.mkdir(projectPath, { recursive: true });
	await execFile('git', ['init'], { cwd: projectPath });
	await execFile('git', ['config', 'user.email', 'test@example.com'], {
		cwd: projectPath,
	});
	await execFile('git', ['config', 'user.name', 'Test User'], {
		cwd: projectPath,
	});
	await fs.writeFile(join(projectPath, 'README.md'), 'test\n');
	await execFile('git', ['add', 'README.md'], { cwd: projectPath });
	await execFile('git', ['commit', '-m', 'Initial commit'], {
		cwd: projectPath,
	});
}

async function handleEvents(
	server: HucodeWebProjectManagerServer
): Promise<ProjectManagerEventResponse> {
	const req = Object.assign(new EventEmitter(), {
		method: 'GET',
		async *[Symbol.asyncIterator]() { },
	});

	let statusCode = 0;
	let headers: Record<string, unknown> = {};
	let rawBody = '';
	const res = {
		writeHead(status: number, nextHeaders?: Record<string, unknown>) {
			statusCode = status;
			headers = nextHeaders ?? {};
		},
		write(data: string) {
			rawBody += data;
		},
		end(data?: string) {
			rawBody += data ?? '';
		},
	};

	assert.strictEqual(
		await server.handle(
			req,
			res,
			`${HUCODE_WEB_PROJECTS_API_PATH}/events`
		),
		true
	);

	return {
		statusCode,
		headers,
		get body() {
			return rawBody;
		},
		close() {
			req.emit('close');
		},
	};
}

async function handle(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown,
	headers?: Record<string, string>
): Promise<ProjectManagerResponse>;
async function handle<TBody>(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown,
	headers?: Record<string, string>
): Promise<ProjectManagerResponse<TBody>>;
async function handle<TBody = unknown>(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown,
	headers?: Record<string, string>
): Promise<ProjectManagerResponse<TBody>> {
	const req = {
		method,
		headers: headers ?? { 'content-type': 'application/json' },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) {
				yield Buffer.from(
					typeof body === 'string' ? body : JSON.stringify(body)
				);
			}
		},
	};

	let statusCode = 0;
	let rawBody = '';
	const res = {
		writeHead(status: number) {
			statusCode = status;
		},
		end(data?: string) {
			rawBody = data ?? '';
		},
	};

	assert.strictEqual(await server.handle(req, res, pathname), true);
	return { statusCode, body: JSON.parse(rawBody) as TBody };
}

function headersValue(
	headers: Record<string, unknown>,
	name: string
): string | undefined {
	const entry = Object.entries(headers).find(([key]) =>
		key.toLowerCase() === name.toLowerCase()
	);
	return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function readProjectEvents(body: string): unknown[] {
	return body
		.split(/\n\n/)
		.map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
		.filter(line => !!line)
		.map(line => JSON.parse(line!.substring('data: '.length)));
}
