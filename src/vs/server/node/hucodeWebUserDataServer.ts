/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as http from 'http';
import { createHash } from 'crypto';
import { Queue } from '../../base/common/async.js';
import { Disposable, IDisposable } from '../../base/common/lifecycle.js';
import { join, normalize } from '../../base/common/path.js';
import { generateUuid } from '../../base/common/uuid.js';
import { SQLiteStorageDatabase } from '../../base/parts/storage/node/storage.js';
import { IEnvironmentService } from '../../platform/environment/common/environment.js';
import { IFileService } from '../../platform/files/common/files.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import type { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import type { IUserDataProfile } from '../../platform/userDataProfile/common/userDataProfile.js';
import { HucodeWebUserDataProfilesService } from './hucodeWebUserDataProfiles.js';
import { HucodeWebUserDataStorageHost, isSafeProfileId } from './hucodeWebUserDataStorage.js';

export const HUCODE_WEB_USER_DATA_API_PATH = '/_hucode/user-data';
const MANIFEST_VERSION = 1;
const LEASE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface HucodeWebUserDataManifest {
	readonly version: number;
	readonly state: 'staging' | 'ready';
	readonly generation: number;
	readonly createdAt: string;
	readonly lastMigrationAt?: string;
	readonly lease?: {
		readonly owner: string;
		readonly expiresAt: number;
	};
}

export interface HucodeWebUserDataMigration {
	readonly files: readonly { readonly path: string; readonly contents: string }[];
	readonly profiles: readonly {
		readonly id: string;
		readonly name: string;
		readonly icon?: string;
		readonly useDefaultFlags?: object;
	}[];
	readonly associations: object;
	readonly state: readonly {
		readonly id: string;
		readonly items: readonly [string, string][];
	}[];
}

export const IHucodeWebUserDataServer = createDecorator<IHucodeWebUserDataServer>('hucodeWebUserDataServer');

export interface IHucodeWebUserDataServer extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly enabled: boolean;
	readonly userHome: string;
	readonly profilesService: HucodeWebUserDataProfilesService | undefined;
	readonly storageChannel: IServerChannel<RemoteAgentConnectionContext> | undefined;
	handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean>;
	close(): Promise<void>;
}

/** Returns whether a path targets the authenticated serve-web user-data API. */
export function isHucodeWebUserDataApiPath(pathname: string): boolean {
	return pathname === HUCODE_WEB_USER_DATA_API_PATH || pathname.startsWith(`${HUCODE_WEB_USER_DATA_API_PATH}/`);
}

/**
 * Owns the authoritative WebUser manifest, migration staging, profile catalog, and state host.
 */
export class HucodeWebUserDataServer extends Disposable implements IHucodeWebUserDataServer {
	declare readonly _serviceBrand: undefined;
	readonly enabled: boolean;
	readonly webUserHome: string;
	readonly userHome: string;
	readonly stateHome: string;
	readonly profilesService: HucodeWebUserDataProfilesService | undefined;
	readonly storageChannel: IServerChannel<RemoteAgentConnectionContext> | undefined;

	private readonly manifestPath: string;
	private readonly stagingHome: string;
	private readonly operations = new Queue<unknown>();
	private readonly storageHost: HucodeWebUserDataStorageHost | undefined;
	private closing = false;
	private closePromise: Promise<void> | undefined;

	constructor(
		userDataPath: string,
		mode: 'browser' | 'server',
		environmentService: IEnvironmentService,
		fileService: IFileService,
		uriIdentityService: IUriIdentityService,
		logService: ILogService,
	) {
		super();
		this.enabled = mode === 'server';
		this.webUserHome = join(userDataPath, 'WebUser');
		this.userHome = join(this.webUserHome, 'User');
		this.stateHome = join(this.webUserHome, 'State');
		this.manifestPath = join(this.webUserHome, 'manifest.json');
		this.stagingHome = join(this.webUserHome, '.staging');

		if (this.enabled) {
			fs.mkdirSync(this.webUserHome, { recursive: true, mode: 0o700 });
			this.profilesService = this._register(new HucodeWebUserDataProfilesService(
				this.webUserHome,
				environmentService,
				fileService,
				uriIdentityService,
				logService,
			));
			this.storageHost = this._register(new HucodeWebUserDataStorageHost(
				this.stateHome,
				id => this.profilesService!.profiles.some(profile => profile.id === id),
				logService,
			));
			this.storageChannel = this.storageHost.createChannel<RemoteAgentConnectionContext>();
		}
	}

