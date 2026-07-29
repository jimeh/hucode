/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
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

	test('emits revived project updates from server-sent events', () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({ projects: [] }));
		const service = disposables.add(createService(fakeFetch));
		const events: (readonly { rootUri: URI }[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects as readonly { rootUri: URI }[])
		));

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

	test('closes project events when disposed', () => {
		const fakeFetch: WebProjectManagerFetch = async () =>
			new Response(JSON.stringify({ projects: [] }));
		const service = disposables.add(createService(fakeFetch));
		const source = FakeEventSource.instances[0];

		service.dispose();

		assert.strictEqual(source.closed, true);
	});

	function createService(fetch: WebProjectManagerFetch): WebProjectManagerClient {
		return new WebProjectManagerClient(
			'/api/projects',
			{ fetch, EventSource: FakeEventSource }
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

	closed = false;
	private readonly listeners = new Map<string, ((event: Event) => void)[]>();

	constructor(
		readonly url: string | URL,
		readonly eventSourceInitDict?: EventSourceInit
	) {
		FakeEventSource.instances.push(this);
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
