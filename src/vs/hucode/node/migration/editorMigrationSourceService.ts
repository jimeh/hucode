/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { homedir } from 'os';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { parse } from '../../../base/common/jsonc.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { posix, win32 } from '../../../base/common/path.js';
import { basename, dirname, joinPath } from '../../../base/common/resources.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import {
	EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
	EditorMigrationAdapterId,
	EditorMigrationCategory,
	EditorMigrationCategorySnapshot,
	EditorMigrationCategorySummary,
	EditorMigrationDiagnostic,
	EditorMigrationDiscoveryOptions,
	EditorMigrationDiscoveryResult,
	EditorMigrationExtension,
	EditorMigrationJsonValue,
	EditorMigrationResourceState,
	EditorMigrationSnippet,
	EditorMigrationSourceAdapterIdentity,
	EditorMigrationSourceDescriptor,
	EditorMigrationSourceFingerprint,
	EditorMigrationSourceFingerprintEntry,
	EditorMigrationSourceProfileIdentity,
	EditorMigrationSourceProfileRef,
	EditorMigrationSourceRanking,
	EditorMigrationSourceSnapshot,
	EditorMigrationSourceVerification,
	IEditorMigrationSourceService,
} from '../../common/migration/editorMigrationSource.js';
import { compareEditorMigrationCodePoints, rankEditorMigrationSources } from '../../common/migration/editorMigrationSourceRanking.js';
import {
	EditorMigrationSourceFileError,
	EditorMigrationSourceOperationScheduler,
	IEditorMigrationSourceFileSystem,
} from './editorMigrationSourceFileSystem.js';

const ALL_CATEGORIES: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];
const KNOWN_PROFILE_FLAGS = new Set([
	'settings', 'keybindings', 'snippets', 'prompts', 'tasks', 'extensions',
	'globalState', 'mcp', 'languageModels',
]);

// These bounds are well above the current captured fixtures while preventing
// source discovery from buffering arbitrary editor state into the main process.
export const EDITOR_MIGRATION_SETTINGS_MAX_BYTES = 4 * 1024 * 1024;
export const EDITOR_MIGRATION_KEYBINDINGS_MAX_BYTES = 4 * 1024 * 1024;
export const EDITOR_MIGRATION_PROFILE_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const EDITOR_MIGRATION_EXTENSION_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const EDITOR_MIGRATION_SNIPPET_MAX_BYTES = 2 * 1024 * 1024;
export const EDITOR_MIGRATION_MAX_SNIPPET_FILES = 1024;

/** Host path inputs used to resolve conventional editor locations. */
export interface EditorMigrationPathEnvironment {
	readonly platform: 'darwin' | 'linux' | 'win32';
	readonly homePath: string;
	readonly appDataPath?: string;
	readonly xdgConfigHome?: string;
}

/** Conventional source paths for one supported editor adapter. */
export interface EditorMigrationCandidatePaths {
	readonly userData: URI;
	readonly extensions: URI;
}

interface AdapterDefinition {
	readonly identity: EditorMigrationSourceAdapterIdentity;
	readonly productDirectory: string;
	readonly extensionDirectory: string;
}

interface InternalProfile {
	readonly adapter: AdapterDefinition;
	readonly ref: EditorMigrationSourceProfileRef;
	readonly identity: EditorMigrationSourceProfileIdentity;
	readonly canonicalUserRoot: URI;
	readonly logicalUserRoot: URI;
	readonly extensionRoot: URI;
	readonly profileRoot: URI;
	readonly useDefaultFlags: Readonly<Record<string, boolean>>;
	readonly catalogResource?: URI;
}

interface RawRead {
	readonly state: EditorMigrationResourceState;
	readonly resource: URI;
	readonly identityDigest: string;
	readonly contentHash?: string;
	readonly contents?: string;
	readonly mtime?: number;
	readonly diagnostic?: EditorMigrationDiagnostic;
}

interface CategoryRead {
	readonly snapshot: EditorMigrationCategorySnapshot;
	readonly fingerprintEntries: readonly EditorMigrationSourceFingerprintEntry[];
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
	readonly newestModificationTime: number;
	readonly itemCount: number;
}

interface InternalProfileRead {
	readonly snapshot: EditorMigrationSourceSnapshot;
	readonly newestModificationTime: number;
}

interface CatalogRead {
	readonly profiles: readonly ParsedCatalogProfile[];
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
	readonly fingerprintEntry?: EditorMigrationSourceFingerprintEntry;
}

interface ParsedCatalogProfile {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly location: URI;
	readonly useDefaultFlags: Readonly<Record<string, boolean>>;
}

