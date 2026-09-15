/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix, win32 } from '../../../base/common/path.js';
import { basename, dirname, joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import {
	EditorMigrationAdapterId,
	EditorMigrationCategory,
	EditorMigrationDiagnostic,
	EditorMigrationJsonValue,
	EditorMigrationSourceAdapterIdentity,
	EditorMigrationSourceProfileIdentity,
} from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationSourceFileError } from './editorMigrationSourceFileSystem.js';

const KNOWN_PROFILE_FLAGS = new Set([
	'settings', 'keybindings', 'snippets', 'prompts', 'tasks', 'extensions',
	'globalState', 'mcp', 'languageModels',
]);

export interface EditorMigrationPathEnvironment {
	readonly platform: 'darwin' | 'linux' | 'win32';
	readonly homePath: string;
	readonly appDataPath?: string;
	readonly xdgConfigHome?: string;
}

export interface EditorMigrationCandidatePaths {
	readonly userData: URI;
	readonly extensions: URI;
}

export interface EditorMigrationParsedCatalogProfile {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly location: URI;
	readonly useDefaultFlags: Readonly<Record<string, boolean>>;
}

export interface EditorMigrationAdapterProfileLayout {
	readonly identity: EditorMigrationSourceProfileIdentity;
	readonly logicalUserRoot: URI;
	readonly extensionRoot: URI;
	readonly profileRoot: URI;
	readonly useDefaultFlags: Readonly<Record<string, boolean>>;
}

export interface IEditorMigrationSourceAdapter {
	readonly identity: EditorMigrationSourceAdapterIdentity;

	resolveCandidatePaths(environment: EditorMigrationPathEnvironment): EditorMigrationCandidatePaths;
	parseCatalogProfile(value: EditorMigrationJsonValue, userRoot: URI): { readonly kind: 'valid'; readonly profile: EditorMigrationParsedCatalogProfile } | { readonly kind: 'invalid' | 'builtin' };
	categoryResource(profile: EditorMigrationAdapterProfileLayout, category: Exclude<EditorMigrationCategory, 'extensions'>): URI;
	extensionResources(profile: EditorMigrationAdapterProfileLayout): { readonly primary: URI; readonly fallback?: URI };
	diagnosticFromError(error: unknown, scope: EditorMigrationDiagnostic['scope'], resource: URI, profileId?: string, category?: EditorMigrationCategory): EditorMigrationDiagnostic;
}

/** Shared implementation for the currently identical Code-family storage schema. */
export class CodeFamilyEditorMigrationSourceAdapter implements IEditorMigrationSourceAdapter {
	constructor(
		readonly identity: EditorMigrationSourceAdapterIdentity,
		private readonly productDirectory: string,
		private readonly extensionDirectory: string,
	) { }

