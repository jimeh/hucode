/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import type * as http from 'http';
import * as os from 'os';
import type * as url from 'url';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	HUCODE_WEB_PROJECTS_API_PATH,
	HucodeWebProjectManagerServer,
	isHucodeWebProjectsApiPath,
} from '../../node/hucodeWebProjectManagerServer.js';

suite('HucodeWebProjectManagerServer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let serverDataPath: string;

	setup(async () => {
		serverDataPath = await fs.mkdtemp(join(os.tmpdir(), 'hucode-projects-'));
	});

	teardown(async () => {
		await fs.rm(serverDataPath, { recursive: true, force: true });
	});

	test('persists projects under the server data dir', async () => {
		const server = new HucodeWebProjectManagerServer(serverDataPath);
		const add = await handle(server, 'POST', HUCODE_WEB_PROJECTS_API_PATH, {
			rootPath: '/tmp/example',
		});

		assert.strictEqual(add.statusCode, 201);
		assert.strictEqual(add.body.project.label, 'example');
		assert.strictEqual(add.body.project.rootPath, '/tmp/example');

		const loaded = await handle(
			new HucodeWebProjectManagerServer(serverDataPath),
			'GET',
			HUCODE_WEB_PROJECTS_API_PATH
		);

		assert.deepStrictEqual(loaded.body.projects, [add.body.project]);
		assert.ok(await fs.stat(join(serverDataPath, 'hucode', 'projects.json')));
	});

	test('deduplicates projects by path', async () => {
		const server = new HucodeWebProjectManagerServer(serverDataPath);
		const first = await handle(server, 'POST', HUCODE_WEB_PROJECTS_API_PATH, {
			rootPath: '/tmp/example',
		});
		const second = await handle(server, 'POST', HUCODE_WEB_PROJECTS_API_PATH, {
			rootPath: '/tmp/example',
		});

		assert.strictEqual(second.statusCode, 201);
		assert.deepStrictEqual(second.body.projects, [first.body.project]);
	});

	test('removes projects by id', async () => {
		const server = new HucodeWebProjectManagerServer(serverDataPath);
		const add = await handle(server, 'POST', HUCODE_WEB_PROJECTS_API_PATH, {
			rootPath: '/tmp/example',
		});
		const remove = await handle(
			server,
			'DELETE',
			`${HUCODE_WEB_PROJECTS_API_PATH}/${add.body.project.id}`
		);

		assert.strictEqual(remove.statusCode, 200);
		assert.deepStrictEqual(remove.body.projects, []);
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

async function handle(
	server: HucodeWebProjectManagerServer,
	method: string,
	pathname: string,
	body?: unknown
): Promise<{ readonly statusCode: number; readonly body: any }> {
	const req = {
		method,
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) {
				yield Buffer.from(JSON.stringify(body));
			}
		},
	} as unknown as http.IncomingMessage;

	let statusCode = 0;
	let rawBody = '';
	const res = {
		writeHead(status: number) {
			statusCode = status;
		},
		end(data?: string) {
			rawBody = data ?? '';
		},
	} as unknown as http.ServerResponse;

	const parsedUrl = { query: {} } as url.UrlWithParsedQuery;
	assert.strictEqual(await server.handle(req, res, parsedUrl, pathname), true);
	return { statusCode, body: JSON.parse(rawBody) };
}
