/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { Queue } from '../../base/common/async.js';
import { Event } from '../../base/common/event.js';
import { IURITransformer, transformAndReviveIncomingURIs, transformOutgoingURIs } from '../../base/common/uriIpc.js';
import { join } from '../../base/common/path.js';
import { isUriComponents, URI } from '../../base/common/uri.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { IEnvironmentService } from '../../platform/environment/common/environment.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	DidChangeProfilesEvent,
	IUserDataProfile,
	StoredProfileAssociations,
	StoredUserDataProfile,
	UserDataProfilesService,
} from '../../platform/userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { isSafeProfileId } from './hucodeWebUserDataStorage.js';

export interface StoredWebProfile {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly useDefaultFlags?: StoredUserDataProfile['useDefaultFlags'];
}

export interface StoredWebProfileCatalog {
	readonly profiles: readonly StoredWebProfile[];
	readonly associations: StoredProfileAssociations;
}

/**
 * Persists the web-client profile catalog independently from remote extension-host profiles.
 *
 * The upstream `UserDataProfilesService` storage hooks are synchronous, so the
 * catalog is loaded asynchronously into memory first, like upstream's
 * electron-main `StateService`. The read hooks serve that cache, and the save
 * hooks update it synchronously and queue a serialized write of the latest
 * snapshot. Callers that trigger saves await {@link flushCatalogWrites} so a
 * failed write still rejects them. A failed write also restores the cache to
 * the catalog on disk and publishes the reverted profiles, so subscribers
 * never keep a change that was not persisted.
 */
export class HucodeWebUserDataProfilesService extends UserDataProfilesService {
	private readonly catalogPath: string;
	private catalog: StoredWebProfileCatalog | undefined;
	/** Increments whenever the cache changes, so an older load cannot overwrite it. */
	private catalogGeneration = 0;
	private catalogLoad: Promise<StoredWebProfileCatalog> | undefined;
	private catalogLoadError: Error | undefined;
	/** The catalog last read from or written to disk; failed writes revert to it. */
	private persistedCatalog: StoredWebProfileCatalog | undefined;
	private readonly catalogWrites = new Queue<void>();
	private pendingCatalogWrites: Promise<void>[] = [];

	constructor(
		webUserHome: string,
		environmentService: IEnvironmentService,
		fileService: IFileService,
		uriIdentityService: IUriIdentityService,
		logService: ILogService,
	) {
		super(
			createWebEnvironment(environmentService, join(webUserHome, 'User')),
			fileService,
			uriIdentityService,
			logService,
		);
		this.catalogPath = join(webUserHome, 'profiles.json');
	}

	/** Replaces the uninitialized catalog with a validated migration snapshot. */
	async importCatalog(catalog: StoredWebProfileCatalog): Promise<void> {
		const previous = this.profiles;
		this.setCatalog(validateWebProfileCatalog(catalog, 'migrated'));
		this.queueCatalogWrite();
		await this.flushCatalogWrites();
		this.init();
		const current = this.profiles;
		this.triggerProfilesChanges(
			current.filter(profile => !previous.some(candidate => candidate.id === profile.id)),
			previous.filter(profile => !current.some(candidate => candidate.id === profile.id)),
			current.filter(profile => previous.some(candidate => candidate.id === profile.id && candidate.name !== profile.name)),
		);
	}

	/**
	 * Reloads catalog state after a staging generation has committed. The
	 * previous catalog stays visible to synchronous readers until the new one
	 * is read and validated. A failed read clears the cache so that later
	 * callers report the failure instead of serving the replaced catalog.
	 */
	async reload(): Promise<void> {
		let catalog: StoredWebProfileCatalog;
		try {
			catalog = await this.readCatalogFile();
		} catch (error) {
			this.catalog = undefined;
			this.persistedCatalog = undefined;
			this.catalogGeneration++;
			this.catalogLoadError = error as Error;
			this.init();
			throw error;
		}
		this.setCatalog(catalog);
		this.persistedCatalog = catalog;
		this.init();
	}

	/**
	 * Loads the catalog into the cache once. Concurrent callers share one read,
	 * and a failed read is retried by the next call.
	 */
	loadCatalog(): Promise<StoredWebProfileCatalog> {
		if (this.catalog) {
			return Promise.resolve(this.catalog);
		}
		if (!this.catalogLoad) {
			const generation = this.catalogGeneration;
			const load: Promise<StoredWebProfileCatalog> = this.readCatalogFile().then(
				catalog => {
					if (this.catalogLoad === load) {
						this.catalogLoad = undefined;
					}
					if (this.catalogGeneration !== generation) {
						return this.loadCatalog();
					}
					this.setCatalog(catalog);
					this.persistedCatalog = catalog;
					this.init();
					return catalog;
				},
				error => {
					if (this.catalogLoad === load) {
						this.catalogLoad = undefined;
					}
					if (this.catalogGeneration !== generation) {
						return this.loadCatalog();
					}
					this.catalogLoadError = error;
					throw error;
				},
			);
			this.catalogLoad = load;
		}
		return this.catalogLoad;
	}

