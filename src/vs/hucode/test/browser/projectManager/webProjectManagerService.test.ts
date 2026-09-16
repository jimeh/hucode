/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	IWebProjectManagerEventSource,
	WebProjectManagerClient,
	WebProjectManagerFetch,
} from
	'../../../browser/projectManager/webProjectManagerService.js';

suite('WebProjectManagerService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		FakeEventSource.instances.length = 0;
		FakeEventSource.openOnConstruction = true;
	});

	test('posts add-project requests and revives project responses', async () => {
		const calls: {
			readonly input: RequestInfo | URL;
			readonly init?: RequestInit;
		}[] = [];
		const fakeFetch: WebProjectManagerFetch = async (input, init) => {
			calls.push({ input, init });
			return new Response(JSON.stringify({
				project: rawProject('/repo'),
				projects: [rawProject('/repo')],
			}), { status: 201 });
		};
		const service = disposables.add(createService(fakeFetch));
		const events: unknown[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));

		const project = await service.addProject(URI.file('/repo'));

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].input.toString(), '/api/projects');
		assert.strictEqual(calls[0].init?.method, 'POST');
		assert.strictEqual(calls[0].init?.credentials, 'include');
		assert.deepStrictEqual(
			JSON.parse(calls[0].init?.body as string),
			{ rootPath: '/repo' }
		);
		assert.strictEqual(project.rootUri.fsPath, '/repo');
		assert.strictEqual((events[0] as readonly { rootUri: URI }[])[0]
			.rootUri.fsPath, '/repo');
	});

	test('preserves worktree freshness through JSON responses', async () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({
				projects: [rawProject('/repo', 'stale')],
			}));
		const service = disposables.add(createService(fakeFetch));

		const projects = await service.getProjects();

		assert.strictEqual(projects[0].worktreeState, 'stale');
		assert.strictEqual(projects[0].rootUri.fsPath, '/repo');
	});

	test('keeps one-shot project reads and mutations stream-free', async () => {
		const fakeFetch: WebProjectManagerFetch = async (input, init) => {
			if (input.toString() === '/api/projects' && init?.method === 'POST') {
				return new Response(JSON.stringify({
					project: rawProject('/added'),
					projects: [rawProject('/added')],
				}), { status: 201 });
			}
			return new Response(JSON.stringify({
				projects: [rawProject('/repo')],
			}));
		};
		const service = disposables.add(createService(fakeFetch));

		await service.getProjects();
		await service.addProject(URI.file('/added'));
		await service.setLastActiveWorktree('project', '/repo');

		assert.strictEqual(FakeEventSource.instances.length, 0);
	});

	test('serializes bounded status preview and conditional force removal',
		async () => {
			const calls: {
				readonly input: RequestInfo | URL;
				readonly init?: RequestInit;
			}[] = [];
			const entries = Array.from({ length: 1000 }, (_, index) => ({
				indexStatus: '?',
				worktreeStatus: '?',
				path: `file-${index}.ts`,
			}));
			const fakeFetch: WebProjectManagerFetch = async (input, init) => {
				calls.push({ input, init });
				if (input.toString().endsWith('/status')) {
					return new Response(JSON.stringify({
						status: {
							fingerprint: 'all-1001',
							totalCount: 1001,
							entries,
							omittedCount: 1,
						},
					}));
				}
				return new Response(JSON.stringify({
					result: { removed: true },
					projects: [rawProject('/repo')],
				}));
			};
			const service = disposables.add(createService(fakeFetch));

			const status = await service.getWorktreeStatus(
				'project',
				'/repo.worktrees/feature'
			);
			const result = await service.removeWorktree(
				'project',
				'/repo.worktrees/feature',
				{
					force: true,
					expectedStatusFingerprint: status.fingerprint,
				}
			);

			assert.deepStrictEqual({
				totalCount: status.totalCount,
				entryCount: status.entries.length,
				omittedCount: status.omittedCount,
				lastPath: status.entries.at(-1)?.path,
			}, {
				totalCount: 1001,
				entryCount: 1000,
				omittedCount: 1,
				lastPath: 'file-999.ts',
			});
			assert.deepStrictEqual(result, { removed: true });
			assert.strictEqual(
				calls[0].input.toString(),
				'/api/projects/project/worktrees/status'
			);
			assert.deepStrictEqual(JSON.parse(calls[0].init?.body as string), {
				worktreePath: '/repo.worktrees/feature',
			});
			assert.deepStrictEqual(JSON.parse(calls[1].init?.body as string), {
				worktreePath: '/repo.worktrees/feature',
				options: {
					force: true,
					expectedStatusFingerprint: 'all-1001',
				},
			});
		}
	);

	test('uses localized fallback errors for failed requests', async () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response('not json', { status: 500 });
		const service = disposables.add(createService(fakeFetch));

		await assert.rejects(
			service.getProjects(),
			/Project manager request failed: 500/
		);
	});

	test('cancels worktree ref requests through the browser transport', async () => {
		let requestSignal: AbortSignal | undefined;
		const fakeFetch: WebProjectManagerFetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener(
					'abort',
					() => reject(requestSignal?.reason),
					{ once: true }
				);
			});
		};
		const service = disposables.add(createService(fakeFetch));
		const cancellation = disposables.add(new CancellationTokenSource());

		const refs = service.getWorktreeRefs(
			'project',
			undefined,
			cancellation.token
		);
		cancellation.cancel();

		await assert.rejects(refs, error => error instanceof CancellationError);
		assert.strictEqual(requestSignal?.aborted, true);
	});

	test('does not start an already-canceled worktree ref request', async () => {
		let fetchCalls = 0;
		const fakeFetch: WebProjectManagerFetch = async () => {
			fetchCalls++;
			return new Response(JSON.stringify({ refs: [] }));
		};
		const service = disposables.add(createService(fakeFetch));
		const cancellation = disposables.add(new CancellationTokenSource());
		cancellation.cancel();

		await assert.rejects(
			service.getWorktreeRefs(
				'project',
				undefined,
				cancellation.token
			),
			error => error instanceof CancellationError
		);
		assert.strictEqual(fetchCalls, 0);
	});

	test('reports cancellation while reading a response body', async () => {
		let requestSignal: AbortSignal | undefined;
		let bodyReadStarted!: () => void;
		const readingBody = new Promise<void>(resolve => {
			bodyReadStarted = resolve;
		});
		const fakeFetch: WebProjectManagerFetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return {
				ok: true,
				status: 200,
				json() {
					bodyReadStarted();
					return new Promise<never>((_resolve, reject) => {
						requestSignal?.addEventListener(
							'abort',
							() => reject(requestSignal?.reason),
							{ once: true }
						);
					});
				},
			} as unknown as Response;
		};
		const service = disposables.add(createService(fakeFetch));
		const cancellation = disposables.add(new CancellationTokenSource());

		const refs = service.getWorktreeRefs(
			'project',
			undefined,
			cancellation.token
		);
		await readingBody;
		cancellation.cancel();

		await assert.rejects(refs, error => error instanceof CancellationError);
		assert.strictEqual(requestSignal?.aborted, true);
	});

	test('emits revived project updates from server-sent events', () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({ projects: [] }));
		const service = disposables.add(createService(fakeFetch));
		const events: (readonly { rootUri: URI }[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects as readonly { rootUri: URI }[])
		));
		disposables.add(service.onDidChangeProjects(() => undefined));

		assert.strictEqual(FakeEventSource.instances.length, 1);
		FakeEventSource.instances[0].emit('projects', new Event('projects'));
		assert.strictEqual(events.length, 0);

		FakeEventSource.instances[0].emit(
			'projects',
			new MessageEvent('projects', {
				data: JSON.stringify({ projects: [rawProject('/repo')] }),
			})
		);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].rootUri.fsPath, '/repo');
		assert.strictEqual(
			(events[0][0] as { worktreeState?: string }).worktreeState,
			'current'
		);

		FakeEventSource.instances[0].emit(
			'projects',
			new MessageEvent('projects', {
				data: JSON.stringify({
					projects: [rawProject('/repo', 'unavailable')],
				}),
			})
		);
		assert.strictEqual(
			(events[1][0] as { worktreeState?: string }).worktreeState,
			'unavailable'
		);
	});

	test('starts exactly one project stream for Git-monitor targets', async () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({ observations: [] }));
		const service = disposables.add(createService(fakeFetch));

		await service.setGitWorktreeTargets('first', ['/repo']);
		await service.setGitWorktreeTargets('second', ['/other']);

		assert.strictEqual(FakeEventSource.instances.length, 1);
	});

	test('transports ephemeral Git-monitor targets and live updates', async () => {
		const calls: { readonly input: string; readonly body: unknown }[] = [];
		const observation = {
			targetPath: '/repo/subdirectory',
			state: 'current' as const,
			repositoryRoot: '/repo',
			worktree: {
				path: '/repo',
				label: 'main',
				branch: 'main',
				isMain: true,
				isDetached: false,
			},
		};
		const fakeFetch: WebProjectManagerFetch = async (input, init) => {
			calls.push({
				input: input.toString(),
				body: init?.body ? JSON.parse(init.body as string) : undefined,
			});
			return new Response(JSON.stringify(
				input.toString().endsWith('/targets')
					? { observations: [observation] }
					: {}
			));
		};
		const service = disposables.add(createService(fakeFetch));
		const changes: unknown[] = [];
		disposables.add(service.onDidChangeGitWorktreeTargets(change =>
			changes.push(change)
		));

		const observations = await service.setGitWorktreeTargets(
			'consumer',
			['/repo/subdirectory']
		);
		FakeEventSource.instances[0].emit(
			'git-worktrees',
			new MessageEvent('git-worktrees', {
				data: JSON.stringify({
					consumerId: 'consumer',
					observations: [observation],
				}),
			})
		);
		await service.clearGitWorktreeTargets('consumer');

		assert.deepStrictEqual({ observations, calls, changes }, {
			observations: [observation],
			calls: [{
				input: '/api/projects/git-monitor/targets',
				body: {
					sessionId: 'test-session',
					consumerId: 'consumer',
					targetPaths: ['/repo/subdirectory'],
				},
			}, {
				input: '/api/projects/git-monitor/clear',
				body: {
					sessionId: 'test-session',
					consumerId: 'consumer',
				},
			}],
			changes: [{
				consumerId: 'consumer',
				observations: [observation],
			}],
		});
	});

	test('does not clear a replacement Git-monitor registration', async () => {
		const calls: string[] = [];
		const firstResponse = new DeferredPromise<Response>();
		const firstStarted = new DeferredPromise<void>();
		const fakeFetch: WebProjectManagerFetch = async input => {
			const path = input.toString();
			calls.push(path);
			if (calls.length === 1) {
				firstStarted.complete();
				return firstResponse.p;
			}
			return new Response(JSON.stringify({ observations: [] }));
		};
		const service = disposables.add(createService(fakeFetch));

		const initial = service.setGitWorktreeTargets('consumer', ['/old']);
		await firstStarted.p;
		const clearing = service.clearGitWorktreeTargets('consumer');
		const replacement = service.setGitWorktreeTargets(
			'consumer',
			['/replacement']
		);
		await replacement;
		firstResponse.complete(new Response(JSON.stringify({ observations: [] })));
		await initial;
		await clearing;

		assert.deepStrictEqual(calls, [
			'/api/projects/git-monitor/targets',
			'/api/projects/git-monitor/targets',
		]);
	});

	test('re-registers Git targets and publishes observations on reconnect',
		async () => {
			const calls: unknown[] = [];
			const observation = {
				targetPath: '/repo/subdirectory',
				state: 'current' as const,
				repositoryRoot: '/repo',
				worktree: {
					path: '/repo',
					label: 'main',
					branch: 'main',
					isMain: true,
					isDetached: false,
				},
			};
			const fakeFetch: WebProjectManagerFetch = async (_input, init) => {
				calls.push(init?.body ? JSON.parse(init.body as string) : undefined);
				return new Response(JSON.stringify({ observations: [observation] }));
			};
			const service = disposables.add(createService(fakeFetch));
			const changes: unknown[] = [];
			const restored = new DeferredPromise<void>();
			disposables.add(service.onDidChangeGitWorktreeTargets(change => {
				changes.push(change);
				restored.complete();
			}));

			await service.setGitWorktreeTargets(
				'consumer',
				['/repo/subdirectory']
			);
			FakeEventSource.instances[0].emit('error', new Event('error'));
			FakeEventSource.instances[0].emit('open', new Event('open'));
			await restored.p;

			assert.deepStrictEqual({ calls, changes }, {
				calls: [{
					sessionId: 'test-session',
					consumerId: 'consumer',
					targetPaths: ['/repo/subdirectory'],
				}, {
					sessionId: 'test-session',
					consumerId: 'consumer',
					targetPaths: ['/repo/subdirectory'],
				}],
				changes: [{
					consumerId: 'consumer',
					observations: [observation],
				}],
			});
		}
	);

	test('does not hang target registration after permanent reconnect failure',
		async () => {
			let fetchCalls = 0;
			const fakeFetch: WebProjectManagerFetch = async () => {
				fetchCalls++;
				if (fetchCalls === 2) {
					return new Response(JSON.stringify({
						error: 'event session is disconnected',
					}), { status: 400 });
				}
				return new Response(JSON.stringify({ observations: [] }));
			};
			const service = disposables.add(createService(fakeFetch));
			const restored = new DeferredPromise<void>();
			disposables.add(service.onDidChangeGitWorktreeTargets(() => {
				void restored.complete();
			}));

			await service.setGitWorktreeTargets('consumer', ['/repo']);
			FakeEventSource.instances[0].emit('error', new Event('error'));
			const disconnectedRegistration = service.setGitWorktreeTargets(
				'consumer',
				['/repo/next']
			).then(
				() => 'resolved',
				error => `rejected: ${error}`
			);
			const result = await raceTimeout(disconnectedRegistration, 100);
			assert.match(result ?? '', /event session is disconnected/);

			FakeEventSource.instances[0].emit('open', new Event('open'));
			await restored.p;
			assert.strictEqual(fetchCalls, 3);
		});

	test('settles initial Git targets when project events fail to connect',
		async () => {
			FakeEventSource.openOnConstruction = false;
			let fetchCalls = 0;
			const restored = new DeferredPromise<void>();
			const fakeFetch: WebProjectManagerFetch = async () => {
				fetchCalls++;
				if (fetchCalls === 1) {
					return new Response(JSON.stringify({
						error: 'event session unavailable',
					}), { status: 400 });
				}
				restored.complete();
				return new Response(JSON.stringify({ observations: [] }));
			};
			const service = disposables.add(createService(fakeFetch));
			const registration = service.setGitWorktreeTargets(
				'consumer',
				['/repo']
			).then(
				() => 'resolved',
				error => `rejected: ${error}`
			);

			FakeEventSource.instances[0].emit('error', new Event('error'));
			const result = await raceTimeout(registration, 100);
			assert.match(result ?? '', /event session unavailable/);

			FakeEventSource.instances[0].emit('open', new Event('open'));
			await restored.p;
			assert.strictEqual(fetchCalls, 2);
		}
	);

	test('closes project events when disposed', () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({ projects: [] }));
		const service = disposables.add(createService(fakeFetch));
		disposables.add(service.onDidChangeProjects(() => undefined));
		const source = FakeEventSource.instances[0];

		service.dispose();

		assert.strictEqual(source.closed, true);
	});

	function createService(fetch: WebProjectManagerFetch): WebProjectManagerClient {
		return new WebProjectManagerClient(
			'/api/projects',
			{ fetch, EventSource: FakeEventSource },
			'test-session'
		);
	}
});

function rawProject(
	path: string,
	worktreeState: 'current' | 'stale' | 'unavailable' = 'current'
): object {
	return {
		id: 'project',
		label: 'Repo',
		rootUri: URI.file(path).toJSON(),
		pinned: false,
		order: 1,
		worktreeState,
		worktrees: [],
	};
}

class FakeEventSource implements IWebProjectManagerEventSource {
	static readonly instances: FakeEventSource[] = [];
	static openOnConstruction = true;

	closed = false;
	private readonly listeners = new Map<string, ((event: Event) => void)[]>();

	constructor(
		readonly url: string | URL,
		readonly eventSourceInitDict?: EventSourceInit
	) {
		FakeEventSource.instances.push(this);
		queueMicrotask(() => {
			if (!this.closed && FakeEventSource.openOnConstruction) {
				this.emit('open', new Event('open'));
			}
		});
	}

	addEventListener(type: string, listener: (event: Event) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	emit(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	close(): void {
		this.closed = true;
	}
}
