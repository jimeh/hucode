/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import type { ClientRequest } from 'http';
import * as os from 'os';
import { promisify } from 'util';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { PROJECT_MANAGER_STORAGE_KEY } from '../../../platform/projectManager/common/projectManager.js';
import {
	HUCODE_WEB_PROJECTS_API_PATH,
	HucodeNodeProjectMetadataWatcher,
	HucodeProjectFileStateService,
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
	readonly request: EventEmitter;
	readonly response: TestProjectManagerEventResponse;
	close(): void;
}

interface PendingProjectManagerEventResponse
	extends ProjectManagerEventResponse {
	readonly completion: Promise<void>;
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

	test('keeps a normal Node HTTP request live after its body completes',
		async () => {
			const http = await import('http');
			const server = createServer(serverDataPath, disposables, servers);
			const added = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					isValidBranchName(
						projectId: string,
						branchName: string,
						token: CancellationToken
					): Promise<boolean>;
				};
			}).service;
			let readTokenCanceled: boolean | undefined;
			service.isValidBranchName =
				async (_projectId, _branchName, token) => {
					readTokenCanceled = token.isCancellationRequested;
					return true;
				};
			const httpServer = http.createServer((req, res) => {
				void server.handle(
					req,
					res,
					new URL(req.url ?? '/', 'http://localhost').pathname
				).catch(error => res.destroy(error as Error));
			});
			await new Promise<void>((resolve, reject) => {
				httpServer.once('error', reject);
				httpServer.listen(0, '127.0.0.1', () => {
					httpServer.removeListener('error', reject);
					resolve();
				});
			});
			const address = httpServer.address();
			assert.ok(address && typeof address !== 'string');
			const request = requestJsonOverHttp(
				http,
				address.port,
				`${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${added.body.project.id}/worktrees/branch-name`,
				{ branchName: 'feature/normal-close' }
			);
			try {
				const response = await raceTimeout(request.completion, 1000);
				if (!response) {
					request.request.destroy();
				}

				assert.deepStrictEqual(response, {
					statusCode: 200,
					body: { valid: true },
				});
				assert.strictEqual(readTokenCanceled, false);
			} finally {
				httpServer.closeAllConnections();
				await new Promise<void>((resolve, reject) => {
					httpServer.close(error => error ? reject(error) : resolve());
				});
			}
		}
	);

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

	test('publishes project events only after the matching state write',
		async () => {
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
			const events = await handleEvents(server);
			const add = startHandle(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			await writeStarted.p;

			const eventsBeforeWrite = readProjectEvents(events.body);
			await releaseWrite.complete();
			await add.completion;

			assert.deepStrictEqual(eventsBeforeWrite, [
				{ projects: [] },
			]);
			assert.strictEqual(readProjectEvents(events.body).length, 2);
			events.close();
		}
	);

	test('waits for startup hydration state before publishing its snapshot',
		async () => {
			const storagePath = join(
				serverDataPath,
				'hucode',
				'projects.json'
			);
			await fs.mkdir(join(serverDataPath, 'hucode'), {
				recursive: true,
			});
			await fs.writeFile(storagePath, serializeStoredProjects([{
				id: 'stored-project',
				label: 'example',
				rootPath: projectPath,
			}]));
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

			const events = startEvents(server);
			await writeStarted.p;
			const responseBeforeWrite = events.response.writeHeadCalls.slice();
			await releaseWrite.complete();
			await events.completion;

			assert.deepStrictEqual(responseBeforeWrite, []);
			assert.strictEqual(events.statusCode, 200);
			const snapshots = readProjectEvents(events.body) as {
				readonly projects: readonly unknown[];
			}[];
			assert.strictEqual(snapshots.length, 1);
			assert.strictEqual(snapshots[0].projects.length, 1);
			events.close();
		}
	);

	test('waits for an already-running state write before initial events',
		async () => {
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
			const add = startHandle(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			await writeStarted.p;

			const events = startEvents(server);
			const completedBeforeWrite = await raceTimeout(
				events.completion.then(() => true),
				20
			);
			const headersBeforeWrite =
				events.response.writeHeadCalls.slice();
			await releaseWrite.complete();
			await Promise.all([add.completion, events.completion]);

			assert.strictEqual(completedBeforeWrite, undefined);
			assert.deepStrictEqual(headersBeforeWrite, []);
			assert.strictEqual(events.statusCode, 200);
			assert.strictEqual(readProjectEvents(events.body).length, 1);
			events.close();
		}
	);

	test('joins a healthy in-flight write without queuing an SSE retry',
		async () => {
			const firstWriteStarted = new DeferredPromise<void>();
			const releaseFirstWrite = new DeferredPromise<void>();
			let renameCount = 0;
			const fileSystem = new TestProjectStateFileSystem({
				async rename(source, target) {
					renameCount++;
					if (renameCount === 1) {
						await firstWriteStarted.complete();
						await releaseFirstWrite.p;
					} else {
						throw new Error('redundant SSE retry failed');
					}
					await fs.rename(source, target);
				},
			});
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);
			const add = startHandle(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			await firstWriteStarted.p;

			const events = startEvents(server);
			const headersBeforeWrite =
				events.response.writeHeadCalls.slice();
			await releaseFirstWrite.complete();
			await Promise.all([add.completion, events.completion]);

			assert.deepStrictEqual(headersBeforeWrite, []);
			assert.strictEqual(renameCount, 1);
			assert.strictEqual(events.statusCode, 200);
			assert.strictEqual(readProjectEvents(events.body).length, 1);
			events.close();
		}
	);

	test('recovers settled dirty state before admitting an event client',
		async () => {
			const retryWriteStarted = new DeferredPromise<void>();
			const releaseRetryWrite = new DeferredPromise<void>();
			let renameCount = 0;
			const fileSystem = new TestProjectStateFileSystem({
				async rename(source, target) {
					renameCount++;
					if (renameCount === 2) {
						throw new Error('settled event state write failed');
					}
					if (renameCount === 3) {
						await retryWriteStarted.complete();
						await releaseRetryWrite.p;
					} else if (renameCount > 3) {
						throw new Error('redundant event recovery write');
					}
					await fs.rename(source, target);
				},
			});
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);
			const added = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const existingEvents = await handleEvents(server);
			const failed = await handle<ErrorResponseBody>(
				server,
				'POST',
				`${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${added.body.project.id}/pinned`,
				{ pinned: true }
			);
			assert.deepStrictEqual(failed, {
				statusCode: 500,
				body: { error: 'settled event state write failed' },
			});
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const getProjects = service.getProjects.bind(service);
			let projectReads = 0;
			service.getProjects = async () => {
				projectReads++;
				return getProjects();
			};

			const firstEvents = startEvents(server);
			const secondEvents = startEvents(server);
			const retryObserved = await raceTimeout(
				retryWriteStarted.p.then(() => true),
				50
			);
			await waitFor(() => projectReads === 2);
			const headersBeforeRetry = [
				...firstEvents.response.writeHeadCalls,
				...secondEvents.response.writeHeadCalls,
			];
			await releaseRetryWrite.complete();
			await Promise.all([
				firstEvents.completion,
				secondEvents.completion,
			]);
			const stored = JSON.parse(await fs.readFile(
				join(serverDataPath, 'hucode', 'projects.json'),
				'utf8'
			)) as {
				readonly projects: readonly { readonly pinned: boolean }[];
			};

			assert.strictEqual(retryObserved, true);
			assert.deepStrictEqual(headersBeforeRetry, []);
			assert.strictEqual(renameCount, 3);
			assert.deepStrictEqual([
				firstEvents.statusCode,
				secondEvents.statusCode,
			], [200, 200]);
			assert.strictEqual(stored.projects[0].pinned, true);
			for (const events of [firstEvents, secondEvents]) {
				const snapshots = readProjectEvents(events.body) as {
					readonly projects: readonly {
						readonly pinned: boolean;
					}[];
				}[];
				assert.deepStrictEqual(snapshots.map(snapshot =>
					snapshot.projects[0].pinned
				), [true]);
			}
			assert.deepStrictEqual(readProjectEvents(existingEvents.body).map(
				snapshot => (
					snapshot as {
						readonly projects: readonly {
							readonly pinned: boolean;
						}[];
					}
				).projects[0].pinned
			), [false, true]);
			existingEvents.close();
			firstEvents.close();
			secondEvents.close();
		}
	);

	test('waits for background refresh state before publishing its snapshot',
		async () => {
			const writeStarted = new DeferredPromise<void>();
			const releaseWrite = new DeferredPromise<void>();
			let blockWrites = false;
			const fileSystem = new TestProjectStateFileSystem({
				async writeFile(path, data) {
					if (blockWrites) {
						await writeStarted.complete();
						await releaseWrite.p;
					}
					await fs.writeFile(path, data);
				},
			});
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const events = await handleEvents(server);
			const eventCountBeforeRefresh =
				readProjectEvents(events.body).length;
			const service = (server as unknown as {
				service: {
					refreshDelay: (milliseconds: number) => Promise<void>;
					runScheduledProjectRefresh(
						projectId: string
					): Promise<void>;
				};
			}).service;
			service.refreshDelay = async () => { };
			blockWrites = true;

			const refresh = service.runScheduledProjectRefresh(
				add.body.project.id
			);
			await writeStarted.p;
			const eventsBeforeWrite = readProjectEvents(events.body);
			await releaseWrite.complete();
			await refresh;
			await waitFor(() =>
				readProjectEvents(events.body).length >
				eventCountBeforeRefresh
			);

			assert.strictEqual(
				eventsBeforeWrite.length,
				eventCountBeforeRefresh
			);
			events.close();
		}
	);

	test('coalesces durable events across a failed and superseding write',
		async () => {
			const firstWriteStarted = new DeferredPromise<void>();
			const releaseFirstWrite = new DeferredPromise<void>();
			let renameCount = 0;
			const fileSystem = new TestProjectStateFileSystem({
				async rename(source, target) {
					if (++renameCount === 1) {
						await firstWriteStarted.complete();
						await releaseFirstWrite.p;
						throw new Error('first event write failed');
					}
					await fs.rename(source, target);
				},
			});
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			);
			const events = await handleEvents(server);
			const first = startHandle(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			await firstWriteStarted.p;
			const secondProjectPath = join(serverDataPath, 'second');
			await createGitProject(secondProjectPath);
			const second = startHandle(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: await fs.realpath(secondProjectPath) }
			);

			await releaseFirstWrite.complete();
			await Promise.allSettled([first.completion, second.completion]);
			await server.flushState();

			const snapshots = readProjectEvents(events.body) as {
				readonly projects: readonly unknown[];
			}[];
			assert.strictEqual(snapshots.length, 2);
			assert.strictEqual(snapshots.at(-1)!.projects.length, 2);
			events.close();
		}
	);

	test('settles a queued disconnected Git read before the active slot',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				undefined,
				1
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					getWorktreeRefs(
						projectId: string,
						options: unknown,
						token: CancellationToken
					): Promise<readonly unknown[]>;
				};
			}).service;
			const started = new DeferredPromise<CancellationToken>();
			let calls = 0;
			service.getWorktreeRefs = async (_projectId, _options, token) => {
				calls++;
				await started.complete(token);
				await new Promise<void>((_resolve, reject) => {
					const listener = token.onCancellationRequested(() => {
						listener.dispose();
						reject(new CancellationError());
					});
				});
				return [];
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees/refs`;
			const active = startHandle(server, 'POST', route, {});
			const activeToken = await started.p;
			const queued = startHandle(server, 'POST', route, {});

			queued.close();
			const queuedSettled = await raceTimeout(
				queued.completion.then(() => true),
				50
			);
			assert.strictEqual(queuedSettled, true);
			assert.strictEqual(calls, 1);
			active.close();
			await active.completion;

			assert.strictEqual(activeToken.isCancellationRequested, true);
			assert.strictEqual(calls, 1);
			assert.deepStrictEqual(active.response.writeHeadCalls, []);
			assert.deepStrictEqual(queued.response.writeHeadCalls, []);
		}
	);

	test('cancels an active Git read when a non-SSE request aborts',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					getWorktreeRefs(
						projectId: string,
						options: unknown,
						token: CancellationToken
					): Promise<readonly unknown[]>;
				};
			}).service;
			const started = new DeferredPromise<CancellationToken>();
			service.getWorktreeRefs = async (_projectId, _options, token) => {
				await started.complete(token);
				await new Promise<void>((_resolve, reject) => {
					const listener = token.onCancellationRequested(() => {
						listener.dispose();
						reject(new CancellationError());
					});
				});
				return [];
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees/refs`;
			const active = startHandle(server, 'POST', route, {});
			const token = await started.p;

			active.abortRequest();
			await active.completion;

			assert.strictEqual(token.isCancellationRequested, true);
			assert.deepStrictEqual(active.response.writeHeadCalls, []);
		}
	);

	test('rejects an already-aborted non-SSE request before Git admission',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					getWorktreeRefs(): Promise<readonly unknown[]>;
				};
			}).service;
			let calls = 0;
			service.getWorktreeRefs = async () => {
				calls++;
				return [];
			};
			const request = Object.assign(new EventEmitter(), {
				method: 'POST',
				aborted: true,
				headers: { 'content-type': 'application/json' },
				async *[Symbol.asyncIterator]() {
					yield Buffer.from('{}');
				},
			});
			const response = new TestProjectManagerEventResponse(0, 0);

			assert.strictEqual(await server.handle(
				request,
				response,
				`${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees/refs`
			), true);
			assert.strictEqual(calls, 0);
			assert.deepStrictEqual(response.writeHeadCalls, []);
		}
	);

	test('finishes an active worktree mutation after its request disconnects',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					createWorktree(
						projectId: string,
						options: {
							readonly branchName: string;
							readonly path: string;
						}
					): Promise<unknown>;
				};
			}).service;
			const originalCreate = service.createWorktree.bind(service);
			const mutationStarted = new DeferredPromise<void>();
			const releaseMutation = new DeferredPromise<void>();
			let calls = 0;
			service.createWorktree = async (projectId, options) => {
				calls++;
				await mutationStarted.complete();
				await releaseMutation.p;
				return originalCreate(projectId, options);
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees`;
			const active = startHandle(server, 'POST', route, {
				options: {
					branchName: 'active-disconnect',
					path: join(serverDataPath, 'active-disconnect'),
				},
			});
			await mutationStarted.p;
			const queued = startHandle(server, 'POST', route, {
				options: {
					branchName: 'queued-disconnect',
					path: join(serverDataPath, 'queued-disconnect'),
				},
			});
			active.close();
			queued.close();
			await releaseMutation.complete();
			await Promise.all([active.completion, queued.completion]);

			assert.strictEqual(calls, 1);
			assert.strictEqual(await countGitWorktrees(projectPath), 2);
			assert.deepStrictEqual(active.response.writeHeadCalls, []);
			assert.deepStrictEqual(queued.response.writeHeadCalls, []);
			assert.ok(
				await pathExists(join(serverDataPath, 'hucode', 'projects.json'))
			);
		}
	);

	test('caps queued Git reads and reuses a canceled waiting slot',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				undefined,
				1
			);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					getWorktreeRefs(
						projectId: string,
						options: unknown,
						token: CancellationToken
					): Promise<readonly unknown[]>;
				};
			}).service;
			const activeStarted = new DeferredPromise<void>();
			const releaseActive = new DeferredPromise<void>();
			let calls = 0;
			service.getWorktreeRefs = async (_projectId, _options, token) => {
				calls++;
				if (calls === 1) {
					await activeStarted.complete();
					await releaseActive.p;
				}
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				return [];
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/worktrees/refs`;
			const active = startHandle(server, 'POST', route, {});
			await activeStarted.p;
			const queued = Array.from({ length: 64 }, () =>
				startHandle(server, 'POST', route, {})
			);
			await waitFor(() => requestQueueSize(
				server,
				'gitReadLimiter'
			) === 65);

			const overflow = startHandle(server, 'POST', route, {});
			const overflowSettled = await raceTimeout(
				overflow.completion.then(() => true),
				50
			);
			queued[0].close();
			await queued[0].completion;
			const replacement = startHandle(server, 'POST', route, {});
			await waitFor(() => requestQueueSize(
				server,
				'gitReadLimiter'
			) >= 65);
			const replacementHeadersBeforeRelease =
				replacement.response.writeHeadCalls.slice();

			for (const pending of queued.slice(1)) {
				pending.close();
			}
			if (!overflowSettled) {
				overflow.close();
			}
			await Promise.all([
				...queued.slice(1).map(pending => pending.completion),
				overflow.completion,
			]);
			await releaseActive.complete();
			await Promise.all([active.completion, replacement.completion]);

			assert.strictEqual(overflowSettled, true);
			assert.strictEqual(overflow.response.statusCode, 503);
			assert.strictEqual(
				headersValue(overflow.response.headers, 'Retry-After'),
				'1'
			);
			assert.deepStrictEqual(JSON.parse(overflow.response.body), {
				error: 'Project request capacity reached.',
				code: 'PROJECT_REQUEST_CAPACITY',
			});
			assert.deepStrictEqual(replacementHeadersBeforeRelease, []);
			assert.strictEqual(replacement.response.statusCode, 200);
			assert.strictEqual(calls, 2);
		}
	);

	test('caps queued mutations and removes a disconnected waiting request',
		async () => {
			const server = createServer(serverDataPath, disposables, servers);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					setPinned(projectId: string, pinned: boolean): Promise<void>;
				};
			}).service;
			const activeStarted = new DeferredPromise<void>();
			const releaseActive = new DeferredPromise<void>();
			let calls = 0;
			service.setPinned = async () => {
				calls++;
				if (calls === 1) {
					await activeStarted.complete();
					await releaseActive.p;
				}
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/pinned`;
			const active = startHandle(server, 'POST', route, { pinned: true });
			await activeStarted.p;
			const queued = Array.from({ length: 64 }, (_, index) =>
				startHandle(server, 'POST', route, {
					pinned: index % 2 === 0,
				})
			);
			await waitFor(() => requestQueueSize(
				server,
				'mutationQueue'
			) === 65);

			const overflow = startHandle(
				server,
				'POST',
				route,
				{ pinned: false }
			);
			const overflowSettled = await raceTimeout(
				overflow.completion.then(() => true),
				50
			);
			queued[0].close();
			const canceledSettled = await raceTimeout(
				queued[0].completion.then(() => true),
				50
			);
			const replacement = startHandle(
				server,
				'POST',
				route,
				{ pinned: true }
			);
			await waitFor(() => requestQueueSize(
				server,
				'mutationQueue'
			) >= 65);
			const replacementHeadersBeforeRelease =
				replacement.response.writeHeadCalls.slice();

			for (const pending of queued.slice(1)) {
				pending.close();
			}
			if (!overflowSettled) {
				overflow.close();
			}
			active.close();
			await releaseActive.complete();
			await Promise.all([
				active.completion,
				...queued.map(pending => pending.completion),
				overflow.completion,
				replacement.completion,
			]);

			assert.strictEqual(overflowSettled, true);
			assert.strictEqual(overflow.response.statusCode, 503);
			assert.strictEqual(
				headersValue(overflow.response.headers, 'Retry-After'),
				'1'
			);
			assert.deepStrictEqual(JSON.parse(overflow.response.body), {
				error: 'Project request capacity reached.',
				code: 'PROJECT_REQUEST_CAPACITY',
			});
			assert.strictEqual(canceledSettled, true);
			assert.deepStrictEqual(queued[0].response.writeHeadCalls, []);
			assert.deepStrictEqual(active.response.writeHeadCalls, []);
			assert.deepStrictEqual(replacementHeadersBeforeRelease, []);
			assert.strictEqual(replacement.response.statusCode, 200);
			assert.strictEqual(calls, 2);
		}
	);

	test('settles a queued Git read when the server is disposed', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			undefined,
			1
		);
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const service = (server as unknown as {
			service: {
				getWorktreeRefs(): Promise<readonly unknown[]>;
			};
		}).service;
		const activeStarted = new DeferredPromise<void>();
		const releaseActive = new DeferredPromise<void>();
		let calls = 0;
		service.getWorktreeRefs = async () => {
			calls++;
			if (calls === 1) {
				await activeStarted.complete();
				await releaseActive.p;
			}
			return [];
		};
		const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
			`${add.body.project.id}/worktrees/refs`;
		const active = startHandle(server, 'POST', route, {});
		await activeStarted.p;
		const queued = startHandle(server, 'POST', route, {});
		await waitFor(() => requestQueueSize(server, 'gitReadLimiter') === 2);

		server.dispose();
		const queuedSettled = await raceTimeout(
			queued.completion.then(() => true),
			50
		);
		if (!queuedSettled) {
			queued.close();
		}
		await releaseActive.complete();
		await Promise.all([active.completion, queued.completion]);

		assert.strictEqual(queuedSettled, true);
		assert.strictEqual(queued.response.statusCode, 503);
		assert.strictEqual(
			headersValue(queued.response.headers, 'Retry-After'),
			'1'
		);
		assert.deepStrictEqual(JSON.parse(queued.response.body), {
			error: 'Project request queue is unavailable.',
			code: 'PROJECT_REQUEST_UNAVAILABLE',
		});
		assert.strictEqual(active.response.statusCode, 200);
		assert.strictEqual(calls, 1);
	});

	test('settles queued mutations on disposal while admitted work finishes',
		async () => {
			const server = createServer(serverDataPath, disposables, servers);
			const add = await handle<ProjectResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			const service = (server as unknown as {
				service: {
					setPinned(projectId: string, pinned: boolean): Promise<void>;
				};
			}).service;
			const activeStarted = new DeferredPromise<void>();
			const releaseActive = new DeferredPromise<void>();
			let calls = 0;
			service.setPinned = async () => {
				calls++;
				await activeStarted.complete();
				await releaseActive.p;
			};
			const route = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
				`${add.body.project.id}/pinned`;
			const active = startHandle(server, 'POST', route, { pinned: true });
			await activeStarted.p;
			const queued = startHandle(
				server,
				'POST',
				route,
				{ pinned: false }
			);
			await waitFor(() => requestQueueSize(server, 'mutationQueue') === 2);

			server.dispose();
			const queuedSettled = await raceTimeout(
				queued.completion.then(() => true),
				50
			);
			if (!queuedSettled) {
				queued.close();
			}
			await releaseActive.complete();
			await Promise.all([active.completion, queued.completion]);

			assert.strictEqual(queuedSettled, true);
			assert.strictEqual(queued.response.statusCode, 503);
			assert.strictEqual(
				headersValue(queued.response.headers, 'Retry-After'),
				'1'
			);
			assert.deepStrictEqual(JSON.parse(queued.response.body), {
				error: 'Project request queue is unavailable.',
				code: 'PROJECT_REQUEST_UNAVAILABLE',
			});
			assert.strictEqual(active.response.statusCode, 200);
			assert.strictEqual(calls, 1);
		}
	);

	test('caps event clients exactly and accepts a replacement', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			2
		);
		const first = await handleEvents(server);
		const second = await handleEvents(server);
		const rejected = await handleEvents(server);

		assert.strictEqual(first.statusCode, 200);
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(rejected.statusCode, 503);
		assert.strictEqual(
			headersValue(rejected.headers, 'Content-Type'),
			'application/json'
		);
		assert.strictEqual(
			headersValue(rejected.headers, 'Retry-After'),
			'1'
		);
		assert.deepStrictEqual(JSON.parse(rejected.body), {
			error: 'Project event stream capacity reached.',
		});
		assert.deepStrictEqual(
			rejected.response.writeHeadCalls.map(call => call.status),
			[503]
		);
		assert.notStrictEqual(
			headersValue(rejected.headers, 'Content-Type'),
			'text/event-stream'
		);

		first.close();
		const replacement = await handleEvents(server);
		assert.strictEqual(replacement.statusCode, 200);
		second.close();
		replacement.close();
	});

	test('defaults to sixty-four event clients', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const clients: ProjectManagerEventResponse[] = [];
		for (let index = 0; index < 64; index++) {
			clients.push(await handleEvents(server));
		}

		const rejected = await handleEvents(server);
		assert.strictEqual(rejected.statusCode, 503);

		for (const client of clients) {
			client.close();
		}
	});

	test('reserves event-client capacity before loading initial projects',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				1
			);
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const getProjects = service.getProjects.bind(service);
			const releaseProjects = new DeferredPromise<void>();
			let projectReads = 0;
			service.getProjects = async () => {
				projectReads++;
				await releaseProjects.p;
				return getProjects();
			};

			const firstPending = startEvents(server);
			await waitFor(() => projectReads === 1);
			assert.strictEqual(projectReads, 1);
			const rejected = await handleEvents(server);
			assert.strictEqual(rejected.statusCode, 503);
			assert.deepStrictEqual(
				rejected.response.writeHeadCalls.map(call => call.status),
				[503]
			);
			await releaseProjects.complete();
			await firstPending.completion;
			assert.strictEqual(firstPending.statusCode, 200);
			firstPending.close();
		}
	);

	test('uses a newer broadcast as the initializing client snapshot',
		async () => {
			const server = createServer(serverDataPath, disposables, servers);
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const initialProjects = new DeferredPromise<readonly unknown[]>();
			service.getProjects = () => initialProjects.p;
			const staleProjects = [{ id: 'stale' }];
			const latestProjects = [{ id: 'latest' }];

			const events = startEvents(server);
			void initialProjects.complete(staleProjects);
			(server as unknown as {
				broadcastProjects(projects: readonly unknown[]): void;
			}).broadcastProjects(latestProjects);
			await events.completion;

			assert.deepStrictEqual(readProjectEvents(events.body), [
				{ projects: latestProjects },
			]);
			events.close();
		}
	);

	test('releases initializing clients on request and response termination',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				1
			);
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const getProjects = service.getProjects.bind(service);
			const terminations: readonly ['request' | 'response', string][] = [
				['request', 'aborted'],
				['response', 'close'],
				['response', 'error'],
			];

			for (const [target, event] of terminations) {
				const releaseProjects = new DeferredPromise<void>();
				let projectReads = 0;
				service.getProjects = async () => {
					projectReads++;
					await releaseProjects.p;
					return getProjects();
				};

				const disconnected = startEvents(server);
				await waitFor(() => projectReads === 1);
				assert.strictEqual(projectReads, 1);
				if (target === 'request') {
					disconnected.request.emit(event);
				} else {
					disconnected.response.emit(event, new Error('expected'));
				}
				assert.strictEqual(disconnected.response.endCalls, 1);
				assert.strictEqual(
					disconnected.request.listenerCount('aborted'),
					0
				);
				assert.strictEqual(disconnected.response.listenerCount('close'), 0);
				assert.strictEqual(disconnected.response.listenerCount('error'), 0);

				const replacement = startEvents(server);
				await waitFor(() => projectReads === 2);
				assert.strictEqual(projectReads, 2);
				await releaseProjects.complete();
				await Promise.all([
					disconnected.completion,
					replacement.completion,
				]);

				assert.deepStrictEqual(
					disconnected.response.writeHeadCalls,
					[]
				);
				assert.strictEqual(replacement.statusCode, 200);
				replacement.close();
			}
		});

	test('does not revive initializing clients after server disposal',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				1
			);
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const getProjects = service.getProjects.bind(service);
			const releaseProjects = new DeferredPromise<void>();
			service.getProjects = async () => {
				await releaseProjects.p;
				return getProjects();
			};

			const pending = startEvents(server);
			server.dispose();
			assert.strictEqual(pending.response.endCalls, 1);
			assert.strictEqual(pending.request.listenerCount('aborted'), 0);
			assert.strictEqual(pending.response.listenerCount('close'), 0);
			assert.strictEqual(pending.response.listenerCount('error'), 0);

			await releaseProjects.complete();
			await pending.completion;
			assert.deepStrictEqual(pending.response.writeHeadCalls, []);
			assert.deepStrictEqual(readProjectEvents(pending.body), []);

			const rejected = await handleEvents(server);
			assert.strictEqual(rejected.statusCode, 503);
			assert.deepStrictEqual(
				rejected.response.writeHeadCalls.map(call => call.status),
				[503]
			);
		}
	);

	test('releases initialization capacity when initial loading fails',
		async () => {
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				undefined,
				undefined,
				1
			);
			const service = (server as unknown as {
				service: {
					getProjects(): Promise<readonly unknown[]>;
				};
			}).service;
			const getProjects = service.getProjects.bind(service);
			service.getProjects = async () => {
				throw new Error('initial load failed');
			};

			const failed = await handleEvents(server);
			assert.strictEqual(failed.statusCode, 500);
			assert.deepStrictEqual(JSON.parse(failed.body), {
				error: 'initial load failed',
			});
			assert.deepStrictEqual(
				failed.response.writeHeadCalls.map(call => call.status),
				[500]
			);

			service.getProjects = getProjects;
			const replacement = await handleEvents(server);
			assert.strictEqual(replacement.statusCode, 200);
			replacement.close();
		}
	);

	test('coalesces slow clients without delaying healthy clients', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const slow = await handleEvents(server, {
			blockProjectWrites: 1,
		});
		const healthy = await handleEvents(server);

		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		await handle<ProjectsResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/label`,
			{ label: 'first' }
		);
		const latest = await handle<ProjectsResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/label`,
			{ label: 'latest' }
		);

		assert.deepStrictEqual(readProjectEvents(slow.body), [
			{ projects: [] },
		]);
		assert.deepStrictEqual(
			readProjectEvents(healthy.body).at(-1),
			{ projects: latest.body.projects }
		);

		slow.response.emit('drain');
		assert.deepStrictEqual(readProjectEvents(slow.body), [
			{ projects: [] },
			{ projects: latest.body.projects },
		]);

		slow.close();
		healthy.close();
	});

	test('sends retry guidance and heartbeat comments', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			undefined,
			undefined,
			5
		);
		const events = await handleEvents(server);

		assert.ok(events.body.includes('retry: 1000\n\n'));
		await waitFor(() => events.body.includes(': heartbeat\n\n'));

		events.close();
	});

	test('evicts persistently backpressured event clients', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			1,
			undefined,
			5,
			15
		);
		const slow = await handleEvents(server, {
			blockProjectWrites: 1,
		});

		await waitFor(() => slow.response.endCalls === 1);
		assert.strictEqual(slow.request.listenerCount('aborted'), 0);
		assert.strictEqual(slow.response.listenerCount('drain'), 0);
		const replacement = await handleEvents(server);
		assert.strictEqual(replacement.statusCode, 200);
		replacement.close();
	});

	test('re-registers drain while replay remains backpressured', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const slow = await handleEvents(server, {
			blockProjectWrites: 2,
		});
		const add = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const first = await handle<ProjectsResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/label`,
			{ label: 'first' }
		);

		slow.response.emit('drain');
		assert.strictEqual(slow.response.listenerCount('drain'), 1);
		assert.deepStrictEqual(readProjectEvents(slow.body), [
			{ projects: [] },
			{ projects: first.body.projects },
		]);

		await handle<ProjectsResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/label`,
			{ label: 'middle' }
		);
		const latest = await handle<ProjectsResponseBody>(
			server,
			'POST',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}/label`,
			{ label: 'latest' }
		);

		slow.response.emit('drain');
		assert.strictEqual(slow.response.listenerCount('drain'), 0);
		assert.deepStrictEqual(readProjectEvents(slow.body), [
			{ projects: [] },
			{ projects: first.body.projects },
			{ projects: latest.body.projects },
		]);
		slow.close();
	});

	test('cleans up a client whose response write throws', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			1
		);
		const failed = await handleEvents(server, {
			throwProjectWrites: 1,
		});

		assert.strictEqual(failed.statusCode, 200);
		assert.strictEqual(failed.response.endCalls, 1);
		assert.strictEqual(failed.request.listenerCount('aborted'), 0);
		assert.strictEqual(failed.response.listenerCount('close'), 0);
		assert.strictEqual(failed.response.listenerCount('error'), 0);
		assert.strictEqual(failed.response.listenerCount('drain'), 0);

		const replacement = await handleEvents(server);
		assert.strictEqual(replacement.statusCode, 200);
		replacement.close();
	});

	test('cleans event clients on request and response termination', async () => {
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			undefined,
			undefined,
			1
		);
		const terminations: readonly ['request' | 'response', string][] = [
			['request', 'aborted'],
			['response', 'close'],
			['response', 'error'],
		];

		for (const [target, event] of terminations) {
			const client = await handleEvents(server, {
				blockProjectWrites: 1,
			});
			if (target === 'request') {
				client.request.emit(event);
			} else {
				client.response.emit(event, new Error('expected'));
			}

			assert.strictEqual(client.response.endCalls, 1);
			assert.strictEqual(client.request.listenerCount('aborted'), 0);
			assert.strictEqual(client.response.listenerCount('close'), 0);
			assert.strictEqual(client.response.listenerCount('error'), 0);
			assert.strictEqual(client.response.listenerCount('drain'), 0);

			const replacement = await handleEvents(server);
			assert.strictEqual(replacement.statusCode, 200);
			replacement.close();
		}
	});

	test('ends event clients and removes listeners on disposal', async () => {
		const server = createServer(serverDataPath, disposables, servers);
		const slow = await handleEvents(server, {
			blockProjectWrites: 1,
		});
		const healthy = await handleEvents(server);

		server.dispose();

		for (const client of [slow, healthy]) {
			assert.strictEqual(client.response.endCalls, 1);
			assert.strictEqual(client.request.listenerCount('aborted'), 0);
			assert.strictEqual(client.response.listenerCount('close'), 0);
			assert.strictEqual(client.response.listenerCount('error'), 0);
			assert.strictEqual(client.response.listenerCount('drain'), 0);
		}
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

	test('does not overwrite an existing corrupt-state backup', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const oldCorruptState = '{ old corrupt state';
		const newCorruptState = '{ new corrupt state';
		await fs.mkdir(join(serverDataPath, 'hucode'), { recursive: true });
		await fs.writeFile(`${storagePath}.corrupt`, oldCorruptState);
		await fs.writeFile(storagePath, newCorruptState);
		const fileSystem = new TestProjectStateFileSystem();

		const loaded = await handle<ProjectsResponseBody>(
			createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem
			),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);
		const newBackupPath = `${storagePath}.corrupt.1`;

		assert.deepStrictEqual({
			response: loaded,
			oldBackup: await fs.readFile(`${storagePath}.corrupt`, 'utf8'),
			newBackup: await pathExists(newBackupPath)
				? await fs.readFile(newBackupPath, 'utf8')
				: undefined,
			primaryExists: await pathExists(storagePath),
			existenceChecks: fileSystem.existenceChecks,
		}, {
			response: { statusCode: 200, body: { projects: [] } },
			oldBackup: oldCorruptState,
			newBackup: newCorruptState,
			primaryExists: false,
			existenceChecks: [
				`${storagePath}.corrupt`,
				`${storagePath}.corrupt.1`,
			],
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

	test('retries dirty state before an idempotent pinned mutation', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const fileSystem = new TestProjectStateFileSystem();
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			fileSystem
		);
		const added = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const events = await handleEvents(server);
		const pinnedPath = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
			`${added.body.project.id}/pinned`;
		fileSystem.renameError = new Error('pinned write failed');

		const failed = await handle<ErrorResponseBody>(
			server,
			'POST',
			pinnedPath,
			{ pinned: true }
		);
		await assert.rejects(server.flushState(), /pinned write failed/);
		await assert.rejects(server.flushState(), /pinned write failed/);
		fileSystem.renameError = undefined;

		const retried = await handle<ProjectsResponseBody>(
			server,
			'POST',
			pinnedPath,
			{ pinned: true }
		);
		await new Promise(resolve => setTimeout(resolve, 0));
		const stored = JSON.parse(
			await fs.readFile(storagePath, 'utf8')
		) as {
			readonly projects: readonly { readonly pinned: boolean }[];
		};
		const snapshots = readProjectEvents(events.body) as {
			readonly projects: readonly {
				readonly pinned: boolean;
			}[];
		}[];

		assert.deepStrictEqual({
			failed,
			retriedStatus: retried.statusCode,
			storedPinned: stored.projects[0].pinned,
			eventCount: snapshots.length,
			eventPinned: snapshots.at(-1)?.projects[0].pinned,
		}, {
			failed: {
				statusCode: 500,
				body: { error: 'pinned write failed' },
			},
			retriedStatus: 200,
			storedPinned: true,
			eventCount: 2,
			eventPinned: true,
		});
		events.close();
		await server.flushState();
		await server.flushState();
	});

	test('retries dirty deletion before idempotent route handling', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const fileSystem = new TestProjectStateFileSystem();
		const server = createServer(
			serverDataPath,
			disposables,
			servers,
			fileSystem
		);
		const added = await handle<ProjectResponseBody>(
			server,
			'POST',
			HUCODE_WEB_PROJECTS_API_PATH,
			{ rootPath: projectPath }
		);
		const deletePath = `${HUCODE_WEB_PROJECTS_API_PATH}/` +
			added.body.project.id;
		fileSystem.renameError = new Error('delete write failed');

		const failed = await handle<ErrorResponseBody>(
			server,
			'DELETE',
			deletePath
		);
		fileSystem.renameError = undefined;
		const retried = await handle<ProjectsResponseBody>(
			server,
			'DELETE',
			deletePath
		);
		const stored = JSON.parse(
			await fs.readFile(storagePath, 'utf8')
		) as { readonly projects: readonly unknown[] };

		assert.deepStrictEqual({
			failed,
			retried,
			storedProjectCount: stored.projects.length,
		}, {
			failed: {
				statusCode: 500,
				body: { error: 'delete write failed' },
			},
			retried: { statusCode: 200, body: { projects: [] } },
			storedProjectCount: 0,
		});
	});

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

	test('flushes an exact generation without inheriting a later failure',
		async () => {
			const firstWriteStarted = new DeferredPromise<void>();
			const releaseFirstWrite = new DeferredPromise<void>();
			let renameCount = 0;
			const fileSystem = new TestProjectStateFileSystem({
				async rename(source, target) {
					renameCount++;
					if (renameCount === 1) {
						await firstWriteStarted.complete();
						await releaseFirstWrite.p;
						await fs.rename(source, target);
						return;
					}
					throw new Error('later write failed');
				},
			});
			const stateService = new HucodeProjectFileStateService(
				serverDataPath,
				new NullLogService(),
				fileSystem
			);
			const firstState = JSON.parse(serializeStoredProjects([{
				id: 'first',
				label: 'first',
				rootPath: projectPath,
			}]));
			const secondState = JSON.parse(serializeStoredProjects([{
				id: 'second',
				label: 'second',
				rootPath: projectPath,
			}]));

			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, firstState);
			await firstWriteStarted.p;
			const firstGeneration = stateService.currentWriteGeneration;
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, secondState);
			const firstFlush = stateService.flushWritesThrough(firstGeneration);
			await releaseFirstWrite.complete();

			await assert.doesNotReject(firstFlush);
			await assert.doesNotReject(
				stateService.flushWritesThrough(firstGeneration)
			);
			await assert.rejects(stateService.close(), /later write failed/);
			assert.strictEqual(renameCount, 2);
		}
	);

	for (const outcome of ['success', 'failure'] as const) {
		test(`holds a server lifetime lease through write ${outcome}`, async () => {
			const writeStarted = new DeferredPromise<void>();
			const releaseWrite = new DeferredPromise<void>();
			const fileSystem = new TestProjectStateFileSystem({
				async writeFile(path, data) {
					await writeStarted.complete();
					await releaseWrite.p;
					if (outcome === 'failure') {
						throw new Error('leased write failed');
					}
					await fs.writeFile(path, data);
				},
			});
			let activeLeases = 0;
			const server = createServer(
				serverDataPath,
				disposables,
				servers,
				fileSystem,
				() => {
					activeLeases++;
					return toDisposable(() => activeLeases--);
				}
			);

			const responsePromise = handle<ProjectResponseBody | ErrorResponseBody>(
				server,
				'POST',
				HUCODE_WEB_PROJECTS_API_PATH,
				{ rootPath: projectPath }
			);
			await writeStarted.p;
			const flushPromise = server.flushState();
			const duringWrite = {
				activeLeases,
				response: await raceTimeout(
					responsePromise.then(() => true),
					20
				),
				flush: await raceTimeout(
					flushPromise.then(() => true, () => false),
					20
				),
			};
			await releaseWrite.complete();
			const response = await responsePromise;
			if (outcome === 'success') {
				await assert.doesNotReject(flushPromise);
			} else {
				await assert.rejects(flushPromise, /leased write failed/);
			}

			assert.deepStrictEqual({
				duringWrite,
				responseStatus: response.statusCode,
				activeLeases,
			}, {
				duringWrite: {
					activeLeases: 1,
					response: undefined,
					flush: undefined,
				},
				responseStatus: outcome === 'success' ? 201 : 500,
				activeLeases: 0,
			});
		});
	}

	test('a queued successful snapshot supersedes an earlier write failure', async () => {
		const storagePath = join(serverDataPath, 'hucode', 'projects.json');
		const firstWriteStarted = new DeferredPromise<void>();
		const releaseFirstWrite = new DeferredPromise<void>();
		let renameCount = 0;
		const fileSystem = new TestProjectStateFileSystem({
			async rename(source, target) {
				renameCount++;
				if (renameCount === 1) {
					await firstWriteStarted.complete();
					await releaseFirstWrite.p;
					throw new Error('first queued write failed');
				}
				await fs.rename(source, target);
			},
		});
		const stateService = new HucodeProjectFileStateService(
			serverDataPath,
			new NullLogService(),
			fileSystem
		);
		const firstState = JSON.parse(serializeStoredProjects([{
			id: 'first',
			label: 'first',
			rootPath: projectPath,
		}]));
		const secondState = JSON.parse(serializeStoredProjects([{
			id: 'second',
			label: 'second',
			rootPath: projectPath,
		}]));

		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, firstState);
		await firstWriteStarted.p;
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, secondState);
		const closePromise = stateService.close();
		await releaseFirstWrite.complete();
		await assert.doesNotReject(closePromise);
		const stored = JSON.parse(
			await fs.readFile(storagePath, 'utf8')
		) as { readonly projects: readonly { readonly id: string }[] };

		assert.deepStrictEqual({
			renameCount,
			storedIds: stored.projects.map(project => project.id),
		}, {
			renameCount: 2,
			storedIds: ['second'],
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
	fileSystem?: HucodeProjectStateFileSystem,
	acquireStateWriteLease?: () => ReturnType<typeof toDisposable>,
	eventClientLimit?: number,
	gitReadConcurrency?: number,
	eventHeartbeatIntervalMs?: number,
	eventBackpressureTimeoutMs?: number
): HucodeWebProjectManagerServer {
	const options = {
		enabled: true,
		fileSystem,
		acquireStateWriteLease,
		eventClientLimit,
		gitReadConcurrency,
		eventHeartbeatIntervalMs,
		eventBackpressureTimeoutMs,
	};
	const server = disposables.add(new HucodeWebProjectManagerServer(
		serverDataPath,
		new NullLogService(),
		options
	));
	servers.push(server);
	return server;
}

interface TestProjectStateFileSystemHooks {
	readonly writeFile?: (path: string, data: string) => Promise<void>;
	readonly rename?: (source: string, target: string) => Promise<void>;
}

class TestProjectStateFileSystem implements HucodeProjectStateFileSystem {
	readError: NodeJS.ErrnoException | undefined;
	writeError: Error | undefined;
	renameError: Error | undefined;
	readonly existenceChecks: string[] = [];

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

	exists(path: string): boolean {
		this.existenceChecks.push(path);
		return nodeFs.existsSync(path);
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
		if (this.hooks.rename) {
			return this.hooks.rename(source, target);
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
	server: HucodeWebProjectManagerServer,
	options: {
		readonly blockProjectWrites?: number;
		readonly throwProjectWrites?: number;
	} = {}
): Promise<ProjectManagerEventResponse> {
	const response = startEvents(server, options);
	await response.completion;
	return response;
}

function startEvents(
	server: HucodeWebProjectManagerServer,
	options: {
		readonly blockProjectWrites?: number;
		readonly throwProjectWrites?: number;
	} = {}
): PendingProjectManagerEventResponse {
	const req = Object.assign(new EventEmitter(), {
		method: 'GET',
		async *[Symbol.asyncIterator]() { },
	});
	const res = new TestProjectManagerEventResponse(
		options.blockProjectWrites ?? 0,
		options.throwProjectWrites ?? 0
	);
	const completion = server.handle(
		req,
		res,
		`${HUCODE_WEB_PROJECTS_API_PATH}/events`
	).then(result => {
		assert.strictEqual(result, true);
	});

	return {
		get statusCode() {
			return res.statusCode;
		},
		get headers() {
			return res.headers;
		},
		get body() {
			return res.body;
		},
		request: req,
		response: res,
		close() {
			res.emit('close');
		},
		completion,
	};
}

function startHandle(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown
): {
	readonly request: EventEmitter;
	readonly response: TestProjectManagerEventResponse;
	readonly completion: Promise<void>;
	abortRequest(): void;
	close(): void;
} {
	const request = Object.assign(new EventEmitter(), {
		method,
		headers: { 'content-type': 'application/json' },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) {
				yield Buffer.from(JSON.stringify(body));
			}
		},
	});
	const response = new TestProjectManagerEventResponse(0, 0);
	const completion = server.handle(request, response, pathname).then(result => {
		assert.strictEqual(result, true);
	});
	return {
		request,
		response,
		completion,
		abortRequest() {
			request.emit('aborted');
		},
		close() {
			response.emit('close');
		},
	};
}

function requestQueueSize(
	server: HucodeWebProjectManagerServer,
	queue: 'gitReadLimiter' | 'mutationQueue'
): number {
	return (server as unknown as Record<
		typeof queue,
		{ readonly size: number }
	>)[queue].size;
}

class TestProjectManagerEventResponse extends EventEmitter {
	statusCode = 0;
	headers: Record<string, unknown> = {};
	body = '';
	endCalls = 0;
	writableFinished = false;
	readonly writeHeadCalls: {
		readonly status: number;
		readonly headers: Record<string, unknown>;
	}[] = [];

	constructor(
		private blockProjectWrites: number,
		private throwProjectWrites: number
	) {
		super();
	}

	writeHead(
		status: number,
		nextHeaders?: Record<string, unknown>
	): void {
		if (this.writeHeadCalls.length) {
			throw new Error('writeHead must not be called more than once');
		}
		this.statusCode = status;
		this.headers = nextHeaders ?? {};
		this.writeHeadCalls.push({
			status,
			headers: this.headers,
		});
	}

	write(data: string): boolean {
		if (
			data.includes('event: projects\n') &&
			this.throwProjectWrites > 0
		) {
			this.throwProjectWrites--;
			throw new Error('response write failed');
		}
		this.body += data;
		if (
			data.includes('event: projects\n') &&
			this.blockProjectWrites > 0
		) {
			this.blockProjectWrites--;
			return false;
		}
		return true;
	}

	end(data?: string): void {
		this.endCalls++;
		this.body += data ?? '';
		this.writableFinished = true;
	}
}

function requestJsonOverHttp(
	http: typeof import('http'),
	port: number,
	pathname: string,
	body: unknown
): {
	readonly request: ClientRequest;
	readonly completion: Promise<ProjectManagerResponse>;
} {
	const serializedBody = JSON.stringify(body);
	let request: ClientRequest;
	const completion = new Promise<ProjectManagerResponse>((resolve, reject) => {
		request = http.request({
			hostname: '127.0.0.1',
			port,
			path: pathname,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(serializedBody),
			},
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.from(chunk)));
			response.on('end', () => {
				resolve({
					statusCode: response.statusCode ?? 0,
					body: JSON.parse(
						Buffer.concat(chunks).toString('utf8')
					) as unknown,
				});
			});
		});
		request.on('error', reject);
		request.end(serializedBody);
	});
	return {
		request: request!,
		completion,
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

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for test condition.');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
