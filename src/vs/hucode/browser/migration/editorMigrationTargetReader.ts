/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../base/common/buffer.js';
import { CancellationError } from '../../../base/common/errors.js';
import { parse, ParseError } from '../../../base/common/json.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService, toFileOperationResult } from '../../../platform/files/common/files.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { EditorMigrationCategory, EditorMigrationJsonValue, EditorMigrationSnippet } from '../../common/migration/editorMigrationSource.js';
import { effectiveEditorMigrationExtensions, parseEditorMigrationExtensionManifest } from '../../common/migration/editorMigrationExtensionManifest.js';
import {
	EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
	EditorMigrationBuiltInExtension,
	EditorMigrationPlanningError,
	EditorMigrationTargetCategorySnapshot,
	EditorMigrationTargetEnvironment,
	EditorMigrationTargetSelection,
	EditorMigrationTargetSnapshot,
} from '../../common/migration/editorMigrationPlanning.js';
import { compareEditorMigrationCodePoints as compare, fingerprintEditorMigrationValue, immutableEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';

const FILE_MAX_BYTES = 4 * 1024 * 1024;
const SNIPPETS_MAX_BYTES = 8 * 1024 * 1024;

/** Reads explicit migration targets without changing the profile catalog or resources. */
export class EditorMigrationTargetReader {
	constructor(
		private readonly fileService: IFileService,
		private readonly profilesService: IUserDataProfilesService,
	) { }

	/** Resolves and snapshots an explicit existing or proposed target. */
	async inspect(
		selection: EditorMigrationTargetSelection,
		categories: readonly EditorMigrationCategory[],
		environment: EditorMigrationTargetEnvironment,
		builtIns: readonly EditorMigrationBuiltInExtension[],
		token: CancellationToken,
	): Promise<EditorMigrationTargetSnapshot> {
		throwIfCancelled(token);
		const requestedCategories = normalizeCategories(categories);
		if (requestedCategories.length === 0) {
			throw new EditorMigrationPlanningError('invalidTarget', 'At least one target category is required');
		}
		const completeCatalog = this.profilesService.profiles;
		const storedProfiles = completeCatalog.filter(profile => !profile.isTransient);
		const storedNameFingerprint = await fingerprintEditorMigrationValue(storedProfiles.map(profile => profile.name).sort(compare));

		if (selection.kind === 'proposed') {
			return await this.inspectProposed(selection, requestedCategories, storedProfiles, storedNameFingerprint, environment, builtIns);
		}

		const profile = completeCatalog.find(candidate => candidate.id === selection.profileId);
		if (!profile) {
			throw new EditorMigrationPlanningError('targetNotFound', `Migration target '${selection.profileId}' does not exist`);
		}
		if (profile.isInternal || profile.isTransient) {
			throw new EditorMigrationPlanningError('ineligibleTarget', `Migration target '${profile.name}' is internal or transient`);
		}
		const catalogFingerprint = await fingerprintEditorMigrationValue({
			id: profile.id,
			name: profile.name,
			isDefault: profile.isDefault,
			isInternal: !!profile.isInternal,
			isTransient: !!profile.isTransient,
			useDefaultFlags: profile.useDefaultFlags ?? {},
		});
		const snapshots: EditorMigrationTargetCategorySnapshot[] = [];
		for (const category of requestedCategories) {
			throwIfCancelled(token);
			try {
				snapshots.push(await this.readCategory(profile, category, token));
			} catch (error) {
				if (error instanceof CancellationError || error instanceof EditorMigrationPlanningError) {
					throw error;
				}
				throw new EditorMigrationPlanningError('resourceUnavailable', `Target ${category} could not be read`);
			}
		}
		const normalizedBuiltIns = normalizeBuiltIns(builtIns);
		const fingerprint = await fingerprintEditorMigrationValue({ catalogFingerprint, profileId: profile.id, categories: categoryFingerprintInputs(snapshots), environment, builtIns: normalizedBuiltIns });
		return immutableEditorMigrationValue({
			schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
			selection: { kind: 'existing', profileId: profile.id },
			profile: { id: profile.id, name: profile.name, kind: profile.isDefault ? 'default' : 'named' },
			eligible: true,
			catalogFingerprint,
			requestedCategories,
			categories: snapshots,
			environment,
			builtIns: normalizedBuiltIns,
			fingerprint,
		});
	}

	private async inspectProposed(
		selection: Extract<EditorMigrationTargetSelection, { kind: 'proposed' }>,
		categories: readonly EditorMigrationCategory[],
		catalog: readonly IUserDataProfile[],
		catalogFingerprint: string,
		environment: EditorMigrationTargetEnvironment,
		builtIns: readonly EditorMigrationBuiltInExtension[],
	): Promise<EditorMigrationTargetSnapshot> {
		const name = selection.name.trim();
		if (!name) {
			throw new EditorMigrationPlanningError('invalidTarget', 'Proposed migration target name must not be empty');
		}
		const normalizedSelection: EditorMigrationTargetSelection = {
			kind: 'proposed',
			name,
			...(selection.options ? {
				options: {
					...(selection.options.icon ? { icon: selection.options.icon } : {}),
					...(selection.options.useDefaultFlags ? { useDefaultFlags: { ...selection.options.useDefaultFlags } } : {}),
				}
			} : {}),
		};
		const nameAvailable = !catalog.some(profile => profile.name === name);
		const snapshots = await Promise.all(categories.map(emptyTargetCategory));
		const normalizedBuiltIns = normalizeBuiltIns(builtIns);
		const fingerprint = await fingerprintEditorMigrationValue({ catalogFingerprint, selection: normalizedSelection, nameAvailable, categories: categoryFingerprintInputs(snapshots), environment, builtIns: normalizedBuiltIns });
		return immutableEditorMigrationValue({
			schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
			selection: normalizedSelection,
			eligible: true,
			nameAvailable,
			catalogFingerprint,
			requestedCategories: categories,
			categories: snapshots,
			environment,
			builtIns: normalizedBuiltIns,
			fingerprint,
		});
	}

	private async readCategory(profile: IUserDataProfile, category: EditorMigrationCategory, token: CancellationToken): Promise<EditorMigrationTargetCategorySnapshot> {
		const inherited = !profile.isDefault && profile.useDefaultFlags?.[category] === true;
		const owner = inherited ? this.profilesService.defaultProfile : profile;
		switch (category) {
			case 'settings': return await this.readJsonObject(owner.settingsResource, category, owner.id, inherited, token);
			case 'keybindings': return await this.readJsonArray(owner.keybindingsResource, category, owner.id, inherited, token);
			case 'snippets': return await this.readSnippets(owner.snippetsHome, owner.id, inherited, token);
			case 'extensions': return await this.readExtensions(owner, profile, inherited, token);
		}
	}

	private async readJsonObject(resource: URI, category: 'settings', ownerProfileId: string, inherited: boolean, token: CancellationToken): Promise<EditorMigrationTargetCategorySnapshot> {
		const raw = await this.readStableFile(resource, FILE_MAX_BYTES, token);
		if (!raw) {
			return { category, ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'absent', contentHash: await absentHash(category), value: {} };
		}
		const value = parseJson(raw.contents);
		if (!isObject(value)) {
			throw new EditorMigrationPlanningError('resourceUnavailable', 'Target settings must contain a JSON object');
		}
		return { category, ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'present', contentHash: raw.hash, value: value as Record<string, EditorMigrationJsonValue> };
	}

	private async readJsonArray(resource: URI, category: 'keybindings', ownerProfileId: string, inherited: boolean, token: CancellationToken): Promise<EditorMigrationTargetCategorySnapshot> {
		const raw = await this.readStableFile(resource, FILE_MAX_BYTES, token);
		if (!raw) {
			return { category, ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'absent', contentHash: await absentHash(category), value: [] };
		}
		const value = parseJson(raw.contents);
		if (!Array.isArray(value) || !value.every(isObject)) {
			throw new EditorMigrationPlanningError('resourceUnavailable', 'Target keybindings must contain a JSON array of objects');
		}
		return { category, ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'present', contentHash: raw.hash, value: value as Record<string, EditorMigrationJsonValue>[] };
	}

	private async readSnippets(resource: URI, ownerProfileId: string, inherited: boolean, token: CancellationToken): Promise<EditorMigrationTargetCategorySnapshot> {
		let directory;
		try {
			directory = await this.fileService.resolve(resource);
		} catch (error) {
			if (isNotFound(error)) {
				return { category: 'snippets', ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'absent', contentHash: await absentHash('snippets'), value: [] };
			}
			throw error;
		}
		const snippets: EditorMigrationSnippet[] = [];
		let totalBytes = 0;
		for (const child of (directory.children ?? []).filter(child => child.isFile && /\.(?:json|code-snippets)$/i.test(child.name)).sort((a, b) => compare(a.name, b.name))) {
			throwIfCancelled(token);
			const raw = await this.readStableFile(joinPath(resource, child.name), FILE_MAX_BYTES, token);
			if (!raw) {
				throw new EditorMigrationPlanningError('resourceUnavailable', `Target snippet '${child.name}' disappeared during planning read`);
			}
			totalBytes += raw.bytes;
			if (totalBytes > SNIPPETS_MAX_BYTES) {
				throw new EditorMigrationPlanningError('resourceUnavailable', 'Target snippets exceed the planning read limit');
			}
			const contents = parseJson(raw.contents);
			if (!isObject(contents)) {
				throw new EditorMigrationPlanningError('resourceUnavailable', `Target snippet '${child.name}' must contain a JSON object`);
			}
			snippets.push({ name: child.name, contents: contents as Record<string, EditorMigrationJsonValue>, contentHash: raw.hash });
		}
		let after;
		try {
			after = await this.fileService.stat(resource);
		} catch (error) {
			throw new EditorMigrationPlanningError('resourceUnavailable', 'Target snippets changed during planning read');
		}
		if (directory.etag !== after.etag || directory.mtime !== after.mtime || directory.size !== after.size) {
			throw new EditorMigrationPlanningError('resourceUnavailable', 'Target snippets changed during planning read');
		}
		if (snippets.length === 0) {
			return { category: 'snippets', ownership: inherited ? 'default' : 'target', ownerProfileId, state: 'absent', contentHash: await absentHash('snippets'), value: [] };
		}
		return {
			category: 'snippets',
			ownership: inherited ? 'default' : 'target',
			ownerProfileId,
			state: 'present',
			contentHash: await fingerprintEditorMigrationValue(snippets.map(snippet => ({ name: snippet.name, contentHash: snippet.contentHash }))),
			value: snippets,
		};
	}

	private async readExtensions(owner: IUserDataProfile, selectedProfile: IUserDataProfile, inherited: boolean, token: CancellationToken): Promise<EditorMigrationTargetCategorySnapshot> {
		const ownerRaw = await this.readStableFile(owner.extensionsResource, FILE_MAX_BYTES, token);
		const ownerExtensions = ownerRaw ? parseEditorMigrationExtensionManifest(ownerRaw.contents) : [];
		let effective = ownerExtensions;
		if (!selectedProfile.isDefault && !inherited) {
			const defaultRaw = await this.readStableFile(this.profilesService.defaultProfile.extensionsResource, FILE_MAX_BYTES, token);
			const defaultExtensions = defaultRaw ? parseEditorMigrationExtensionManifest(defaultRaw.contents) : [];
			effective = effectiveEditorMigrationExtensions(ownerExtensions, defaultExtensions);
		}
		const semanticHash = await fingerprintEditorMigrationValue(effective.map(extension => ({ id: extension.id, uuid: extension.uuid ?? null, version: extension.version, applicationScoped: extension.applicationScoped })));
		return {
			category: 'extensions',
			ownership: inherited ? 'default' : 'target',
			ownerProfileId: owner.id,
			state: ownerRaw ? 'present' : 'absent',
			contentHash: ownerRaw?.hash ?? await absentHash('extensions'),
			semanticHash,
			value: effective,
		};
	}

	private async readStableFile(resource: URI, maxBytes: number, token: CancellationToken): Promise<{ readonly contents: string; readonly hash: string; readonly bytes: number } | undefined> {
		throwIfCancelled(token);
		let before;
		try {
			before = await this.fileService.stat(resource);
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw error;
		}
		const content = await this.fileService.readFileStream(resource, { limits: { size: maxBytes } }, token);
		const value = await streamToBuffer(content.value);
		throwIfCancelled(token);
		const after = await this.fileService.stat(resource);
		if (before.etag !== after.etag || before.mtime !== after.mtime || before.size !== after.size) {
			throw new EditorMigrationPlanningError('resourceUnavailable', 'Target resource changed during planning read');
		}
		const contents = value.toString();
		return { contents, hash: await sha256Raw(contents), bytes: value.byteLength };
	}
}

function parseJson(contents: string): unknown {
	const errors: ParseError[] = [];
	const value = parse(contents, errors, { allowTrailingComma: true, allowEmptyContent: false });
	if (errors.length) {
		throw new EditorMigrationPlanningError('resourceUnavailable', 'Target resource contains malformed JSON');
	}
	return value;
}

async function sha256Raw(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function categoryFingerprintInputs(categories: readonly EditorMigrationTargetCategorySnapshot[]): unknown {
	return categories.map(category => ({
		category: category.category,
		ownership: category.ownership,
		ownerProfileId: category.ownerProfileId ?? null,
		state: category.state,
		contentHash: (category.category === 'extensions' ? category.semanticHash : category.contentHash) ?? null,
	}));
}

function normalizeBuiltIns(builtIns: readonly EditorMigrationBuiltInExtension[]): EditorMigrationBuiltInExtension[] {
	return [...builtIns].map(extension => ({ ...extension, id: extension.id.toLowerCase() })).sort((a, b) => compare(a.id, b.id));
}

function normalizeCategories(categories: readonly EditorMigrationCategory[]): EditorMigrationCategory[] {
	const order: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];
	return order.filter(category => categories.includes(category));
}

function absentHash(category: EditorMigrationCategory): Promise<string> {
	return fingerprintEditorMigrationValue({ category, state: 'absent' });
}

async function emptyTargetCategory(category: EditorMigrationCategory): Promise<EditorMigrationTargetCategorySnapshot> {
	const base = { ownership: 'target' as const, state: 'absent' as const, contentHash: await absentHash(category) };
	switch (category) {
		case 'settings': return { ...base, category, value: {} };
		case 'keybindings': return { ...base, category, value: [] };
		case 'snippets': return { ...base, category, value: [] };
		case 'extensions': return { ...base, category, value: [] };
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && (
		(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)
		|| toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND
	);
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}
