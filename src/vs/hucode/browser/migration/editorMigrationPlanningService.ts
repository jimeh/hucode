/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { platform, Platform } from '../../../base/common/platform.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { TargetPlatform } from '../../../platform/extensions/common/extensions.js';
import { getTargetPlatform, IExtensionGalleryService, IProductVersion } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionsScannerService } from '../../../platform/extensionManagement/common/extensionsScannerService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { getDefaultIgnoredSettings, IUserDataSyncUtilService } from '../../../platform/userDataSync/common/userDataSync.js';
import { EditorMigrationCategory, EditorMigrationSourceSnapshot, IEditorMigrationSourceService } from '../../common/migration/editorMigrationSource.js';
import {
	EDITOR_MIGRATION_POLICY_VERSION,
	EditorMigrationBuiltInExtension,
	EditorMigrationGalleryResult,
	EditorMigrationPlanChoices,
	EditorMigrationPlanDraft,
	EditorMigrationPlanningError,
	EditorMigrationPlanningEvidence,
	EditorMigrationPlanVerification,
	EditorMigrationReviewedPlan,
	EditorMigrationTargetEnvironment,
	EditorMigrationTargetSelection,
	EditorMigrationTargetSnapshot,
	IEditorMigrationPlanningService,
} from '../../common/migration/editorMigrationPlanning.js';
import { compareEditorMigrationCodePoints as compare, fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import {
	acceptEditorMigrationPlanDraft,
	createEditorMigrationPlanDraft,
	editorMigrationGalleryEvidence,
	editorMigrationPolicyEvidence,
	editorMigrationSourceEvidence,
	editorMigrationTargetEvidence,
	isEditorMigrationSourceIntegrationExtension,
} from '../../common/migration/editorMigrationPlanner.js';
import { EditorMigrationTargetReader } from './editorMigrationTargetReader.js';

/** Desktop planning coordinator. Every collaborator is read-only. */
export class EditorMigrationPlanningService implements IEditorMigrationPlanningService {
	declare readonly _serviceBrand: undefined;

	private readonly targetReader: EditorMigrationTargetReader;

	constructor(
		@IFileService fileService: IFileService,
		@IUserDataProfilesService profilesService: IUserDataProfilesService,
		@IExtensionsScannerService private readonly extensionsScannerService: IExtensionsScannerService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IUserDataSyncUtilService private readonly userDataSyncUtilService: IUserDataSyncUtilService,
		@IProductService private readonly productService: IProductService,
		@IEditorMigrationSourceService private readonly sourceService: IEditorMigrationSourceService,
	) {
		this.targetReader = new EditorMigrationTargetReader(fileService, profilesService);
	}

	async inspectTarget(selection: EditorMigrationTargetSelection, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationTargetSnapshot> {
		throwIfCancelled(token);
		let builtIns: EditorMigrationBuiltInExtension[] = [];
		if (categories.includes('extensions')) {
			const scanned = await this.extensionsScannerService.scanSystemExtensions({});
			throwIfCancelled(token);
			builtIns = scanned.map<EditorMigrationBuiltInExtension>(extension => ({
				id: extension.identifier.id,
				...(extension.identifier.uuid ? { uuid: extension.identifier.uuid } : {}),
				version: extension.manifest.version,
			}));
		}
		return await this.targetReader.inspect(selection, categories, this.environment(), builtIns, token);
	}

	createDraft(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, evidence: EditorMigrationPlanningEvidence): EditorMigrationPlanDraft {
		return createEditorMigrationPlanDraft(source, target, evidence);
	}

	async createDraftFromCurrentEvidence(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, token: CancellationToken): Promise<EditorMigrationPlanDraft> {
		return this.createDraft(source, target, await this.collectEvidence(source, target, target.requestedCategories, token));
	}

	acceptDraft(draft: EditorMigrationPlanDraft, choices: EditorMigrationPlanChoices): Promise<EditorMigrationReviewedPlan> {
		return acceptEditorMigrationPlanDraft(draft, choices);
	}

	async verifyPlan(plan: EditorMigrationReviewedPlan, token: CancellationToken): Promise<EditorMigrationPlanVerification> {
		throwIfCancelled(token);
		const reasons = new Set<EditorMigrationPlanVerification['reasons'][number]>();
		const selectedCategories = plan.choices.selectedCategories;
		let currentSource: EditorMigrationSourceSnapshot;
		try {
			currentSource = await this.sourceService.readSourceProfile(plan.source.ref, selectedCategories, token);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			return { status: 'unavailable', reasons: ['sourceUnavailable'] };
		}
		if (await fingerprintEditorMigrationValue(editorMigrationSourceEvidence(currentSource, selectedCategories)) !== plan.fingerprints.source) {
			reasons.add('sourceChanged');
		}

		let currentTarget: EditorMigrationTargetSnapshot;
		try {
			currentTarget = await this.inspectTarget(plan.target.selection, selectedCategories, token);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			return { status: 'unavailable', reasons: [plan.target.selection.kind === 'proposed' ? 'proposedNameChanged' : 'targetContentChanged'] };
		}
		if (currentTarget.catalogFingerprint !== plan.target.catalogFingerprint) {
			reasons.add(plan.target.selection.kind === 'proposed' ? 'proposedNameChanged' : 'profileCatalogChanged');
		}
		if (currentTarget.environment.targetPlatform !== plan.target.environment.targetPlatform
			|| currentTarget.environment.productVersion !== plan.target.environment.productVersion
			|| currentTarget.environment.productDate !== plan.target.environment.productDate
			|| currentTarget.environment.hucodeVersion !== plan.target.environment.hucodeVersion
			|| currentTarget.environment.galleryIdentity !== plan.target.environment.galleryIdentity) {
			reasons.add('environmentChanged');
		}
		for (const reviewed of plan.target.categories.filter(category => selectedCategories.includes(category.category))) {
			const current = currentTarget.categories.find(category => category.category === reviewed.category);
			if (!current || current.ownership !== reviewed.ownership || current.ownerProfileId !== reviewed.ownerProfileId) {
				reasons.add('targetOwnershipChanged');
				continue;
			}
			const reviewedHash = reviewed.category === 'extensions' ? reviewed.semanticHash : reviewed.contentHash;
			const currentHash = current.category === 'extensions' ? current.semanticHash : current.contentHash;
			if (reviewedHash !== currentHash || reviewed.state !== current.state) {
				reasons.add('targetContentChanged');
			}
		}

		if (await fingerprintEditorMigrationValue(editorMigrationTargetEvidence(currentTarget, selectedCategories)) !== plan.fingerprints.target
			&& !reasons.has('targetOwnershipChanged') && !reasons.has('targetContentChanged') && !reasons.has('profileCatalogChanged') && !reasons.has('proposedNameChanged') && !reasons.has('environmentChanged')) {
			reasons.add('targetContentChanged');
		}

		let currentEvidence: EditorMigrationPlanningEvidence;
		try {
			currentEvidence = await this.collectEvidence(currentSource, currentTarget, selectedCategories, token);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			return { status: 'unavailable', reasons: [selectedCategories.includes('extensions') ? 'galleryChanged' : 'policyChanged'] };
		}
		const reviewedPolicy = await fingerprintEditorMigrationValue(editorMigrationPolicyEvidence(plan.evidence, plan.target.environment.policyVersion, selectedCategories));
		const currentPolicy = await fingerprintEditorMigrationValue(editorMigrationPolicyEvidence(currentEvidence, currentTarget.environment.policyVersion, selectedCategories));
		if (reviewedPolicy !== plan.fingerprints.policy || currentPolicy !== plan.fingerprints.policy) {
			reasons.add('policyChanged');
		}
		if (await fingerprintEditorMigrationValue(plan.choices) !== plan.fingerprints.choices) {
			reasons.add('choicesChanged');
		}
		if (await fingerprintEditorMigrationValue(editorMigrationGalleryEvidence(currentEvidence, selectedCategories)) !== plan.fingerprints.gallery) {
			reasons.add('galleryChanged');
		}
		try {
			if (!await this.verifyExactGallery(editorMigrationGalleryEvidence(plan.evidence, selectedCategories), currentTarget, token)) {
				reasons.add('galleryChanged');
			}
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			return { status: 'unavailable', reasons: ['galleryChanged'] };
		}

		return { status: reasons.size ? 'changed' : 'unchanged', reasons: [...reasons].sort(compare) };
	}

	private async collectEvidence(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationPlanningEvidence> {
		throwIfCancelled(token);
		const rawKeys = new Set<string>();
		for (const category of categories.includes('keybindings') ? source.categories : []) {
			if (category.category === 'keybindings') {
				for (const entry of category.value ?? []) {
					if (typeof entry.key === 'string') {
						rawKeys.add(entry.key);
					}
				}
			}
		}
		for (const category of categories.includes('keybindings') ? target.categories : []) {
			if (category.category === 'keybindings') {
				for (const entry of category.value ?? []) {
					if (typeof entry.key === 'string') {
						rawKeys.add(entry.key);
					}
				}
			}
		}
		const keys = [...rawKeys].sort(compare);
		const normalizedKeys = keys.length ? await this.userDataSyncUtilService.resolveUserBindings(keys) : {};
		throwIfCancelled(token);
		return {
			registryIgnoredSettings: categories.includes('settings') ? getDefaultIgnoredSettings().sort(compare) : [],
			normalizedKeys,
			keybindingPlatform: categories.includes('keybindings') ? platformName(platform) : '',
			gallery: categories.includes('extensions') ? await this.collectGalleryEvidence(source, target, token) : [],
		};
	}

	private async collectGalleryEvidence(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, token: CancellationToken): Promise<EditorMigrationGalleryResult[]> {
		try {
			return await this.collectGallery(source, target, token);
		} catch (error) {
			if (error instanceof CancellationError || error instanceof EditorMigrationPlanningError) {
				throw error;
			}
			throw new EditorMigrationPlanningError('galleryUnavailable', 'The configured extension gallery could not be queried');
		}
	}

	private async collectGallery(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, token: CancellationToken): Promise<EditorMigrationGalleryResult[]> {
		const sourceExtensions = source.categories.find(category => category.category === 'extensions');
		if (!sourceExtensions || sourceExtensions.category !== 'extensions' || !sourceExtensions.value?.length) {
			return [];
		}
		if (!this.extensionGalleryService.isEnabled()) {
			throw new EditorMigrationPlanningError('galleryUnavailable', 'The configured extension gallery is disabled');
		}
		const targetPlatform = target.environment.targetPlatform as TargetPlatform;
		const productVersion: IProductVersion = { version: target.environment.productVersion, date: target.environment.productDate };
		const results: EditorMigrationGalleryResult[] = [];
		const builtIns = new Set(target.builtIns.map(extension => extension.id.toLowerCase()));
		const installed = new Set(target.categories.find(category => category.category === 'extensions')?.value?.map(extension => extension.id.toLowerCase()) ?? []);
		for (const extension of deduplicateSourceExtensions(sourceExtensions.value).filter(extension =>
			!isEditorMigrationSourceIntegrationExtension(extension.id)
			&& !builtIns.has(extension.id.toLowerCase())
			&& !installed.has(extension.id.toLowerCase())
		)) {
			throwIfCancelled(token);
			const requestedChannel = extension.preRelease ? 'preRelease' : 'stable';
			const found = (await this.extensionGalleryService.getExtensions([{
				id: extension.id,
				preRelease: extension.preRelease === true,
				hasPreRelease: extension.hasPreReleaseVersion === true,
			}], { compatible: false, productVersion, targetPlatform }, token))[0];
			throwIfCancelled(token);
			if (!found) {
				results.push({ id: extension.id, requestedChannel, status: 'unavailable' });
				continue;
			}
			const compatible = await this.extensionGalleryService.getCompatibleExtension(found, extension.preRelease === true, targetPlatform, productVersion);
			throwIfCancelled(token);
			if (!compatible) {
				results.push({ id: extension.id, requestedChannel, status: 'incompatible' });
				continue;
			}
			results.push({
				id: extension.id.toLowerCase(),
				requestedChannel,
				status: 'available',
				...(compatible.identifier.uuid ? { uuid: compatible.identifier.uuid } : {}),
				version: compatible.version,
				targetPlatform: compatible.properties.targetPlatform,
				selectedChannel: compatible.properties.isPreReleaseVersion ? 'preRelease' : 'stable',
				engine: compatible.properties.engine ?? '*',
				galleryIdentity: target.environment.galleryIdentity,
			});
		}
		return results.sort((a, b) => compare(a.id, b.id));
	}

	private async verifyExactGallery(results: readonly EditorMigrationGalleryResult[], target: EditorMigrationTargetSnapshot, token: CancellationToken): Promise<boolean> {
		const productVersion: IProductVersion = { version: target.environment.productVersion, date: target.environment.productDate };
		const targetPlatform = target.environment.targetPlatform as TargetPlatform;
		for (const result of results) {
			if (result.status !== 'available') {
				continue;
			}
			throwIfCancelled(token);
			const exact = (await this.extensionGalleryService.getExtensions([{ id: result.id, version: result.version, preRelease: result.selectedChannel === 'preRelease' }], {
				compatible: false,
				productVersion,
				targetPlatform,
			}, token))[0];
			if (!exact || exact.version !== result.version || exact.properties.targetPlatform !== result.targetPlatform
				|| !await this.extensionGalleryService.isExtensionCompatible(exact, result.selectedChannel === 'preRelease', targetPlatform, productVersion)) {
				return false;
			}
		}
		return true;
	}

	private environment(): EditorMigrationTargetEnvironment {
		const targetPlatform = getTargetPlatform(platform, process.arch) ?? TargetPlatform.UNKNOWN;
		return {
			targetPlatform,
			productVersion: this.productService.version,
			...(this.productService.date ? { productDate: this.productService.date } : {}),
			hucodeVersion: this.productService.hucodeVersion ?? this.productService.version,
			galleryIdentity: this.productService.extensionsGallery?.serviceUrl ?? 'disabled',
			policyVersion: EDITOR_MIGRATION_POLICY_VERSION,
		};
	}
}

function deduplicateSourceExtensions<T extends { readonly id: string }>(extensions: readonly T[]): T[] {
	const result = new Map<string, T>();
	for (const extension of extensions) {
		const id = extension.id.toLowerCase();
		if (!result.has(id)) {
			result.set(id, extension);
		}
	}
	return [...result.values()].sort((a, b) => compare(a.id, b.id));
}

function platformName(value: Platform): string {
	switch (value) {
		case Platform.Windows: return 'windows';
		case Platform.Mac: return 'mac';
		case Platform.Linux: return 'linux';
		case Platform.Web: return 'web';
	}
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

registerSingleton(IEditorMigrationPlanningService, EditorMigrationPlanningService, InstantiationType.Delayed);
