/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { Event } from '../../base/common/event.js';
import { IURITransformer, transformIncomingURIs, transformOutgoingURIs } from '../../base/common/uriIpc.js';
import { join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
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
 */
export class HucodeWebUserDataProfilesService extends UserDataProfilesService {
	private readonly catalogPath: string;
	private catalog: StoredWebProfileCatalog | undefined;

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
	importCatalog(catalog: StoredWebProfileCatalog): void {
		const previous = this.profiles;
		this.catalog = validateWebProfileCatalog(catalog, 'migrated');
		this.writeCatalog();
		this.init();
		const current = this.profiles;
		this.triggerProfilesChanges(
			current.filter(profile => !previous.some(candidate => candidate.id === profile.id)),
			previous.filter(profile => !current.some(candidate => candidate.id === profile.id)),
			current.filter(profile => previous.some(candidate => candidate.id === profile.id && candidate.name !== profile.name)),
		);
	}

	/** Reloads catalog state after a staging generation has committed. */
	reload(): void {
		this.catalog = undefined;
		this.assertCatalogReady();
		this.init();
	}

	/** Fails when the authoritative profile catalog is missing or malformed. */
	assertCatalogReady(): void {
		this.readCatalog();
	}

	/** Returns whether an identifier belongs to the validated catalog. */
	isKnownProfile(id: string): boolean {
		this.assertCatalogReady();
		return this.profiles.some(profile => profile.id === id);
	}

	protected override getStoredProfiles(): StoredUserDataProfile[] {
		return this.readCatalog().profiles.map(profile => ({
			name: profile.name,
			location: this.uriIdentityService.extUri.joinPath(this.profilesHome, profile.id),
			icon: profile.icon,
			useDefaultFlags: profile.useDefaultFlags,
		}));
	}

	protected override saveStoredProfiles(profiles: StoredUserDataProfile[]): void {
		const existing = this.readCatalog();
		this.catalog = validateWebProfileCatalog({
			profiles: profiles.map(profile => {
				const id = this.uriIdentityService.extUri.basename(profile.location);
				if (!isSafeProfileId(id)) {
					throw new Error('Invalid web user-data profile identifier.');
				}
				return { id, name: profile.name, icon: profile.icon, useDefaultFlags: profile.useDefaultFlags };
			}),
			associations: existing.associations,
		}, 'stored');
		this.writeCatalog();
	}

	protected override getStoredProfileAssociations(): StoredProfileAssociations {
		return this.readCatalog().associations;
	}

	protected override saveStoredProfileAssociations(associations: StoredProfileAssociations): void {
		const existing = this.readCatalog();
		this.catalog = validateWebProfileCatalog({ profiles: existing.profiles, associations }, 'stored');
		this.writeCatalog();
	}

	private readCatalog(): StoredWebProfileCatalog {
		if (this.catalog) {
			return this.catalog;
		}
		let contents: string;
		try {
			contents = fs.readFileSync(this.catalogPath, 'utf8');
		} catch (error) {
			throw new Error(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? 'Serve-web profile catalog is missing.'
					: 'Unable to read serve-web profile catalog.',
				{ cause: error },
			);
		}
		try {
			this.catalog = validateWebProfileCatalog(JSON.parse(contents), 'stored');
		} catch (error) {
			throw new Error('Serve-web profile catalog is corrupt.', { cause: error });
		}
		return this.catalog;
	}

	private writeCatalog(): void {
		const catalog = this.catalog ?? { profiles: [], associations: {} };
		fs.mkdirSync(join(this.catalogPath, '..'), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.catalogPath}.tmp`;
		fs.writeFileSync(temporaryPath, JSON.stringify(catalog, undefined, 2), { mode: 0o600 });
		fs.renameSync(temporaryPath, this.catalogPath);
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
			this.service.assertCatalogReady();
			const transformer = this.getUriTransformer(context);
			const incoming = transformIncomingURIs(args, transformer) as unknown[];
			let result: unknown;
			switch (command) {
				case 'createNamedProfile': result = await this.service.createNamedProfile(incoming[0] as string, incoming[1] as never, incoming[2] as never); break;
				case 'createProfile': {
					if (!isSafeProfileId(incoming[0])) { throw new Error('Invalid web user-data profile identifier.'); }
					result = await this.service.createProfile(incoming[0], incoming[1] as string, incoming[2] as never, incoming[3] as never);
					break;
				}
				case 'createTransientProfile': result = await this.service.createTransientProfile(incoming[0] as never); break;
				case 'setProfileForWorkspace': {
					const requested = incoming[1] as IUserDataProfile;
					const profile = this.service.profiles.find(candidate => candidate.id === requested.id);
					if (!profile) { throw new Error('Unknown web user-data profile.'); }
					result = await this.service.setProfileForWorkspace(incoming[0] as never, profile);
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
			return transformOutgoingURIs(result, transformer) as T;
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
	const profiles = value.profiles.map(profile => {
		if (!isRecord(profile) || !isSafeProfileId(profile.id) || profile.id === '__default__profile__' || ids.has(profile.id)) {
			return invalid('profile identifier');
		}
		ids.add(profile.id);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
	return isRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean');
}

function transformProfileChange(change: DidChangeProfilesEvent, transformer: IURITransformer): DidChangeProfilesEvent {
	return {
		all: change.all.map(profile => transformOutgoingURIs({ ...profile }, transformer)),
		added: change.added.map(profile => transformOutgoingURIs({ ...profile }, transformer)),
		removed: change.removed.map(profile => transformOutgoingURIs({ ...profile }, transformer)),
		updated: change.updated.map(profile => transformOutgoingURIs({ ...profile }, transformer)),
	};
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