	/** Fails when the authoritative profile catalog is missing or malformed. */
	async ensureCatalogReady(): Promise<void> {
		await this.loadCatalog();
	}

	/**
	 * Returns whether an identifier belongs to the loaded catalog. This is
	 * synchronous for storage listeners and fails if no catalog is loaded.
	 */
	isKnownProfile(id: string): boolean {
		this.requireCatalog();
		return this.profiles.some(profile => profile.id === id);
	}

	/**
	 * Waits for every catalog write queued so far and rejects if one failed.
	 * After a failure the cache reverts to the catalog on disk, and the
	 * reverted profiles are published as a change.
	 */
	async flushCatalogWrites(): Promise<void> {
		const writes = this.pendingCatalogWrites;
		this.pendingCatalogWrites = [];
		const results = await Promise.allSettled(writes);
		const failure = results.find(result => result.status === 'rejected');
		if (failure) {
			this.restorePersistedCatalog();
			throw failure.reason;
		}
	}

	protected override getStoredProfiles(): StoredUserDataProfile[] {
		return this.requireCatalog().profiles.map(profile => ({
			name: profile.name,
			location: this.uriIdentityService.extUri.joinPath(this.profilesHome, profile.id),
			icon: profile.icon,
			useDefaultFlags: profile.useDefaultFlags,
		}));
	}

	protected override saveStoredProfiles(profiles: StoredUserDataProfile[]): void {
		const existing = this.requireCatalog();
		this.setCatalog(validateWebProfileCatalog({
			profiles: profiles.map(profile => {
				const id = this.uriIdentityService.extUri.basename(profile.location);
				if (!isSafeProfileId(id)) {
					throw new Error('Invalid web user-data profile identifier.');
				}
				return { id, name: profile.name, icon: profile.icon, useDefaultFlags: profile.useDefaultFlags };
			}),
			associations: existing.associations,
		}, 'stored'));
		this.queueCatalogWrite();
	}

	protected override getStoredProfileAssociations(): StoredProfileAssociations {
		return this.requireCatalog().associations;
	}

	protected override saveStoredProfileAssociations(associations: StoredProfileAssociations): void {
		const existing = this.requireCatalog();
		this.setCatalog(validateWebProfileCatalog({ profiles: existing.profiles, associations }, 'stored'));
		this.queueCatalogWrite();
	}

	private restorePersistedCatalog(): void {
		if (this.catalog === this.persistedCatalog) {
			return;
		}
		const previous = this.profiles;
		if (this.persistedCatalog) {
			this.setCatalog(this.persistedCatalog);
		} else {
			this.catalog = undefined;
			this.catalogGeneration++;
		}
		this.init();
		const current = this.profiles;
		const added = current.filter(profile => !previous.some(candidate => candidate.id === profile.id));
		const removed = previous.filter(profile => !current.some(candidate => candidate.id === profile.id));
		const updated = current.filter(profile => {
			const before = previous.find(candidate => candidate.id === profile.id);
			return !!before && !isSameStoredProfile(before, profile);
		});
		if (added.length || removed.length || updated.length) {
			this.triggerProfilesChanges(added, removed, updated);
		}
	}

	private requireCatalog(): StoredWebProfileCatalog {
		if (!this.catalog) {
			throw this.catalogLoadError ?? new Error('Serve-web profile catalog is not loaded.');
		}
		return this.catalog;
	}

	private setCatalog(catalog: StoredWebProfileCatalog): void {
		this.catalog = catalog;
		this.catalogGeneration++;
		this.catalogLoadError = undefined;
	}

	private async readCatalogFile(): Promise<StoredWebProfileCatalog> {
		let contents: string;
		try {
			contents = await fs.promises.readFile(this.catalogPath, 'utf8');
		} catch (error) {
			throw new Error(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? 'Serve-web profile catalog is missing.'
					: 'Unable to read serve-web profile catalog.',
				{ cause: error },
			);
		}
		try {
			return validateWebProfileCatalog(JSON.parse(contents), 'stored');
		} catch (error) {
			throw new Error('Serve-web profile catalog is corrupt.', { cause: error });
		}
	}

	/** Queues a write of the catalog as it is when the write starts. */
	private queueCatalogWrite(): void {
		const write = this.catalogWrites.queue(async () => {
			const catalog = this.catalog ?? { profiles: [], associations: {} };
			await this.writeCatalogFile(catalog);
			this.persistedCatalog = catalog;
		});
		// Callers observe failures through flushCatalogWrites.
		void write.catch(() => undefined);
		this.pendingCatalogWrites.push(write);
	}