	async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
		if (!isHucodeWebUserDataApiPath(pathname)) {
			return false;
		}
		if (!this.enabled) {
			respondJson(res, 404, { error: 'Server user-data storage is disabled.' });
			return true;
		}
		if (req.method === 'POST' && !hasJsonContentType(req.headers)) {
			respondJson(res, 415, { error: 'Content-Type must be application/json.' });
			return true;
		}

		try {
			if (req.method === 'GET' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/bootstrap`) {
				await this.queueOperation(() => this.recoverExpiredLease());
				const manifest = this.readManifest();
				respondJson(res, 200, {
					state: manifest?.state ?? 'uninitialized',
					generation: manifest?.generation ?? 0,
					leaseExpiresAt: manifest?.lease?.expiresAt,
					profiles: manifest?.state === 'ready' ? this.profilesService!.profiles : undefined,
				});
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/claim`) {
				const result = await this.queueOperation(() => this.claim());
				respondJson(res, result.claimed ? 200 : 409, result);
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/upload`) {
				const body = await readJsonBody<{ owner?: unknown; generation?: unknown; migration?: HucodeWebUserDataMigration }>(req);
				await this.queueOperation(() => this.upload(body.owner, body.generation, body.migration));
				respondJson(res, 200, { uploaded: true });
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/renew`) {
				const body = await readJsonBody<{ owner?: unknown; generation?: unknown }>(req);
				const result = await this.queueOperation(() => this.renew(body.owner, body.generation));
				respondJson(res, 200, result);
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/commit`) {
				const body = await readJsonBody<{ owner?: unknown; generation?: unknown }>(req);
				const result = await this.queueOperation(() => this.commit(body.owner, body.generation));
				respondJson(res, result.committed ? 200 : 409, result);
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/initialize-empty`) {
				const result = await this.queueOperation(() => this.initializeEmpty());
				respondJson(res, result.committed ? 200 : 409, result);
				return true;
			}

			if (req.method === 'POST' && pathname === `${HUCODE_WEB_USER_DATA_API_PATH}/reset`) {
				const result = await this.queueOperation(() => this.reset());
				respondJson(res, 200, result);
				return true;
			}

			respondJson(res, 404, { error: 'Unknown serve-web user-data operation.' });
		} catch (error) {
			respondJson(res, error instanceof HucodeWebUserDataServerClosingError ? 503 : 400, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return true;
	}

	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = (async () => {
				await this.operations.whenIdle();
				await this.storageHost?.close();
			})();
		}
		await this.closePromise;
	}

	private queueOperation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) {
			return Promise.reject(new HucodeWebUserDataServerClosingError());
		}
		return this.operations.queue(operation) as Promise<T>;
	}

	private async claim(): Promise<{ claimed: boolean; owner?: string; generation: number; expiresAt?: number }> {
		await this.recoverExpiredLease();
		const current = this.readManifest();
		if (current?.state === 'ready' || current?.state === 'staging') {
			return { claimed: false, generation: current.generation, expiresAt: current.lease?.expiresAt };
		}
		const owner = generateUuid();
		const generation = (current?.generation ?? 0) + 1;
		const expiresAt = Date.now() + LEASE_MS;
		await fs.promises.mkdir(join(this.stagingHome, owner), { recursive: true, mode: 0o700 });
		await this.writeManifest({
			version: MANIFEST_VERSION,
			state: 'staging',
			generation,
			createdAt: current?.createdAt ?? new Date().toISOString(),
			lease: { owner, expiresAt },
		});
		return { claimed: true, owner, generation, expiresAt };
	}

	private async upload(owner: unknown, generation: unknown, migration: HucodeWebUserDataMigration | undefined): Promise<void> {
		const manifest = this.assertLease(owner, generation);
		if (!migration || !Array.isArray(migration.files) || !Array.isArray(migration.profiles) || !Array.isArray(migration.state)) {
			throw new Error('Invalid migration payload.');
		}
		const stage = join(this.stagingHome, manifest.lease!.owner);
		await fs.promises.rm(stage, { recursive: true, force: true });
		await fs.promises.mkdir(stage, { recursive: true, mode: 0o700 });

		for (const file of migration.files) {
			const relative = validateMigratedFilePath(file.path);
			const target = confinedJoin(join(stage, 'User'), relative);
			await fs.promises.mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
			await fs.promises.writeFile(target, Buffer.from(file.contents, 'base64'), { mode: 0o600 });
		}

		const profileIds = new Set<string>();
		for (const profile of migration.profiles) {
			if (!isSafeProfileId(profile.id) || profile.id === '__default__profile__' || profileIds.has(profile.id)) {
				throw new Error('Invalid migrated profile identifier.');
			}
			profileIds.add(profile.id);
			if (typeof profile.name !== 'string' || !profile.name) {
				throw new Error('Invalid migrated profile name.');
			}
		}
		await fs.promises.writeFile(join(stage, 'profiles.json'), JSON.stringify({
			profiles: migration.profiles,
			associations: migration.associations ?? {},
		}, undefined, 2), { mode: 0o600 });

		for (const state of migration.state) {
			const databasePath = resolveMigratedStatePath(join(stage, 'State'), state.id, profileIds);
			await fs.promises.mkdir(join(databasePath, '..'), { recursive: true, mode: 0o700 });
			const database = new SQLiteStorageDatabase(databasePath);
			try {
				const items = new Map<string, string>();
				for (const item of state.items as readonly unknown[]) {
					if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
						items.set(item[0], item[1]);
					}
				}
				await database.updateItems({ insert: items });
				if ((await database.checkIntegrity(false)).includes('(in-memory!)')) {
					throw new Error(`Unable to persist migrated state database ${state.id}.`);
				}
			} finally {
				await database.close();
			}
		}
	}

	private async renew(owner: unknown, generation: unknown): Promise<{ generation: number; expiresAt: number }> {
		const manifest = this.assertLease(owner, generation);
		const expiresAt = Date.now() + LEASE_MS;
		await this.writeManifest({ ...manifest, lease: { owner: manifest.lease!.owner, expiresAt } });
		return { generation: manifest.generation, expiresAt };
	}

	private async commit(owner: unknown, generation: unknown): Promise<{ committed: boolean; generation: number; profiles?: readonly IUserDataProfile[] }> {
		const manifest = this.readManifest();
		if (manifest?.state === 'ready') {
			return { committed: false, generation: manifest.generation, profiles: this.profilesService!.profiles };
		}
		const claimed = this.assertLease(owner, generation);
		const stage = join(this.stagingHome, claimed.lease!.owner);
		if (!fs.existsSync(join(stage, 'profiles.json'))) {
			throw new Error('Migration upload is incomplete.');
		}

		await fs.promises.rm(this.userHome, { recursive: true, force: true });
		await fs.promises.rm(this.stateHome, { recursive: true, force: true });
		await fs.promises.rm(join(this.webUserHome, 'profiles.json'), { force: true });
		await fs.promises.rename(join(stage, 'User'), this.userHome).catch(async error => {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
			await fs.promises.mkdir(this.userHome, { recursive: true, mode: 0o700 });
		});
		await fs.promises.rename(join(stage, 'State'), this.stateHome).catch(async error => {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
			await fs.promises.mkdir(this.stateHome, { recursive: true, mode: 0o700 });
		});
		await fs.promises.rename(join(stage, 'profiles.json'), join(this.webUserHome, 'profiles.json'));
		await this.writeManifest({
			version: MANIFEST_VERSION,
			state: 'ready',
			generation: claimed.generation,
			createdAt: claimed.createdAt,
			lastMigrationAt: new Date().toISOString(),
		});
		await fs.promises.rm(this.stagingHome, { recursive: true, force: true });
		this.profilesService!.reload();
		return { committed: true, generation: claimed.generation, profiles: this.profilesService!.profiles };
	}

	private async initializeEmpty(): Promise<{ committed: boolean; generation: number; profiles?: readonly IUserDataProfile[] }> {
		await this.recoverExpiredLease();
		const current = this.readManifest();
		if (current?.state === 'ready' || current?.state === 'staging') {
			return { committed: false, generation: current.generation, profiles: current.state === 'ready' ? this.profilesService!.profiles : undefined };
		}
		const claim = await this.claim();
		await this.upload(claim.owner, claim.generation, { files: [], profiles: [], associations: {}, state: [] });
		return this.commit(claim.owner, claim.generation);
	}

	private async reset(): Promise<{ reset: true; generation: number; profiles: readonly IUserDataProfile[] }> {
		const manifest = this.readManifest();
		if (manifest?.state !== 'ready') {
			throw new Error('Server user data must be initialized before it can be reset.');
		}
		await this.storageHost!.reset();
		await fs.promises.rm(this.userHome, { recursive: true, force: true });
		await fs.promises.mkdir(this.userHome, { recursive: true, mode: 0o700 });
		this.profilesService!.importCatalog({ profiles: [], associations: {} });
		const generation = manifest.generation + 1;
		await this.writeManifest({
			version: MANIFEST_VERSION,
			state: 'ready',
			generation,
			createdAt: manifest.createdAt,
			lastMigrationAt: manifest.lastMigrationAt,
		});
		return { reset: true, generation, profiles: this.profilesService!.profiles };
	}

	private assertLease(owner: unknown, generation: unknown): HucodeWebUserDataManifest {
		const manifest = this.readManifest();
		if (manifest?.state !== 'staging' || typeof owner !== 'string' || owner !== manifest.lease?.owner || generation !== manifest.generation) {
			throw new Error('Migration lease or generation does not match.');
		}
		if (manifest.lease.expiresAt <= Date.now()) {
			throw new Error('Migration lease has expired.');
		}
		return manifest;
	}

	private async recoverExpiredLease(): Promise<void> {
		const manifest = this.readManifest();
		if (manifest?.state !== 'staging' || (manifest.lease?.expiresAt ?? 0) > Date.now()) {
			return;
		}
		await fs.promises.rm(this.stagingHome, { recursive: true, force: true });
		await fs.promises.rm(this.manifestPath, { force: true });
	}

	private readManifest(): HucodeWebUserDataManifest | undefined {
		try {
			const manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as HucodeWebUserDataManifest;
			if (manifest.version !== MANIFEST_VERSION || !['staging', 'ready'].includes(manifest.state) || !Number.isSafeInteger(manifest.generation)) {
				throw new Error('Unsupported or corrupt serve-web user-data manifest.');
			}
			return manifest;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	private async writeManifest(manifest: HucodeWebUserDataManifest): Promise<void> {
		await fs.promises.mkdir(this.webUserHome, { recursive: true, mode: 0o700 });
		const temporary = `${this.manifestPath}.tmp`;
		await fs.promises.writeFile(temporary, JSON.stringify(manifest, undefined, 2), { mode: 0o600 });
		await fs.promises.rename(temporary, this.manifestPath);
	}
}

class HucodeWebUserDataServerClosingError extends Error {
	constructor() {
		super('Serve-web user-data server is shutting down.');
	}
}

function validateMigratedFilePath(path: string): string {
	if (typeof path !== 'string' || !path.startsWith('/User/')) {
		throw new Error('Migrated user-data file is outside /User.');
	}
	return path.slice('/User/'.length);
}

function confinedJoin(root: string, relative: string): string {
	const target = normalize(join(root, relative));
	const normalizedRoot = normalize(root);
	if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}/`) && !target.startsWith(`${normalizedRoot}\\`)) {
		throw new Error('User-data path escapes the server namespace.');
	}
	return target;
}

function resolveMigratedStatePath(root: string, id: string, profileIds: ReadonlySet<string>): string {
	if (id === 'global') { return join(root, 'application', 'state.vscdb'); }
	if (id === 'global-shared') { return join(root, 'application-shared', 'state.vscdb'); }
	if (id.startsWith('global-')) {
		const profileId = id.slice('global-'.length);
		if (!profileIds.has(profileId)) { throw new Error('Migration references an unknown profile.'); }
		return join(root, 'profiles', profileId, 'state.vscdb');
	}
	if (typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0')) {
		throw new Error('Invalid migrated workspace state identifier.');
	}
	const digest = createHash('sha256').update(id).digest('hex');
	return join(root, 'workspaces', digest, 'state.vscdb');
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) { throw new Error('User-data migration payload is too large.'); }
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function respondJson(res: http.ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(value));
}

function hasJsonContentType(headers: http.IncomingHttpHeaders | undefined): boolean {
	const contentType = headers?.['content-type'];
	return typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}
