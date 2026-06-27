/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import {
	HUCODE_WEB_PROJECTS_API_PATH,
	HucodeWebProjectManagerServer,
	isHucodeWebProjectsApiPath,
} from '../../node/hucodeWebProjectManagerServer.js';

interface ProjectManagerResponse<TBody = unknown> {
	readonly statusCode: number;
	readonly body: TBody;
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

	setup(async () => {
		serverDataPath = await fs.mkdtemp(join(os.tmpdir(), 'hucode-projects-'));
		projectPath = join(serverDataPath, 'example');
		await createGitProject(projectPath);
		projectPath = await fs.realpath(projectPath);
	});

	teardown(async () => {
		await fs.rm(serverDataPath, { recursive: true, force: true });
	});

	test('persists projects under the server data dir', async () => {
		const server = createServer(serverDataPath, disposables);
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

		const loaded = await handle<ProjectsResponseBody>(
			createServer(serverDataPath, disposables),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual(loaded.body.projects, [add.body.project]);
		assert.ok(await fs.stat(join(serverDataPath, 'hucode', 'projects.json')));
	});

	test('deduplicates projects by path', async () => {
		const server = createServer(serverDataPath, disposables);
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
		const server = createServer(serverDataPath, disposables);
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

	test('returns bad request for malformed JSON', async () => {
		const server = createServer(serverDataPath, disposables);
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
	disposables: ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>
): HucodeWebProjectManagerServer {
	return disposables.add(new HucodeWebProjectManagerServer(
		serverDataPath,
		new NullLogService()
	));
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

async function handle(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown
): Promise<ProjectManagerResponse>;
async function handle<TBody>(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown
): Promise<ProjectManagerResponse<TBody>>;
async function handle<TBody = unknown>(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown
): Promise<ProjectManagerResponse<TBody>> {
	const req = {
		method,
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
