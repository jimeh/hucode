/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import type * as http from 'http';
import * as url from 'url';
import { basename, join } from '../../base/common/path.js';
import { isLinux } from '../../base/common/platform.js';
import { generateUuid } from '../../base/common/uuid.js';
import {
	createStoredProjectManagerState,
	loadStoredProjectManagerState,
	projectManagerPathsEqual,
} from '../../platform/projectManager/common/projectManagerState.js';
import {
	StoredProjectManagerState,
	StoredProjectRecord,
} from '../../platform/projectManager/common/projectManager.js';

export const HUCODE_WEB_PROJECTS_API_PATH = '/_hucode/projects';

/**
 * Returns whether a request path targets the Hucode serve-web Projects API.
 */
export function isHucodeWebProjectsApiPath(pathname: string): boolean {
	return pathname === HUCODE_WEB_PROJECTS_API_PATH ||
		pathname.startsWith(`${HUCODE_WEB_PROJECTS_API_PATH}/`);
}

interface HucodeWebProjectRecord {
	readonly id: string;
	readonly label: string;
	readonly rootPath: string;
	readonly pinned: boolean;
	readonly order: number;
}

interface AddProjectRequest {
	readonly rootPath?: unknown;
	readonly folder?: unknown;
	readonly path?: unknown;
}

/**
 * File-backed project registry for the Hucode serve-web Omni shell.
 */
export class HucodeWebProjectManagerServer {

	private readonly storagePath: string;

	constructor(private readonly serverDataPath: string) {
		this.storagePath = join(serverDataPath, 'hucode', 'projects.json');
	}

	async handle(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery,
		pathname: string
	): Promise<boolean> {
		if (!isHucodeWebProjectsApiPath(pathname)) {
			return false;
		}

		try {
			if (req.method === 'GET' && pathname === HUCODE_WEB_PROJECTS_API_PATH) {
				return this.writeJson(res, 200, {
					projects: this.toClientProjects(await this.readProjects()),
				});
			}

			if (req.method === 'POST' && pathname === HUCODE_WEB_PROJECTS_API_PATH) {
				const project = await this.addProject(await this.readJson(req));
				return this.writeJson(res, 201, {
					project: this.toClientProject(project),
					projects: this.toClientProjects(await this.readProjects()),
				});
			}

			if (req.method === 'DELETE' &&
				pathname.startsWith(`${HUCODE_WEB_PROJECTS_API_PATH}/`)) {
				const id = decodeURIComponent(
					pathname.substring(HUCODE_WEB_PROJECTS_API_PATH.length + 1)
				);
				await this.removeProject(id);
				return this.writeJson(res, 200, {
					projects: this.toClientProjects(await this.readProjects()),
				});
			}

			return this.writeJson(res, 405, { error: `Unsupported method ${req.method}` });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = message === 'Missing project path.' ? 400 : 500;
			return this.writeJson(res, status, { error: message });
		}
	}

	async getProjects(): Promise<readonly HucodeWebProjectRecord[]> {
		return this.toClientProjects(await this.readProjects());
	}

	private async addProject(body: unknown): Promise<StoredProjectRecord> {
		const rootPath = normalizeProjectPath(body);
		const projects = await this.readProjects();
		const existing = projects.find(project =>
			projectManagerPathsEqual(project.rootPath, rootPath, isLinux)
		);
		if (existing) {
			return existing;
		}

		const order = projects.reduce(
			(max, project) => Math.max(max, project.order),
			0
		) + 1;
		const project: StoredProjectRecord = {
			id: generateUuid(),
			label: basename(rootPath),
			rootPath,
			pinned: false,
			order,
		};
		await this.writeProjects([...projects, project]);
		return project;
	}

	private async removeProject(id: string): Promise<void> {
		const projects = await this.readProjects();
		await this.writeProjects(projects.filter(project => project.id !== id));
	}

	private async readProjects(): Promise<StoredProjectRecord[]> {
		try {
			const raw = await fs.readFile(this.storagePath, 'utf8');
			return loadStoredProjectManagerState(
				JSON.parse(raw) as StoredProjectManagerState
			);
		} catch (error) {
			if (isNodeErrorCode(error, 'ENOENT')) {
				return [];
			}
			throw error;
		}
	}

	private async writeProjects(
		projects: readonly StoredProjectRecord[]
	): Promise<void> {
		await fs.mkdir(join(this.serverDataPath, 'hucode'), { recursive: true });
		await fs.writeFile(
			this.storagePath,
			`${JSON.stringify(createStoredProjectManagerState(projects), null, '\t')}\n`
		);
	}

	private async readJson(req: http.IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		if (!chunks.length) {
			return {};
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	}

	private toClientProjects(
		projects: readonly StoredProjectRecord[]
	): readonly HucodeWebProjectRecord[] {
		return projects
			.slice()
			.sort((a, b) => a.order - b.order)
			.map(project => this.toClientProject(project));
	}

	private toClientProject(project: StoredProjectRecord): HucodeWebProjectRecord {
		return {
			id: project.id,
			label: project.label,
			rootPath: project.rootPath,
			pinned: project.pinned,
			order: project.order,
		};
	}

	private writeJson(
		res: http.ServerResponse,
		status: number,
		body: unknown
	): true {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		});
		res.end(JSON.stringify(body));
		return true;
	}
}

function normalizeProjectPath(body: unknown): string {
	if (!body || typeof body !== 'object') {
		throw new Error('Missing project path.');
	}

	const request = body as AddProjectRequest;
	const rawPath = request.rootPath ?? request.folder ?? request.path;
	if (typeof rawPath !== 'string' || !rawPath.trim()) {
		throw new Error('Missing project path.');
	}

	return rawPath.trim();
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