	private async writeCatalogFile(catalog: StoredWebProfileCatalog): Promise<void> {
		await fs.promises.mkdir(join(this.catalogPath, '..'), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.catalogPath}.tmp`;
		await fs.promises.writeFile(temporaryPath, JSON.stringify(catalog, undefined, 2), { mode: 0o600 });
		await fs.promises.rename(temporaryPath, this.catalogPath);
	}
}

/**
 * Exposes the dedicated web profile catalog while transforming file URIs for the remote client.
 */
export class HucodeWebUserDataProfilesChannel<TContext = unknown> implements IServerChannel<TContext> {
	constructor(
		private readonly service: HucodeWebUserDataProfilesService,
		private readonly getUriTransformer: (context: TContext) => IURITransformer,
		private readonly runOperation: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation(),
	) { }

	listen<T>(context: TContext, event: string): Event<T> {
		const transformer = this.getUriTransformer(context);
		switch (event) {
			case 'onDidChangeProfiles':
				return Event.map(this.service.onDidChangeProfiles, change => transformProfileChange(change, transformer)) as Event<T>;
			case 'onDidResetWorkspaces':
				return this.service.onDidResetWorkspaces as Event<T>;
			default:
				throw new Error(`Invalid listen ${event}`);
		}
	}

	async call<T>(context: TContext, command: string, args: unknown[] = []): Promise<T> {
		return this.runOperation(async () => {
			await this.service.ensureCatalogReady();
			const transformer = this.getUriTransformer(context);
			const incoming = transformAndReviveIncomingURIs(args, transformer) as unknown[];
			let result: unknown;
			try {
				switch (command) {
					case 'createNamedProfile': result = await this.service.createNamedProfile(incoming[0] as string, incoming[1] as never, reviveWorkspaceIdentifier(incoming[2], transformer)); break;
					case 'createProfile': {
						const id = incoming[0];
						if (!isSafeProfileId(id) || this.service.profiles.some(profile => profile.id.toLowerCase() === id.toLowerCase())) {
							throw new Error('Invalid web user-data profile identifier.');
						}
						result = await this.service.createProfile(id, incoming[1] as string, incoming[2] as never, reviveWorkspaceIdentifier(incoming[3], transformer));
						break;
					}
					case 'createTransientProfile': result = await this.service.createTransientProfile(reviveWorkspaceIdentifier(incoming[0], transformer)); break;
					case 'setProfileForWorkspace': {
						const requested = incoming[1] as IUserDataProfile;
						const profile = this.service.profiles.find(candidate => candidate.id === requested.id);
						if (!profile) { throw new Error('Unknown web user-data profile.'); }
						const workspaceIdentifier = reviveWorkspaceIdentifier(incoming[0], transformer);
						if (!workspaceIdentifier) { throw new Error('Invalid web user-data workspace identifier.'); }
						result = await this.service.setProfileForWorkspace(workspaceIdentifier, profile);
						break;
					}
					case 'removeProfile': {
						const requested = incoming[0] as IUserDataProfile;
						const profile = this.service.profiles.find(candidate => candidate.id === requested.id);
						if (!profile) { throw new Error('Unknown web user-data profile.'); }
						result = await this.service.removeProfile(profile);
						break;
					}
					case 'updateProfile': {
						const requested = incoming[0] as IUserDataProfile;
						const profile = this.service.profiles.find(candidate => candidate.id === requested.id);
						if (!profile) { throw new Error('Unknown web user-data profile.'); }
						const options = incoming[1] as { name?: unknown };
						if (options.name !== undefined && (typeof options.name !== 'string' || options.name.length === 0)) {
							throw new Error('Invalid web user-data profile name.');
						}
						result = await this.service.updateProfile(profile, incoming[1] as never);
						break;
					}
					case 'resetWorkspaces': result = await this.service.resetWorkspaces(); break;
					case 'cleanUp': result = await this.service.cleanUp(); break;
					case 'cleanUpTransientProfiles': result = await this.service.cleanUpTransientProfiles(); break;
					default: throw new Error(`Invalid call ${command}`);
				}
			} catch (error) {
				// Settle saves queued before the failure so a later call does not
				// report them; the original failure is the result of this call.
				await this.service.flushCatalogWrites().catch(() => undefined);
				throw error;
			}
			// Profile changes save the catalog through synchronous upstream hooks.
			// Resolve only after those writes are durable, and reject if one failed.
			await this.service.flushCatalogWrites();
			return isProfileResultCommand(command)
				? transformProfile(result as IUserDataProfile, transformer) as T
				: transformOutgoingURIs(result, transformer) as T;
		});
	}
}

/** Validates and normalizes a persisted or migrating web profile catalog. */
export function validateWebProfileCatalog(value: unknown, source: 'stored' | 'migrated'): StoredWebProfileCatalog {
	const invalid = (subject: string): never => {
		throw new Error(source === 'migrated' ? `Invalid migrated ${subject}.` : `Invalid stored ${subject}.`);
	};
	if (!isRecord(value) || !Array.isArray(value.profiles) || !isRecord(value.associations)) {
		return invalid('profile catalog');
	}
	const ids = new Set<string>();
	const caseFoldedIds = new Set<string>();
	const profiles = value.profiles.map(profile => {
		if (!isRecord(profile) || !isSafeProfileId(profile.id) || profile.id === '__default__profile__' || ids.has(profile.id) || caseFoldedIds.has(profile.id.toLowerCase())) {
			return invalid('profile identifier');
		}
		ids.add(profile.id);
		caseFoldedIds.add(profile.id.toLowerCase());
		if (typeof profile.name !== 'string' || !profile.name) {
			return invalid('profile name');
		}
		if (profile.icon !== undefined && typeof profile.icon !== 'string') {
			return invalid('profile icon');
		}
		if (profile.useDefaultFlags !== undefined && !isBooleanRecord(profile.useDefaultFlags)) {
			return invalid('profile defaults');
		}
		return {
			id: profile.id,
			name: profile.name,
			icon: profile.icon,
			useDefaultFlags: profile.useDefaultFlags,
		};
	});
	const associations: StoredProfileAssociations = {};
	for (const key of Object.keys(value.associations)) {
		if (key !== 'workspaces' && key !== 'emptyWindows') {
			return invalid('profile associations');
		}
		const dictionary = value.associations[key];
		if (!isRecord(dictionary)) {
			return invalid('profile associations');
		}
		const normalized: Record<string, string> = {};
		for (const [association, profileId] of Object.entries(dictionary)) {
			if (!association || typeof profileId !== 'string' || (profileId !== '__default__profile__' && !ids.has(profileId))) {
				return invalid('profile associations');
			}
			normalized[association] = profileId;
		}
		associations[key] = normalized;
	}
	return { profiles, associations };
}

/** Compares the persisted fields of two profiles, including workspace associations. */
function isSameStoredProfile(a: IUserDataProfile, b: IUserDataProfile): boolean {
	const workspaces = (profile: IUserDataProfile) => (profile.workspaces ?? []).map(workspace => workspace.toString()).sort();
	return a.name === b.name &&
		a.icon === b.icon &&
		JSON.stringify(a.useDefaultFlags ?? {}) === JSON.stringify(b.useDefaultFlags ?? {}) &&
		JSON.stringify(workspaces(a)) === JSON.stringify(workspaces(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reviveWorkspaceIdentifier(value: unknown, transformer: IURITransformer) {
	if (!isRecord(value) || typeof value.id !== 'string') {
		return undefined;
	}
	if (Object.hasOwn(value, 'uri')) {
		const uri = reviveWorkspaceUri(value.uri, transformer);
		return uri ? { id: value.id, uri } : undefined;
	}
	if (Object.hasOwn(value, 'configPath')) {
		const configPath = reviveWorkspaceUri(value.configPath, transformer);
		return configPath ? { id: value.id, configPath } : undefined;
	}
	return { id: value.id };
}

function reviveWorkspaceUri(value: unknown, transformer: IURITransformer): URI | undefined {
	if (URI.isUri(value)) {
		return value;
	}
	return isUriComponents(value)
		? URI.revive(transformer.transformIncoming(value))
		: undefined;
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
	return isRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean');
}

function transformProfileChange(change: DidChangeProfilesEvent, transformer: IURITransformer): DidChangeProfilesEvent {
	return {
		all: change.all.map(profile => transformProfile(profile, transformer)),
		added: change.added.map(profile => transformProfile(profile, transformer)),
		removed: change.removed.map(profile => transformProfile(profile, transformer)),
		updated: change.updated.map(profile => transformProfile(profile, transformer)),
	};
}

function transformProfile(profile: IUserDataProfile, transformer: IURITransformer): IUserDataProfile {
	return transformOutgoingURIs({
		...profile,
		workspaces: profile.workspaces ? [...profile.workspaces] : undefined,
	}, transformer);
}

function isProfileResultCommand(command: string): boolean {
	return command === 'createNamedProfile' ||
		command === 'createProfile' ||
		command === 'createTransientProfile' ||
		command === 'updateProfile';
}

function createWebEnvironment(environmentService: IEnvironmentService, userHome: string): IEnvironmentService {
	const result = Object.create(environmentService) as IEnvironmentService;
	const home = URI.file(userHome);
	Object.defineProperties(result, {
		userRoamingDataHome: { value: home },
		cacheHome: { value: URI.file(join(userHome, 'caches')) },
		agentSessionsWorkspace: { value: URI.file(join(userHome, 'agent-sessions.code-workspace')) },
	});
	return result;
}