	resolveCandidatePaths(environment: EditorMigrationPathEnvironment): EditorMigrationCandidatePaths {
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
			userData: URI.file(path.join(userDataBase, this.productDirectory, 'User')),
			extensions: URI.file(path.join(environment.homePath, this.extensionDirectory, 'extensions')),
		};
	}

	parseCatalogProfile(value: EditorMigrationJsonValue, userRoot: URI): { readonly kind: 'valid'; readonly profile: EditorMigrationParsedCatalogProfile } | { readonly kind: 'invalid' | 'builtin' } {
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
		} else {
			const parsedLocation = parseStoredUri(location);
			if (!parsedLocation) {
				return { kind: 'invalid' };
			}
			profileLocation = parsedLocation;
			const profilesHome = joinPath(userRoot, 'profiles');
			const relativeParent = normalizeSlash(dirname(profileLocation).path);
			const expectedParent = normalizeSlash(profilesHome.path);
			const sameOrigin = profileLocation.scheme === profilesHome.scheme
				&& profileLocation.authority === profilesHome.authority
				&& profileLocation.query.length === 0
				&& profileLocation.fragment.length === 0;
			if (!sameOrigin || relativeParent !== expectedParent) {
				if (sameOrigin && normalizeSlash(profileLocation.path).startsWith(`${expectedParent}/builtin/`)) {
					return { kind: 'builtin' };
				}
				return { kind: 'invalid' };
			}
			id = basename(profileLocation);
			if (!isSinglePathSegment(id) || id === 'builtin') {
				return id === 'builtin' ? { kind: 'builtin' } : { kind: 'invalid' };
			}
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

	categoryResource(profile: EditorMigrationAdapterProfileLayout, category: Exclude<EditorMigrationCategory, 'extensions'>): URI {
		const inherited = profile.identity.kind === 'named' && profile.useDefaultFlags[category];
		const root = inherited ? profile.logicalUserRoot : profile.profileRoot;
		switch (category) {
			case 'settings': return joinPath(root, 'settings.json');
			case 'keybindings': return joinPath(root, 'keybindings.json');
			case 'snippets': return joinPath(root, 'snippets');
		}
	}

	extensionResources(profile: EditorMigrationAdapterProfileLayout): { readonly primary: URI; readonly fallback?: URI } {
		const inherited = profile.identity.kind === 'named' && profile.useDefaultFlags['extensions'];
		return inherited || profile.identity.kind === 'default'
			? { primary: joinPath(profile.extensionRoot, 'extensions.json'), fallback: joinPath(profile.logicalUserRoot, 'extensions.json') }
			: { primary: joinPath(profile.profileRoot, 'extensions.json') };
	}

	diagnosticFromError(error: unknown, scope: EditorMigrationDiagnostic['scope'], resource: URI, profileId?: string, category?: EditorMigrationCategory): EditorMigrationDiagnostic {
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
		return { code, severity, scope, adapterId: this.identity.id, profileId, category, details: { path: resource.fsPath, limit } };
	}
}

/** Cursor remains an explicit adapter so future schema drift cannot affect VS Code implicitly. */
export class CursorEditorMigrationSourceAdapter extends CodeFamilyEditorMigrationSourceAdapter {
	constructor() {
		super({ id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 }, 'Cursor', '.cursor');
	}
}

export const EDITOR_MIGRATION_SOURCE_ADAPTERS: readonly IEditorMigrationSourceAdapter[] = [
	new CodeFamilyEditorMigrationSourceAdapter({ id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 }, 'Code', '.vscode'),
	new CodeFamilyEditorMigrationSourceAdapter({ id: 'vscode-insiders', productName: 'Visual Studio Code Insiders', channel: 'insiders', order: 1 }, 'Code - Insiders', '.vscode-insiders'),
	new CursorEditorMigrationSourceAdapter(),
];

export function getEditorMigrationSourceAdapter(adapterId: EditorMigrationAdapterId): IEditorMigrationSourceAdapter {
	const adapter = EDITOR_MIGRATION_SOURCE_ADAPTERS.find(candidate => candidate.identity.id === adapterId);
	if (!adapter) {
		throw new Error(`Unsupported editor migration adapter: ${adapterId}`);
	}
	return adapter;
}

function isJsonObject(value: EditorMigrationJsonValue | undefined): value is { readonly [key: string]: EditorMigrationJsonValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredUri(value: EditorMigrationJsonValue): URI | undefined {
	if (!isJsonObject(value)
		|| typeof value['scheme'] !== 'string'
		|| typeof value['path'] !== 'string'
		|| !isOptionalString(value['authority'])
		|| !isOptionalString(value['query'])
		|| !isOptionalString(value['fragment'])) {
		return undefined;
	}
	try {
		return URI.from({
			scheme: value['scheme'],
			authority: value['authority'],
			path: value['path'],
			query: value['query'],
			fragment: value['fragment'],
		}, true);
	} catch {
		return undefined;
	}
}

function isOptionalString(value: EditorMigrationJsonValue | undefined): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function isSinglePathSegment(value: string): boolean {
	return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function normalizeSlash(value: string): string {
	return value.replaceAll('\\', '/');
}