const ADAPTERS: readonly AdapterDefinition[] = [
	{
		identity: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		productDirectory: 'Code',
		extensionDirectory: '.vscode',
	},
	{
		identity: { id: 'vscode-insiders', productName: 'Visual Studio Code Insiders', channel: 'insiders', order: 1 },
		productDirectory: 'Code - Insiders',
		extensionDirectory: '.vscode-insiders',
	},
	{
		identity: { id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 },
		productDirectory: 'Cursor',
		extensionDirectory: '.cursor',
	},
];

/** Resolves the current process environment used for desktop discovery. */
export function getEditorMigrationPathEnvironment(): EditorMigrationPathEnvironment {
	return {
		platform: isMacintosh ? 'darwin' : isWindows ? 'win32' : isLinux ? 'linux' : process.platform as 'linux',
		homePath: homedir(),
		appDataPath: process.env['APPDATA'],
		xdgConfigHome: process.env['XDG_CONFIG_HOME'],
	};
}

/** Resolves default user-data and extension paths without probing the filesystem. */
export function resolveEditorMigrationCandidatePaths(adapterId: EditorMigrationAdapterId, environment: EditorMigrationPathEnvironment): EditorMigrationCandidatePaths {
	const adapter = ADAPTERS.find(candidate => candidate.identity.id === adapterId);
	if (!adapter) {
		throw new Error(`Unsupported editor migration adapter: ${adapterId}`);
	}
	const path = environment.platform === 'win32' ? win32 : posix;
	let userDataBase: string;
	if (environment.platform === 'darwin') {
		userDataBase = path.join(environment.homePath, 'Library', 'Application Support');
	} else if (environment.platform === 'win32') {
		userDataBase = environment.appDataPath ?? path.join(environment.homePath, 'AppData', 'Roaming');
	} else {
		userDataBase = environment.xdgConfigHome ?? path.join(environment.homePath, '.config');
	}
	return {
		userData: URI.file(path.join(userDataBase, adapter.productDirectory, 'User')),
		extensions: URI.file(path.join(environment.homePath, adapter.extensionDirectory, 'extensions')),
	};
}

/** Read-only desktop implementation of automatic editor source discovery. */
export class EditorMigrationSourceService extends Disposable implements IEditorMigrationSourceService {
	declare readonly _serviceBrand: undefined;

	private readonly scheduler = this._register(new EditorMigrationSourceOperationScheduler(2));
	private generation = 0;
	private profiles = new Map<string, InternalProfile>();

	constructor(
		private readonly fileSystem: IEditorMigrationSourceFileSystem,
		private readonly environment: EditorMigrationPathEnvironment = getEditorMigrationPathEnvironment(),
	) {
		super();
	}

	discoverSources(options: EditorMigrationDiscoveryOptions, token: CancellationToken): Promise<EditorMigrationDiscoveryResult> {
		return this.scheduler.run(async operationToken => {
			const generation = ++this.generation;
			const profiles = new Map<string, InternalProfile>();
			const diagnostics: EditorMigrationDiagnostic[] = [];
			const descriptors: EditorMigrationSourceDescriptor[] = [];
			for (const adapter of ADAPTERS) {
				throwIfCancelled(operationToken);
				const result = await this.discoverAdapter(adapter, options, operationToken);
				diagnostics.push(...result.diagnostics);
				for (const item of result.sources) {
					profiles.set(item.profile.ref.value, item.profile);
					descriptors.push(item.descriptor);
				}
			}

			const deduplicated = this.deduplicate(descriptors, profiles, diagnostics);
			if (generation === this.generation) {
				this.profiles = profiles;
			}
			return {
				schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
				generation,
				sources: rankEditorMigrationSources(deduplicated),
				diagnostics,
			};
		}, token);
	}

