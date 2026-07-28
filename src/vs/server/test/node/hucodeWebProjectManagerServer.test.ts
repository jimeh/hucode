/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import {
	HUCODE_WEB_PROJECTS_API_PATH,
	HucodeNodeProjectMetadataWatcher,
	HucodeProjectStateFileSystem,
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

interface ErrorResponseBody {
	readonly error: string;
	readonly code?: string;
}

const execFile = promisify(cp.execFile);

suite('HucodeWebProjectManagerServer', function () {
	this.timeout(10_000);

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let serverDataPath: string;
	let projectPath: string;
	let servers: HucodeWebProjectManagerServer[];

	setup(async () => {
		servers = [];
		serverDataPath = await fs.mkdtemp(join(os.tmpdir(), 'hucode-projects-'));
		projectPath = join(serverDataPath, 'example');
		await createGitProject(projectPath);
		projectPath = await fs.realpath(projectPath);
	});

	teardown(async () => {
		// Settle writes before removing the temp dir. Failure-path tests assert
		// the relevant rejection directly, so cleanup only needs to join them.
		await Promise.allSettled(servers.map(server => server.flushState()));
		await fs.rm(serverDataPath, { recursive: true, force: true });
	});

	test('acknowledges an add only after its state is durable', async () => {
		const writeStarted = new DeferredPromise<void>();
		const releaseWrite = new DeferredPromise<void>();
		const fileSystem = new TestProjectStateFileSystem({
			async writeFile(path, data) {
				await writeStarted.complete();
				await releaseWrite.p;
				await fs.writeFile(path, data);
			},
		});
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			fileSystem
		);
		const addPromise = handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		await writeStarted.p;

		const responseBeforeWrite = await raceTimeout(
			addPromise.then(() => true),
			20
		);
		await releaseWrite.complete();
		assert.strictEqual(responseBeforeWrite, undefined);
		const add = await addPromise;

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

		const stored = JSON.parse(
			await fs.readFile(
				join(serverDataPath, 'hucode', 'projects.json'),
				'utf8'
			)
		) as {
			readonly projects: readonly { readonly rootPath: string }[];
		};
		assert.strictEqual(stored.projects[0].rootPath, projectPath);

		const loaded = await handle<ProjectsResponseBody>(
			createServer(serverDataPath, disposables, servers),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual(loaded.body.projects, [add.body.project]);
		assert.ok(await fs.stat(join(serverDataPath, 'hucode', 'projects.json')));
	});

	test('attributes concurrent mutation responses to their own writes', async () => {
		const secondProjectPath = join(serverDataPath, 'second');
		await createGitProject(secondProjectPath);
		const realSecondProjectPath = await fs.realpath(secondProjectPath);
		const writeStarted = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		const releaseWrite = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		let writeIndex = 0;
		const fileSystem = new TestProjectStateFileSystem({
			async writeFile(path, data) {
				const index = writeIndex++;
				await writeStarted[index].complete();
				await releaseWrite[index].p;
				await fs.writeFile(path, data);
			},
		});
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			fileSystem
		);

		const first = handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		await writeStarted[0].p;
		const second = handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: realSecondProjectPath }
		);

		const beforeFirstWrite = {
			first: await raceTimeout(first.then(() => true), 20),
			second: await raceTimeout(second.then(() => true), 20),
			secondWriteStarted: writeStarted[1].isSettled,
		};

		await releaseWrite[0].complete();
		const firstResponse = await first;
		await writeStarted[1].p;
		const firstSnapshot = JSON.parse(
			await fs.readFile(
				join(serverDataPath, 'hucode', 'projects.json'),
				'utf8'
			)
		) as { readonly projects: readonly unknown[] };
		const beforeSecondWrite = {
			firstProjectCount: firstSnapshot.projects.length,
			second: await raceTimeout(second.then(() => true), 20),
		};

		await releaseWrite[1].complete();
		const secondResponse = await second;

		assert.deepStrictEqual({
			beforeFirstWrite,
			firstStatus: firstResponse.statusCode,
			beforeSecondWrite,
			secondStatus: secondResponse.statusCode,
		}, {
			beforeFirstWrite: {
				first: undefined,
				second: undefined,
				secondWriteStarted: false,
			},
			firstStatus: 201,
			beforeSecondWrite: {
				firstProjectCount: 1,
				second: undefined,
			},
			secondStatus: 201,
		});
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
			primaryExists: await pathExists(storagePath),
		}, {
			statusCode: 200,
			projects: [],
			preservedState: '{ not json',
			primaryExists: false,
		});
	});

	test('preserves schema-invalid projects.json state before recovering', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const invalidState = '{"version":1,"projects":"not-an-array"}\n';
		await fs.mkdir(join(serverDataPath, 'hucode'), { recursive: true });
		await fs.writeFile(storagePath, invalidState);

		const loaded = await handle<ProjectsResponseBody>(
			createServer(serverDataPath, disposables, servers),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);
		const corruptPath = `${storagePath}.corrupt`;

		assert.deepStrictEqual({
			response: loaded,
			preservedState: await pathExists(corruptPath)
				? await fs.readFile(corruptPath, 'utf8')
				: undefined,
			primaryExists: await pathExists(storagePath),
		}, {
			response: { statusCode: 200, body: { projects: [] } },
			preservedState: invalidState,
			primaryExists: false,
		});
	});

	for (const code of ['EACCES', 'EBUSY', 'EMFILE']) {
		test(`keeps ${code} project state degraded until a retry loads`, async () => {
			const storagePath = join(serverDataPath, 'hucode', 'projects.json');
			const originalState = serializeStoredProjects([{
				id: 'existing',
				label: 'example',
				rootPath: projectPath,
			}]);
			await fs.mkdir(join(serverDataPath, 'hucode'), { recursive: true });
			await fs.writeFile(storagePath, originalState);
			const fileSystem = new TestProjectStateFileSystem();
			fileSystem.readError = createFileSystemError(code);
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);

			const getWhileDegraded = await handle<ErrorResponseBody>(
				server,
				'GET',
				HUCODE_WEB_PROJECTS_API_PATH
			);
			const mutateWhileDegraded = await handle<ErrorResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);

			assert.deepStrictEqual({
				getWhileDegraded,
				mutateWhileDegraded,
				primary: await fs.readFile(storagePath, 'utf8'),
				corruptExists: await pathExists(`${storagePath}.corrupt`),
				tempExists: await pathExists(`${storagePath}.tmp`),
			}, {
				getWhileDegraded: {
					statusCode: 503,
					body: {
						error: 'Project state is temporarily unavailable.',
						code: 'PROJECT_STATE_UNAVAILABLE',
					},
				},
				mutateWhileDegraded: {
					statusCode: 503,
					body: {
						error: 'Project state is temporarily unavailable.',
						code: 'PROJECT_STATE_UNAVAILABLE',
					},
				},
				primary: originalState,
				corruptExists: false,
				tempExists: false,
			});

			fileSystem.readError = undefined;
			const recovered = await handle<ProjectsResponseBody>(
				server,
				'GET',
				HUCODE_WEB_PROJECTS_API_PATH
			);

			assert.deepStrictEqual(
				recovered.body.projects.map(project => (
					project as { readonly id: string }
				).id),
				['existing']
			);
		});
	}

	test('treats missing project state as empty and then writable', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const server = createServer(serverDataPath, disposables, servers);

		const empty = await handle<ProjectsResponseBody>(
			server,
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);
		const added = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		assert.deepStrictEqual({
			empty,
			addStatus: added.statusCode,
			storedRootPath: (
				JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
					readonly projects: readonly {
						readonly rootPath: string;
					}[];
				}
			).projects[0].rootPath,
		}, {
			empty: { statusCode: 200, body: { projects: [] } },
			addStatus: 201,
			storedRootPath: projectPath,
		});
	});

	for (const failurePoint of ['writeFile', 'rename'] as const) {
		test(`recovers in-memory state after atomic ${failurePoint} fails`, async () => {
			const storagePath = join(serverDataPath, 'hucode', 'projects.json');
			const secondProjectPath = join(serverDataPath, 'second');
			await createGitProject(secondProjectPath);
			const realSecondProjectPath = await fs.realpath(secondProjectPath);
			const originalState = serializeStoredProjects([{
				id: 'existing',
				label: 'example',
				rootPath: projectPath,
			}]);
			await fs.mkdir(join(serverDataPath, 'hucode'), { recursive: true });
			await fs.writeFile(storagePath, originalState);
			const fileSystem = new TestProjectStateFileSystem();
			fileSystem[failurePoint === 'writeFile'
				? 'writeError'
				: 'renameError'] = new Error(`${failurePoint} failed`);
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);

			const failed = await handle<ErrorResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: realSecondProjectPath }
			);

			assert.deepStrictEqual({
				failed,
				primary: await fs.readFile(storagePath, 'utf8'),
				tempExists: await pathExists(`${storagePath}.tmp`),
			}, {
				failed: {
					statusCode: 500,
					body: { error: `${failurePoint} failed` },
				},
				primary: originalState,
				tempExists: false,
			});

			fileSystem.writeError = undefined;
			fileSystem.renameError = undefined;
			// Persistence failure is not a transactional rollback: the failed
			// add remains in ProjectManagerMainService memory. Repeating it
			// refreshes that project and persists the complete current snapshot.
			const retried = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: realSecondProjectPath }
			);
			const stored = JSON.parse(
				await fs.readFile(storagePath, 'utf8')
			) as { readonly projects: readonly unknown[] };
			await server.flushState();
			assert.deepStrictEqual({
				statusCode: retried.statusCode,
				projectCount: stored.projects.length,
				tempExists: await pathExists(`${storagePath}.tmp`),
			}, {
				statusCode: 201,
				projectCount: 2,
				tempExists: false,
			});
		});
	}

	test('flush waits for an in-flight write and propagates its failure', async () => {
		const writeStarted = new DeferredPromise<void>();
		const releaseWrite = new DeferredPromise<void>();
		const fileSystem = new TestProjectStateFileSystem({
			async writeFile() {
				await writeStarted.complete();
				await releaseWrite.p;
				throw new Error('gated write failed');
			},
		});
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			fileSystem
		);
		const addPromise = handle<ErrorResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		await writeStarted.p;
		const flushPromise = server.flushState();

		assert.strictEqual(
			await raceTimeout(flushPromise.then(() => true), 20),
			undefined
		);
		await releaseWrite.complete();

		assert.deepStrictEqual(await addPromise, {
			statusCode: 500,
			body: { error: 'gated write failed' },
		});
		await assert.rejects(flushPromise, /gated write failed/);
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

	test('rejects option-like worktree start points before invoking Git', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		for (const startPoint of ['--help', '-C', '  --help']) {
			const response = await handle<ErrorResponseBody>(
				server,
				'POST',
				`${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees`,
				{ options: { startPoint } }
			);
			assert.deepStrictEqual(response, {
				statusCode: 400,
				body: { error: 'Invalid options.startPoint.' },
			});
		}

		assert.strictEqual(await countGitWorktrees(projectPath), 1);
	});

	test('validates worktree option field types', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		for (const options of [
			{ startPoint: 123 },
			{ branchName: false },
			{ path: [] },
			{ detached: 'yes' },
		]) {
			const response = await handle<ErrorResponseBody>(
				server,
				'POST',
				`${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees`,
				{ options }
			);
			assert.strictEqual(response.statusCode, 400);
		}

		assert.strictEqual(await countGitWorktrees(projectPath), 1);
	});

	test('accepts HEAD and ref worktree start points', async () => {
		await execFile('git', ['branch', 'base-ref'], { cwd: projectPath });
		const server = createServer(serverDataPath, disposables, servers);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);

		const fromHead = await handle<ProjectResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/` +
			`${add.body.project.id}/worktrees`,
			{
				options: {
					branchName: 'from-head',
					startPoint: 'HEAD',
				},
			}
		);
		const fromRef = await handle<ProjectResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/` +
			`${add.body.project.id}/worktrees`,
			{
				options: {
					branchName: 'from-ref',
					startPoint: 'base-ref',
				},
			}
		);

		assert.deepStrictEqual({
			fromHead: fromHead.statusCode,
			fromRef: fromRef.statusCode,
			worktreeCount: await countGitWorktrees(projectPath),
		}, {
			fromHead: 201,
			fromRef: 201,
			worktreeCount: 3,
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
	servers: HucodeWebProjectManagerServer[],
	fileSystem?: HucodeProjectStateFileSystem
): HucodeWebProjectManagerServer {
	const server = disposables.add(new HucodeWebProjectManagerServer(
		serverDataPath,
		new NullLogService(),
		{ enabled: true, fileSystem }
	));
	servers.push(server);
	return server;
}

interface TestProjectStateFileSystemHooks {
	readonly writeFile?: (path: string, data: string) => Promise<void>;
}

class TestProjectStateFileSystem implements HucodeProjectStateFileSystem {
	readError: NodeJS.ErrnoException | undefined;
	writeError: Error | undefined;
	renameError: Error | undefined;

	constructor(
		private readonly hooks: TestProjectStateFileSystemHooks = {}
	) { }

	readFile(path: string): string {
		if (this.readError) {
			throw this.readError;
		}
		return nodeFs.readFileSync(path, 'utf8');
	}

	renameSync(source: string, target: string): void {
		nodeFs.renameSync(source, target);
	}

	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true });
	}

	async writeFile(path: string, data: string): Promise<void> {
		if (this.writeError) {
			throw this.writeError;
		}
		if (this.hooks.writeFile) {
			return this.hooks.writeFile(path, data);
		}
		await fs.writeFile(path, data);
	}

	async rename(source: string, target: string): Promise<void> {
		if (this.renameError) {
			throw this.renameError;
		}
		await fs.rename(source, target);
	}

	async remove(path: string): Promise<void> {
		await fs.rm(path, { force: true });
	}
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
	await execFile('git', [
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-m',
		'Initial commit',
	], {
		cwd: projectPath,
	});
}

async function countGitWorktrees(projectPath: string): Promise<number> {
	const result = await execFile(
		'git',
		['worktree', 'list', '--porcelain'],
		{ cwd: projectPath }
	);
	return result.stdout
		.split(/\r?\n/)
		.filter(line => line.startsWith('worktree '))
		.length;
}

function serializeStoredProjects(
	projects: readonly {
		readonly id: string;
		readonly label: string;
		readonly rootPath: string;
	}[]
): string {
	return `${JSON.stringify({
		version: 1,
		projects: projects.map((project, index) => ({
			...project,
			pinned: false,
			order: index + 1,
		})),
	}, null, '\t')}\n`;
}

function createFileSystemError(code: string): NodeJS.ErrnoException {
	const error = new Error(`read failed with ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
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