	readSourceProfile(ref: EditorMigrationSourceProfileRef, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationSourceSnapshot> {
		return this.scheduler.run(async operationToken => {
			const profile = this.profiles.get(ref.value);
			if (!profile) {
				throw new Error('Editor migration source profile reference is stale');
			}
			return (await this.readProfile(profile, normalizeCategories(categories), operationToken)).snapshot;
		}, token);
	}

	verifySourceSnapshot(ref: EditorMigrationSourceProfileRef, fingerprint: EditorMigrationSourceFingerprint, token: CancellationToken): Promise<EditorMigrationSourceVerification> {
		return this.scheduler.run(async operationToken => {
			const profile = this.profiles.get(ref.value);
			if (!profile) {
				return { status: 'unavailable', diagnostics: [] };
			}
			const snapshot = (await this.readProfile(profile, normalizeCategories(fingerprint.categories), operationToken)).snapshot;
			return {
				status: snapshot.fingerprint.value === fingerprint.value ? 'unchanged' : 'changed',
				currentFingerprint: snapshot.fingerprint,
				diagnostics: snapshot.diagnostics,
			};
		}, token);
	}

	private async discoverAdapter(adapter: AdapterDefinition, options: EditorMigrationDiscoveryOptions, token: CancellationToken): Promise<{
		readonly sources: readonly { readonly profile: InternalProfile; readonly descriptor: EditorMigrationSourceDescriptor }[];
		readonly diagnostics: readonly EditorMigrationDiagnostic[];
	}> {
		const paths = resolveEditorMigrationCandidatePaths(adapter.identity.id, this.environment);
		let canonicalUserRoot: URI;
		try {
			const stat = await this.fileSystem.stat(paths.userData, token);
			if (stat.type !== 'directory') {
				throw new EditorMigrationSourceFileError('notFound', paths.userData);
			}
			canonicalUserRoot = await this.fileSystem.realpath(paths.userData, token);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			const diagnostic = this.diagnosticFromError(error, adapter.identity.id, 'candidate', paths.userData);
			return {
				sources: [],
				diagnostics: diagnostic.code === 'candidateAbsent' && !options.includeAbsentCandidateDiagnostics ? [] : [diagnostic],
			};
		}

		const catalogResource = joinPath(paths.userData, 'globalStorage', 'storage.json');
		const catalog = await this.readCatalog(adapter, paths.userData, catalogResource, token);
		const rawProfiles: Array<Omit<InternalProfile, 'ref'>> = [{
			adapter,
			identity: { id: 'default', name: 'Default', kind: 'default' },
			canonicalUserRoot,
			logicalUserRoot: paths.userData,
			extensionRoot: paths.extensions,
			profileRoot: paths.userData,
			useDefaultFlags: {},
		}];
		for (const named of catalog.profiles) {
			rawProfiles.push({
				adapter,
				identity: { id: named.id, name: named.name, kind: 'named', icon: named.icon },
				canonicalUserRoot,
				logicalUserRoot: paths.userData,
				extensionRoot: paths.extensions,
				profileRoot: named.location,
				useDefaultFlags: named.useDefaultFlags,
				catalogResource,
			});
		}

		const sources: Array<{ profile: InternalProfile; descriptor: EditorMigrationSourceDescriptor }> = [];
		const diagnostics = [...catalog.diagnostics];
		for (const rawProfile of rawProfiles) {
			throwIfCancelled(token);
			const ref = this.createRef(rawProfile.adapter.identity.id, canonicalUserRoot, rawProfile.identity.id);
			const profile: InternalProfile = { ...rawProfile, ref };
			const read = await this.readProfile(profile, ALL_CATEGORIES, token);
			const snapshot = read.snapshot;
			const summaries = snapshot.categories.map(category => this.summarizeCategory(category));
			if (!summaries.some(summary => summary.state === 'present')) {
				diagnostics.push(...snapshot.diagnostics);
				continue;
			}
			const ranking = this.createRanking(profile, summaries, read.newestModificationTime);
			sources.push({
				profile,
				descriptor: {
					schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
					ref,
					adapter: adapter.identity,
					profile: profile.identity,
					localPaths: { userData: profile.profileRoot.fsPath, extensions: paths.extensions.fsPath },
					categories: summaries,
					diagnostics: snapshot.diagnostics,
					ranking,
					discoveryFingerprint: snapshot.fingerprint,
				},
			});
		}
		return { sources, diagnostics };
	}

	private async readProfile(profile: InternalProfile, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<InternalProfileRead> {
		const categoryReads: CategoryRead[] = [];
		for (const category of categories) {
			throwIfCancelled(token);
			categoryReads.push(await this.readCategory(profile, category, token));
		}
		const diagnostics = categoryReads.flatMap(read => [...read.diagnostics]);
		const entries = categoryReads.flatMap(read => [...read.fingerprintEntries]);
		if (profile.catalogResource) {
			const catalog = await this.readRawFile(profile, 'profileCatalog', profile.catalogResource, EDITOR_MIGRATION_PROFILE_CATALOG_MAX_BYTES, token);
			entries.push(toFingerprintEntry('profileCatalog', catalog));
			if (catalog.diagnostic) {
				diagnostics.push(catalog.diagnostic);
			}
		}
		entries.sort(compareFingerprintEntries);
		const fingerprint: EditorMigrationSourceFingerprint = {
			schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
			algorithm: 'sha256',
			categories,
			entries,
			value: sha256String(JSON.stringify({
				schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
				adapter: profile.adapter.identity.id,
				profile: profile.identity.id,
				categories,
				entries,
			})),
		};
		return {
			snapshot: {
				schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
				ref: profile.ref,
				adapter: profile.adapter.identity,
				profile: profile.identity,
				categories: categoryReads.map(read => read.snapshot),
				diagnostics,
				fingerprint,
			},
			newestModificationTime: Math.max(0, ...categoryReads.map(read => read.newestModificationTime)),
		};
	}

	private readCategory(profile: InternalProfile, category: EditorMigrationCategory, token: CancellationToken): Promise<CategoryRead> {
		switch (category) {
			case 'settings': return this.readJsonObjectCategory(profile, category, this.categoryResource(profile, category), EDITOR_MIGRATION_SETTINGS_MAX_BYTES, token);
			case 'keybindings': return this.readKeybindings(profile, this.categoryResource(profile, category), token);
			case 'snippets': return this.readSnippets(profile, this.categoryResource(profile, category), token);
			case 'extensions': return this.readExtensions(profile, token);
		}
	}

	private async readJsonObjectCategory(profile: InternalProfile, category: 'settings', resource: URI, maxBytes: number, token: CancellationToken): Promise<CategoryRead> {
		const raw = await this.readRawFile(profile, category, resource, maxBytes, token);
		if (raw.state !== 'present') {
			return simpleCategoryRead(category, raw);
		}
		const parsed = parseJsonWithComments(raw.contents!);
		if (!isJsonObject(parsed.value) || parsed.errors.length > 0) {
			return malformedCategoryRead(profile, category, raw);
		}
		return successfulCategoryRead({ category, state: 'present', value: parsed.value }, raw, Object.keys(parsed.value).length);
	}

	private async readKeybindings(profile: InternalProfile, resource: URI, token: CancellationToken): Promise<CategoryRead> {
		const raw = await this.readRawFile(profile, 'keybindings', resource, EDITOR_MIGRATION_KEYBINDINGS_MAX_BYTES, token);
		if (raw.state !== 'present') {
			return simpleCategoryRead('keybindings', raw);
		}
		const parsed = parseJsonWithComments(raw.contents!);
		if (!Array.isArray(parsed.value) || parsed.errors.length > 0 || !parsed.value.every(isJsonObject)) {
			return malformedCategoryRead(profile, 'keybindings', raw);
		}
		return successfulCategoryRead({ category: 'keybindings', state: 'present', value: parsed.value }, raw, parsed.value.length);
	}

	private async readSnippets(profile: InternalProfile, resource: URI, token: CancellationToken): Promise<CategoryRead> {
		let entries;
		try {
			entries = await this.fileSystem.readDirectory(resource, token);
		} catch (error) {
			const raw = this.rawReadFromError(profile, 'snippets', resource, error);
			return simpleCategoryRead('snippets', raw);
		}
		const accepted = entries
			.filter(entry => entry.type === 'file' && (entry.name.endsWith('.code-snippets') || entry.name.endsWith('.json')))
			.sort((a, b) => compareEditorMigrationCodePoints(a.name, b.name));
		if (accepted.length > EDITOR_MIGRATION_MAX_SNIPPET_FILES) {
			const error = new EditorMigrationSourceFileError('oversized', resource, EDITOR_MIGRATION_MAX_SNIPPET_FILES);
			return simpleCategoryRead('snippets', this.rawReadFromError(profile, 'snippets', resource, error));
		}

		const snippets: EditorMigrationSnippet[] = [];
		const diagnostics: EditorMigrationDiagnostic[] = [];
		const contentEntries: Array<{ readonly name: string; readonly state: EditorMigrationResourceState; readonly hash?: string }> = [];
		let newestModificationTime = 0;
		let anyUnreadable = false;
		for (const entry of accepted) {
			throwIfCancelled(token);
			const raw = await this.readRawFile(profile, 'snippets', joinPath(resource, entry.name), EDITOR_MIGRATION_SNIPPET_MAX_BYTES, token);
			newestModificationTime = Math.max(newestModificationTime, raw.mtime ?? 0);
			if (raw.diagnostic) {
				diagnostics.push(raw.diagnostic);
			}
			if (raw.state !== 'present') {
				anyUnreadable = true;
				contentEntries.push({ name: entry.name, state: raw.state });
				continue;
			}
			const parsed = parseJsonWithComments(raw.contents!);
			if (!isJsonObject(parsed.value) || parsed.errors.length > 0) {
				anyUnreadable = true;
				diagnostics.push(malformedDiagnostic(profile, 'snippets', raw.resource));
				contentEntries.push({ name: entry.name, state: 'unreadable', hash: raw.contentHash });
				continue;
			}
			snippets.push({ name: entry.name, contents: parsed.value, contentHash: raw.contentHash! });
			contentEntries.push({ name: entry.name, state: 'present', hash: raw.contentHash! });
		}
		const state: EditorMigrationResourceState = anyUnreadable && snippets.length === 0 ? 'unreadable' : 'present';
		const aggregate = sha256String(JSON.stringify(contentEntries));
		let canonical = resource;
		try {
			canonical = await this.fileSystem.realpath(resource, token);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			// The known logical directory remains a stable fallback identity.
		}
		return {
			snapshot: { category: 'snippets', state, value: state === 'present' ? snippets : undefined },
			fingerprintEntries: [{ category: 'snippets', identityDigest: sha256String(normalizePath(canonical.fsPath, this.environment.platform)), state, contentHash: aggregate }],
			diagnostics,
			newestModificationTime,
			itemCount: snippets.length,
		};
	}

	private async readExtensions(profile: InternalProfile, token: CancellationToken): Promise<CategoryRead> {
		const inherited = profile.identity.kind === 'named' && profile.useDefaultFlags['extensions'];
		const primary = inherited || profile.identity.kind === 'default'
			? joinPath(profile.extensionRoot, 'extensions.json')
			: joinPath(profile.profileRoot, 'extensions.json');
		let raw = await this.readRawFile(profile, 'extensions', primary, EDITOR_MIGRATION_EXTENSION_MANIFEST_MAX_BYTES, token);
		if (raw.state === 'absent' && (inherited || profile.identity.kind === 'default')) {
			raw = await this.readRawFile(profile, 'extensions', joinPath(profile.logicalUserRoot, 'extensions.json'), EDITOR_MIGRATION_EXTENSION_MANIFEST_MAX_BYTES, token);
		}
		if (raw.state !== 'present') {
			return simpleCategoryRead('extensions', raw);
		}
		const parsed = parseJsonWithComments(raw.contents!);
		if (!Array.isArray(parsed.value) || parsed.errors.length > 0) {
			return malformedCategoryRead(profile, 'extensions', raw);
		}
		const extensions: EditorMigrationExtension[] = [];
		for (const value of parsed.value) {
			if (!isJsonObject(value) || !isJsonObject(value['identifier']) || typeof value['identifier']['id'] !== 'string' || typeof value['version'] !== 'string') {
				return malformedCategoryRead(profile, 'extensions', raw);
			}
			const identifier = value['identifier'];
			const metadata = isJsonObject(value['metadata']) ? value['metadata'] : undefined;
			if (identifier['uuid'] !== undefined && typeof identifier['uuid'] !== 'string') {
				return malformedCategoryRead(profile, 'extensions', raw);
			}
			if (metadata?.['preRelease'] !== undefined && typeof metadata['preRelease'] !== 'boolean') {
				return malformedCategoryRead(profile, 'extensions', raw);
			}
			if (metadata?.['hasPreReleaseVersion'] !== undefined && typeof metadata['hasPreReleaseVersion'] !== 'boolean') {
				return malformedCategoryRead(profile, 'extensions', raw);
			}
			extensions.push({
				id: identifier['id'] as string,
				uuid: identifier['uuid'] as string | undefined,
				version: value['version'],
				preRelease: metadata?.['preRelease'] as boolean | undefined,
				hasPreReleaseVersion: metadata?.['hasPreReleaseVersion'] as boolean | undefined,
			});
		}
		extensions.sort((a, b) => compareEditorMigrationCodePoints(a.id, b.id) || compareEditorMigrationCodePoints(a.version, b.version));
		return successfulCategoryRead({ category: 'extensions', state: 'present', value: extensions }, raw, extensions.length);
	}

	private categoryResource(profile: InternalProfile, category: Exclude<EditorMigrationCategory, 'extensions'>): URI {
		const inherited = profile.identity.kind === 'named' && profile.useDefaultFlags[category];
		const root = inherited ? profile.logicalUserRoot : profile.profileRoot;
		switch (category) {
			case 'settings': return joinPath(root, 'settings.json');
			case 'keybindings': return joinPath(root, 'keybindings.json');
			case 'snippets': return joinPath(root, 'snippets');
		}
	}

	private async readRawFile(profile: InternalProfile, category: EditorMigrationCategory | 'profileCatalog', resource: URI, maxBytes: number, token: CancellationToken): Promise<RawRead> {
		try {
			const value = await this.fileSystem.readFile(resource, { maxBytes }, token);
			const stat = await this.fileSystem.stat(resource, token);
			let canonical = resource;
			try {
				canonical = await this.fileSystem.realpath(resource, token);
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				// Content is still usable when canonicalization is unavailable.
			}
			return {
				state: 'present',
				resource,
				identityDigest: sha256String(normalizePath(canonical.fsPath, this.environment.platform)),
				contentHash: sha256Bytes(value.buffer),
				contents: value.toString(),
				mtime: stat.mtime,
			};
		} catch (error) {
			return this.rawReadFromError(profile, category, resource, error);
		}
	}

	private rawReadFromError(profile: InternalProfile, category: EditorMigrationCategory | 'profileCatalog', resource: URI, error: unknown): RawRead {
		if (error instanceof CancellationError) {
			throw error;
		}
		const diagnostic = this.diagnosticFromError(error, profile.adapter.identity.id, 'resource', resource, profile.identity.id, category === 'profileCatalog' ? undefined : category);
		return {
			state: diagnostic.code === 'candidateAbsent' ? 'absent' : 'unreadable',
			resource,
			identityDigest: sha256String(normalizePath(resource.fsPath, this.environment.platform)),
			diagnostic: diagnostic.code === 'candidateAbsent' ? undefined : diagnostic,
		};
	}

	private async readCatalog(adapter: AdapterDefinition, userRoot: URI, resource: URI, token: CancellationToken): Promise<CatalogRead> {
		const defaultProfile = this.catalogDiagnosticProfile(adapter, userRoot);
		const raw = await this.readRawFile(defaultProfile, 'profileCatalog', resource, EDITOR_MIGRATION_PROFILE_CATALOG_MAX_BYTES, token);
		if (raw.state === 'absent') {
			return { profiles: [], diagnostics: [], fingerprintEntry: toFingerprintEntry('profileCatalog', raw) };
		}
		if (raw.state !== 'present') {
			return { profiles: [], diagnostics: raw.diagnostic ? [raw.diagnostic] : [], fingerprintEntry: toFingerprintEntry('profileCatalog', raw) };
		}
		let container: EditorMigrationJsonValue | undefined;
		try {
			container = JSON.parse(raw.contents!) as EditorMigrationJsonValue;
		} catch {
			return {
				profiles: [],
				diagnostics: [malformedDiagnostic(defaultProfile, undefined, resource, 'catalog')],
				fingerprintEntry: toFingerprintEntry('profileCatalog', raw),
			};
		}
		if (!isJsonObject(container) || !Array.isArray(container['userDataProfiles'])) {
			return {
				profiles: [],
				diagnostics: [{ code: 'unsupportedNamedProfileCatalogSchema', severity: 'warning', scope: 'catalog', adapterId: adapter.identity.id, details: { path: resource.fsPath } }],
				fingerprintEntry: toFingerprintEntry('profileCatalog', raw),
			};
		}
		const profiles: ParsedCatalogProfile[] = [];
		const diagnostics: EditorMigrationDiagnostic[] = [];
		for (let index = 0; index < container['userDataProfiles'].length; index++) {
			const parsed = parseCatalogProfile(container['userDataProfiles'][index], userRoot);
			if (parsed.kind !== 'valid') {
				if (parsed.kind === 'builtin') {
					continue;
				}
				diagnostics.push({ code: 'unsupportedNamedProfileCatalogSchema', severity: 'warning', scope: 'profile', adapterId: adapter.identity.id, details: { path: resource.fsPath, entry: String(index) } });
				continue;
			}
			profiles.push(parsed.profile);
		}
		return { profiles, diagnostics, fingerprintEntry: toFingerprintEntry('profileCatalog', raw) };
	}

	private catalogDiagnosticProfile(adapter: AdapterDefinition, userRoot: URI): InternalProfile {
		return {
			adapter,
			ref: { value: 'catalog' },
			identity: { id: 'default', name: 'Default', kind: 'default' },
			canonicalUserRoot: userRoot,
			logicalUserRoot: userRoot,
			extensionRoot: userRoot,
			profileRoot: userRoot,
			useDefaultFlags: {},
		};
	}

	private diagnosticFromError(error: unknown, adapterId: EditorMigrationAdapterId, scope: EditorMigrationDiagnostic['scope'], resource: URI, profileId?: string, category?: EditorMigrationCategory): EditorMigrationDiagnostic {
		let code: EditorMigrationDiagnostic['code'] = 'malformedKnownResource';
		let severity: EditorMigrationDiagnostic['severity'] = 'warning';
		let limit: number | undefined;
		if (error instanceof EditorMigrationSourceFileError) {
			switch (error.kind) {
				case 'notFound': code = 'candidateAbsent'; severity = 'info'; break;
				case 'permission': code = 'permissionDeniedOrLocked'; break;
				case 'oversized': code = 'oversizedResource'; limit = error.limit; break;
				case 'changed': code = 'sourceChangedDuringRead'; break;
				case 'other': code = 'malformedKnownResource'; break;
			}
		}
		return { code, severity, scope, adapterId, profileId, category, details: { path: resource.fsPath, limit } };
	}

	private summarizeCategory(snapshot: EditorMigrationCategorySnapshot): EditorMigrationCategorySummary {
		const value = snapshot.value;
		return {
			category: snapshot.category,
			state: snapshot.state,
			itemCount: Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0,
		};
	}

	private createRanking(profile: InternalProfile, summaries: readonly EditorMigrationCategorySummary[], newestModificationTime: number): EditorMigrationSourceRanking {
		return {
			completeness: summaries.filter(summary => summary.state === 'present').length,
			newestModificationTime,
			stableChannelPreference: profile.adapter.identity.channel === 'stable' ? 1 : 0,
			adapterOrder: profile.adapter.identity.order,
			normalizedProfileName: profile.identity.name.normalize('NFC').toLowerCase(),
			canonicalReference: profile.ref.value,
		};
	}

	private createRef(adapterId: EditorMigrationAdapterId, canonicalRoot: URI, profileId: string): EditorMigrationSourceProfileRef {
		return { value: `source-v1:${sha256String(`${adapterId}\0${normalizePath(canonicalRoot.fsPath, this.environment.platform)}\0${profileId}`).slice(0, 32)}` };
	}

	private deduplicate(descriptors: readonly EditorMigrationSourceDescriptor[], profiles: Map<string, InternalProfile>, diagnostics: EditorMigrationDiagnostic[]): EditorMigrationSourceDescriptor[] {
		const seen = new Map<string, EditorMigrationSourceDescriptor>();
		const result: EditorMigrationSourceDescriptor[] = [];
		for (const descriptor of descriptors) {
			const profile = profiles.get(descriptor.ref.value)!;
			const key = `${normalizePath(profile.canonicalUserRoot.fsPath, this.environment.platform)}\0${profile.identity.id}`;
			const existing = seen.get(key);
			if (!existing) {
				seen.set(key, descriptor);
				result.push(descriptor);
				continue;
			}
			profiles.delete(descriptor.ref.value);
			diagnostics.push({ code: 'duplicateAlias', severity: 'info', scope: 'candidate', adapterId: descriptor.adapter.id, profileId: descriptor.profile.id, details: { path: descriptor.localPaths.userData } });
		}
		return result;
	}
}

function parseCatalogProfile(value: EditorMigrationJsonValue, userRoot: URI): { readonly kind: 'valid'; readonly profile: ParsedCatalogProfile } | { readonly kind: 'invalid' | 'builtin' } {
	if (!isJsonObject(value) || typeof value['name'] !== 'string' || value['name'].trim().length === 0) {
		return { kind: 'invalid' };
	}
	const location = value['location'];
	let profileLocation: URI;
	let id: string;
	if (typeof location === 'string') {
		if (!isSinglePathSegment(location)) {
			return location === 'builtin' || location.startsWith('builtin/') || location.startsWith('builtin\\') ? { kind: 'builtin' } : { kind: 'invalid' };
		}
		if (location === 'builtin') {
			return { kind: 'builtin' };
		}
		id = location;
		profileLocation = joinPath(userRoot, 'profiles', id);
	} else if (isUriComponents(location)) {
		profileLocation = URI.revive(location);
		const profilesHome = joinPath(userRoot, 'profiles');
		const relativeParent = normalizeSlash(dirname(profileLocation).path);
		const expectedParent = normalizeSlash(profilesHome.path);
		if (profileLocation.scheme !== 'file' || relativeParent !== expectedParent) {
			if (normalizeSlash(profileLocation.path).startsWith(`${expectedParent}/builtin/`)) {
				return { kind: 'builtin' };
			}
			return { kind: 'invalid' };
		}
		id = basename(profileLocation);
		if (!isSinglePathSegment(id)) {
			return { kind: 'invalid' };
		}
	} else {
		return { kind: 'invalid' };
	}

	if (value['icon'] !== undefined && typeof value['icon'] !== 'string') {
		return { kind: 'invalid' };
	}
	const flags = value['useDefaultFlags'];
	const useDefaultFlags: Record<string, boolean> = {};
	if (flags !== undefined) {
		if (!isJsonObject(flags)) {
			return { kind: 'invalid' };
		}
		for (const [key, flag] of Object.entries(flags)) {
			if (!KNOWN_PROFILE_FLAGS.has(key) || typeof flag !== 'boolean') {
				return { kind: 'invalid' };
			}
			useDefaultFlags[key] = flag;
		}
	}
	return {
		kind: 'valid',
		profile: { id, name: value['name'].trim(), icon: value['icon'] as string | undefined, location: profileLocation, useDefaultFlags },
	};
}

function parseJsonWithComments(contents: string): { readonly value: EditorMigrationJsonValue | undefined; readonly errors: readonly string[] } {
	try {
		return { value: parse<EditorMigrationJsonValue>(contents), errors: [] };
	} catch {
		return { value: undefined, errors: ['invalid'] };
	}
}

function isJsonObject(value: EditorMigrationJsonValue | undefined): value is { readonly [key: string]: EditorMigrationJsonValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: object | undefined): value is Readonly<Record<string, object>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUriComponents(value: EditorMigrationJsonValue): value is EditorMigrationJsonValue & UriComponents {
	return isJsonObject(value) && typeof value['scheme'] === 'string' && typeof value['path'] === 'string';
}

function isSinglePathSegment(value: string): boolean {
	return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function normalizeCategories(categories: readonly EditorMigrationCategory[]): EditorMigrationCategory[] {
	const requested = new Set(categories);
	return ALL_CATEGORIES.filter(category => requested.has(category));
}

function normalizePath(value: string, platform: EditorMigrationPathEnvironment['platform']): string {
	const normalized = normalizeSlash(value).replace(/\/$/, '');
	return platform === 'linux' ? normalized : normalized.toLowerCase();
}

function normalizeSlash(value: string): string {
	return value.replaceAll('\\', '/');
}

function sha256Bytes(value: Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function sha256String(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toFingerprintEntry(category: EditorMigrationCategory | 'profileCatalog', raw: RawRead): EditorMigrationSourceFingerprintEntry {
	return { category, identityDigest: raw.identityDigest, state: raw.state, contentHash: raw.contentHash };
}

function compareFingerprintEntries(a: EditorMigrationSourceFingerprintEntry, b: EditorMigrationSourceFingerprintEntry): number {
	return compareEditorMigrationCodePoints(a.category, b.category) || compareEditorMigrationCodePoints(a.identityDigest, b.identityDigest);
}

function simpleCategoryRead(category: EditorMigrationCategory, raw: RawRead): CategoryRead {
	return {
		snapshot: categorySnapshot(category, raw.state),
		fingerprintEntries: [toFingerprintEntry(category, raw)],
		diagnostics: raw.diagnostic ? [raw.diagnostic] : [],
		newestModificationTime: raw.mtime ?? 0,
		itemCount: 0,
	};
}

function successfulCategoryRead(snapshot: EditorMigrationCategorySnapshot, raw: RawRead, itemCount: number): CategoryRead {
	return {
		snapshot,
		fingerprintEntries: [toFingerprintEntry(snapshot.category, raw)],
		diagnostics: [],
		newestModificationTime: raw.mtime ?? 0,
		itemCount,
	};
}

function malformedCategoryRead(profile: InternalProfile, category: EditorMigrationCategory, raw: RawRead): CategoryRead {
	return {
		snapshot: categorySnapshot(category, 'unreadable'),
		fingerprintEntries: [{ ...toFingerprintEntry(category, raw), state: 'unreadable' }],
		diagnostics: [malformedDiagnostic(profile, category, raw.resource)],
		newestModificationTime: raw.mtime ?? 0,
		itemCount: 0,
	};
}

function categorySnapshot(category: EditorMigrationCategory, state: EditorMigrationResourceState): EditorMigrationCategorySnapshot {
	switch (category) {
		case 'settings': return { category, state };
		case 'keybindings': return { category, state };
		case 'snippets': return { category, state };
		case 'extensions': return { category, state };
	}
}

function malformedDiagnostic(profile: InternalProfile, category: EditorMigrationCategory | undefined, resource: URI, scope: EditorMigrationDiagnostic['scope'] = 'resource'): EditorMigrationDiagnostic {
	return { code: 'malformedKnownResource', severity: 'warning', scope, adapterId: profile.adapter.identity.id, profileId: profile.identity.id, category, details: { path: resource.fsPath } };
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}
