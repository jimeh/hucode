/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IExtensionGalleryService, ILocalExtension, IProductVersion } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { isApplicationScopedExtension, TargetPlatform } from '../../../platform/extensions/common/extensions.js';
import { FileOperationResult, FileSystemProviderCapabilities, IFileService, toFileOperationResult } from '../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IUserDataProfile, IUserDataProfilesService, UseDefaultProfileFlags } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { IExtensionManagementServerService, IProfileAwareExtensionManagementService } from '../../../workbench/services/extensionManagement/common/extensionManagement.js';
import {
	EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
	EditorMigrationApplyAuthorization,
	EditorMigrationApplyError,
	EditorMigrationApplyProgressReporter,
	EditorMigrationApplyAuthorizationIssuer,
	EditorMigrationConsumedAuthorization,
	EditorMigrationItemOutcome,
	EditorMigrationItemResult,
	EditorMigrationOperation,
	EditorMigrationOperationResult,
	EditorMigrationOperationSummary,
	EditorMigrationProfileFlags,
	EditorMigrationRollbackIntent,
	EditorMigrationRollbackInspection,
	EditorMigrationRollbackOptions,
	EditorMigrationRollbackResourceProgress,
	EditorMigrationSnapshotManifestEntry,
	IEditorMigrationApplyService,
	createEditorMigrationOperationIntegrity,
	deriveEditorMigrationAggregateOutcome,
	reduceEditorMigrationKeybindings,
	reduceEditorMigrationSettings,
	toEditorMigrationApplyProgress,
} from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationCategory } from '../../common/migration/editorMigrationSource.js';
import { effectiveEditorMigrationExtensions, parseEditorMigrationExtensionManifest } from '../../common/migration/editorMigrationExtensionManifest.js';
import { EditorMigrationInstallExtensionOperation, EditorMigrationKeybindingOperation, EditorMigrationReviewedPlan, EditorMigrationTargetCategorySnapshot, IEditorMigrationPlanningService } from '../../common/migration/editorMigrationPlanning.js';
import { fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import { EditorMigrationOperationStore } from './editorMigrationOperationStore.js';

const CATEGORY_ORDER: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];

interface EditorMigrationRollbackObservation {
	readonly progress: EditorMigrationRollbackResourceProgress;
	readonly current: { readonly value: VSBuffer; readonly mtime: number; readonly etag: string } | undefined;
	readonly currentHash: string;
	readonly drifted: boolean;
}

interface EditorMigrationRollbackInspectionEvidence {
	readonly inspection: EditorMigrationRollbackInspection;
	readonly observations: readonly EditorMigrationRollbackObservation[];
}

/** Desktop Apply coordinator with durable per-boundary checkpoints. */
export class EditorMigrationApplyService implements IEditorMigrationApplyService {
	declare readonly _serviceBrand: undefined;

	private readonly authorizationIssuer = new EditorMigrationApplyAuthorizationIssuer();
	private readonly store: EditorMigrationOperationStore;
	private activeLeaseOwner: string | undefined;
	private leaseCallActive = false;
	private progressReporter: EditorMigrationApplyProgressReporter | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfilesService private readonly profilesService: IUserDataProfilesService,
		@IEditorMigrationPlanningService private readonly planningService: IEditorMigrationPlanningService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IHucodeShellControllerService private readonly shellControllerService: IHucodeShellControllerService,
		@ILogService private readonly logService: ILogService,
	) {
		this.store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
	}

	createApplyAuthorization(plan: EditorMigrationReviewedPlan, confirmedPublishers: readonly string[]): Promise<EditorMigrationApplyAuthorization> {
		return this.authorizationIssuer.create(plan, confirmedPublishers);
	}

	async apply(plan: EditorMigrationReviewedPlan, authorization: EditorMigrationApplyAuthorization, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult> {
		return await this.withProgressReporter(reporter, async () => {
			throwIfCancelled(token);
			const consumed = await this.authorizationIssuer.consume(plan, authorization);
			throwIfCancelled(token);
			return await this.withLease(async () => {
				let operation: EditorMigrationOperation | undefined;
				try {
					const verification = await this.planningService.verifyPlan(plan, token);
					if (verification.status !== 'unchanged') {
						throw new EditorMigrationApplyError('planDrift', `Reviewed migration plan is no longer current: ${verification.reasons.join(', ')}`);
					}
					throwIfCancelled(token);
					operation = await this.newOperation(plan, consumed);
					await this.assertWriterLease();
					try {
						await this.store.create(operation);
					} catch (error) {
						throw new EditorMigrationApplyError('journalUnavailable', `Editor migration journal could not be created: ${errorMessage(error)}`);
					}
					this.reportProgress(operation);
					operation = await this.attachTarget(operation);
					operation = await this.snapshotSelectedCategories(operation, token);
					operation = await this.materializeInheritedCategories(operation, token);
					return await this.execute(operation, token);
				} catch (error) {
					if (operation && isCancellationError(error)) {
						return await this.finishCancellation(await this.store.read(operation.id));
					}
					throw error;
				}
			});
		});
	}

	getOperation(operationId: string): Promise<EditorMigrationOperation> {
		return this.store.read(operationId);
	}

	async listRecoverableOperations(): Promise<readonly EditorMigrationOperationSummary[]> {
		const result: EditorMigrationOperationSummary[] = [];
		for (const summary of await this.store.list()) {
			if (summary.unsupportedSchemaVersion !== undefined) {
				result.push(summary);
				continue;
			}
			const operation = await this.store.read(summary.id);
			if (operation.acknowledged) {
				try {
					await this.withLease(async () => {
						const current = await this.store.read(operation.id);
						if (!current.acknowledged) {
							return;
						}
						await this.assertWriterLease();
						await this.store.delete(current.id);
					});
				} catch (error) {
					this.logService.debug(`Deferred acknowledged editor migration cleanup: ${errorMessage(error)}`);
				}
			} else if (summary.recoverable) {
				result.push(summary);
			}
		}
		return result;
	}

	async resume(operationId: string, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult> {
		return await this.withProgressReporter(reporter, async () => await this.withLease(async () => {
			let operation = await this.store.read(operationId);
			try {
				if ((operation.stage === 'rolledBack' || operation.stage === 'settled') && operation.aggregateOutcome) {
					operation = await this.reproveTarget(operation);
					return resultOf(operation);
				}
				operation = await this.reproveTarget(operation);
				if (operation.stage === 'rollbackPending') {
					if (!operation.rollbackIntent) {
						throw new Error('Migration rollback journal has no durable intent');
					}
					return await this.continueRollback(operation, token);
				}
				operation = await this.resumePreparation(operation, token);
				return await this.execute(operation, token);
			} catch (error) {
				if (isCancellationError(error)) {
					const current = await this.store.read(operationId);
					if (current.stage === 'rollbackPending' && current.rollbackIntent) {
						return await this.settleRollbackCancellation(current);
					}
					return await this.finishCancellation(await this.store.read(operationId));
				}
				throw error;
			}
		}));
	}

	async retry(operationId: string, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult> {
		return await this.withProgressReporter(reporter, async () => await this.withLease(async () => {
			let operation = await this.store.read(operationId);
			if (operation.stage === 'rollbackPending') {
				throw new Error('Rollback is pending; use resume or repeat the exact rollback request');
			}
			if (operation.rollbackIntent?.mutationStarted) {
				throw new Error('A migration with a partially completed rollback cannot resume forward Apply');
			}
			if (operation.stage === 'rolledBack') {
				throw new Error('A rolled-back migration operation cannot be retried');
			}
			try {
				const retryItemIds = operation.results.filter(result => ['failed', 'unavailable', 'canceled'].includes(result.outcome)).map(result => result.id);
				const restartStage = preparationRestartStage(operation);
				operation = await this.reproveTarget(operation);
				operation = await this.save(operation, {
					...operation,
					stage: restartStage,
					aggregateOutcome: undefined,
					cancellationRequested: false,
					retryItemIds,
				});
				operation = await this.resumePreparation(operation, token);
				return await this.execute(operation, token);
			} catch (error) {
				if (isCancellationError(error)) {
					return await this.finishCancellation(await this.store.read(operationId));
				}
				throw error;
			}
		}));
	}

	async inspectRollback(operationId: string, categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): Promise<EditorMigrationRollbackInspection> {
		const operation = await this.store.read(operationId);
		return (await this.rollbackInspectionEvidence(operation, uniqueFileCategories(categories))).inspection;
	}

	async rollback(operationId: string, options: EditorMigrationRollbackOptions, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult> {
		return await this.withProgressReporter(reporter, async () => await this.withLease(async () => {
			let operation = await this.store.read(operationId);
			operation = await this.reproveTarget(operation);
			if (operation.rollbackIntent?.mutationStarted && operation.stage !== 'rollbackPending') {
				throw new Error('A migration with a partially completed rollback cannot start another rollback');
			}
			if ((options.categories as readonly string[]).includes('extensions')) {
				throw new Error('Extension rollback is not supported');
			}
			const categories = uniqueFileCategories(options.categories);
			if (!categories.length) {
				throw new Error('At least one rollback category is required');
			}
			const force = new Set(options.forceCategories ?? []);
			if ([...force].some(category => !categories.includes(category))) {
				throw new Error('Force rollback categories must be included in the requested rollback');
			}
			if (operation.stage === 'rollbackPending' && operation.rollbackIntent) {
				const sameRequest = sameCategories(categories, operation.rollbackIntent.categories) && sameCategories([...force], operation.rollbackIntent.forceCategories);
				if (sameRequest) {
					return await this.continueRollback(operation, token);
				}
				if (operation.rollbackIntent.mutationStarted) {
					throw new Error('Requested rollback does not match the durable pending rollback');
				}
			}
			const profile = this.requireAttachedProfile(operation);
			for (const category of categories) {
				if (!operation.plan.choices.selectedCategories.includes(category)) {
					throw new Error(`Cannot roll back unselected ${category}`);
				}
				if (!operation.snapshots.some(snapshot => snapshot.category === category && snapshot.postApplyHash)) {
					throw new Error(`Cannot roll back ${category} because Apply did not prove a mutated postcondition`);
				}
			}
			const evidence = await this.rollbackInspectionEvidence(operation, categories);
			if (options.inspectionFingerprint && options.inspectionFingerprint !== evidence.inspection.fingerprint) {
				throw new EditorMigrationApplyError('rollbackDrift', 'Migration rollback target changed after inspection');
			}
			if (evidence.inspection.driftedCategories.some(category => !force.has(category))) {
				throw new EditorMigrationApplyError('rollbackDrift', `Migration rollback refused because ${evidence.inspection.driftedCategories.join(', ')} changed after Apply; inspect and confirm force rollback to continue`);
			}
			if (force.size && options.inspectionFingerprint !== evidence.inspection.fingerprint) {
				throw new EditorMigrationApplyError('rollbackDrift', 'Force rollback requires a current inspection confirmation');
			}
			const inherited = categories.filter(category => operation.snapshots.some(snapshot => snapshot.category === category && snapshot.ownership === 'default'));
			const resources: EditorMigrationRollbackResourceProgress[] = [];
			const driftSnapshots = [...operation.rollbackDriftSnapshots];
			for (const observed of evidence.observations) {
				let progress: EditorMigrationRollbackResourceProgress = {
					...observed.progress,
					state: observed.currentHash === observed.progress.expectedRestoredHash ? 'restored' : 'pending',
				};
				if (observed.drifted) {
					const payload = observed.current?.value ?? VSBuffer.alloc(0);
					const snapshotPath = await this.writeOperationSnapshot(operation.id, `drift/${observed.progress.category}-${operation.revision}-${encodeURIComponent(observed.progress.item ?? 'category')}`, payload);
					progress = { ...progress, forceSnapshotPath: snapshotPath, forceObservedHash: observed.currentHash };
					driftSnapshots.push({ category: progress.category, item: progress.item, resource: progress.resource, snapshotPath, byteHash: await sha256(payload) });
				}
				resources.push(progress);
			}
			const beforeFlags = profileFlags(profile);
			const afterFlags = { ...beforeFlags };
			for (const category of inherited) {
				afterFlags[category] = true;
			}
			const rollbackIntent: EditorMigrationRollbackIntent = {
				categories,
				forceCategories: [...force],
				beforeFlags,
				afterFlags,
				ownershipState: 'pending',
				mutationStarted: false,
				resources,
			};
			operation = await this.save(operation, { ...operation, stage: 'rollbackPending', aggregateOutcome: 'recoverable', cancellationRequested: false, rollbackDriftSnapshots: driftSnapshots, rollbackIntent });
			return await this.continueRollback(operation, token);
		}));
	}

	private async rollbackInspectionEvidence(operation: EditorMigrationOperation, requestedCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): Promise<EditorMigrationRollbackInspectionEvidence> {
		const eligibleCategories = uniqueFileCategories(operation.plan.choices.selectedCategories.filter((category): category is Exclude<EditorMigrationCategory, 'extensions'> => category !== 'extensions' && operation.snapshots.some(snapshot => snapshot.category === category && snapshot.postApplyHash)));
		if (requestedCategories.some(category => !eligibleCategories.includes(category))) {
			throw new Error('Rollback inspection includes a category without a proven Apply mutation');
		}
		const observations: EditorMigrationRollbackObservation[] = [];
		for (const category of requestedCategories) {
			for (const entry of operation.snapshots.filter(snapshot => snapshot.category === category && snapshot.postApplyHash)) {
				if (entry.category === 'snippets' && !entry.item) {
					continue;
				}
				const progress: EditorMigrationRollbackResourceProgress = {
					category,
					item: entry.item,
					resource: entry.resource,
					expectedPostApplyHash: entry.postApplyHash!,
					expectedRestoredHash: entry.ownership === 'default'
						? entry.hiddenOwnedByteHash ?? await absentHash(category)
						: entry.state === 'absent' ? await absentHash(category) : entry.byteHash,
					state: 'pending',
				};
				const current = await this.readRaw(URI.parse(progress.resource));
				const currentHash = current ? await sha256(current.value) : await absentHash(category);
				observations.push({
					progress,
					current,
					currentHash,
					drifted: currentHash !== progress.expectedPostApplyHash && currentHash !== progress.expectedRestoredHash,
				});
			}
		}
		const driftedCategories = uniqueFileCategories(observations.filter(observation => observation.drifted).map(observation => observation.progress.category));
		const fingerprint = await fingerprintEditorMigrationValue({
			operationId: operation.id,
			operationRevision: operation.revision,
			requestedCategories,
			observations: observations.map(observation => ({
				category: observation.progress.category,
				item: observation.progress.item ?? null,
				resource: observation.progress.resource,
				currentHash: observation.currentHash,
				expectedPostApplyHash: observation.progress.expectedPostApplyHash,
				expectedRestoredHash: observation.progress.expectedRestoredHash,
			})),
		});
		return {
			inspection: Object.freeze({ operationId: operation.id, operationRevision: operation.revision, eligibleCategories, driftedCategories, fingerprint }),
			observations,
		};
	}

	private async continueRollback(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperationResult> {
		let intent = operation.rollbackIntent;
		if (!intent) {
			throw new Error('Migration rollback journal has no durable intent');
		}
		if (token.isCancellationRequested) {
			return await this.settleRollbackCancellation(operation);
		}

		// Preflight the complete restore set before changing ownership or restoring data.
		for (const progress of intent.resources.filter(resource => resource.state === 'pending')) {
			const current = await this.readRaw(URI.parse(progress.resource));
			const currentHash = current ? await sha256(current.value) : await absentHash(progress.category);
			if (currentHash === progress.expectedRestoredHash) {
				operation = await this.updateRollbackResource(operation, progress, { ...progress, state: 'restored' });
				intent = operation.rollbackIntent!;
				continue;
			}
			if (currentHash === progress.expectedPostApplyHash || (progress.forceObservedHash !== undefined && currentHash === progress.forceObservedHash)) {
				continue;
			}
			const message = `Migration rollback refused because ${progress.category} changed after inspection`;
			if (intent.mutationStarted) {
				return await this.settleRollbackRefusal(operation, message);
			}
			return await this.rejectRollbackBeforeMutation(operation, message);
		}

		if (token.isCancellationRequested) {
			return await this.settleRollbackCancellation(operation);
		}
		const profile = this.requireAttachedProfile(operation);
		if (!profile.isDefault && intent.ownershipState === 'pending') {
			const matchesBefore = flagsMatch(profile, intent.beforeFlags);
			const matchesAfter = flagsMatch(profile, intent.afterFlags);
			if (!matchesBefore && !matchesAfter) {
				throw new Error('Migration rollback profile ownership changed');
			}
			if (matchesBefore && !sameFlags(intent.beforeFlags, intent.afterFlags)) {
				operation = await this.markRollbackMutationStarted(operation);
				intent = operation.rollbackIntent!;
				await this.assertWriterLease();
				await this.profilesService.updateProfile(profile, { useDefaultFlags: flagsToUseDefault(intent.afterFlags) });
			}
			const updatedProfile = this.requireAttachedProfile(operation);
			if (!flagsMatch(updatedProfile, intent.afterFlags)) {
				throw new Error('Migration rollback profile ownership update was not durable');
			}
			operation = await this.save(operation, { ...operation, rollbackIntent: { ...intent, ownershipState: 'restored' } });
			intent = operation.rollbackIntent!;
		}

		if (token.isCancellationRequested) {
			return await this.settleRollbackCancellation(operation);
		}
		for (const progress of intent.resources.filter(resource => resource.state === 'pending')) {
			const current = await this.readRaw(URI.parse(progress.resource));
			const currentHash = current ? await sha256(current.value) : await absentHash(progress.category);
			if (currentHash !== progress.expectedRestoredHash) {
				if (currentHash !== progress.expectedPostApplyHash && !progress.forceSnapshotPath) {
					const message = `Migration rollback refused because ${progress.category} changed after preflight`;
					return intent.mutationStarted ? await this.settleRollbackRefusal(operation, message) : await this.rejectRollbackBeforeMutation(operation, message);
				}
				if (progress.forceObservedHash && currentHash !== progress.forceObservedHash) {
					const message = `Migration rollback refused because ${progress.category} changed after its force snapshot`;
					return intent.mutationStarted ? await this.settleRollbackRefusal(operation, message) : await this.rejectRollbackBeforeMutation(operation, message);
				}
				operation = await this.markRollbackMutationStarted(operation);
				intent = operation.rollbackIntent!;
				const entry = findRollbackSnapshot(operation, progress);
				await this.restoreSnapshot(operation, entry, URI.parse(progress.resource));
				const restored = await this.readRaw(URI.parse(progress.resource));
				const restoredHash = restored ? await sha256(restored.value) : await absentHash(progress.category);
				if (restoredHash !== progress.expectedRestoredHash) {
					throw new Error(`Migration rollback failed to restore ${progress.category}`);
				}
			}
			operation = await this.updateRollbackResource(operation, progress, { ...progress, state: 'restored' });
			intent = operation.rollbackIntent!;
			if (token.isCancellationRequested) {
				return await this.settleRollbackCancellation(operation);
			}
		}

		for (const category of intent.categories) {
			operation = await this.recordResult(operation, category, category, 'completed');
		}
		operation = await this.save(operation, { ...operation, stage: 'rolledBack', aggregateOutcome: 'rolledBack', cancellationRequested: false });
		return resultOf(operation);
	}

	private async markRollbackMutationStarted(operation: EditorMigrationOperation): Promise<EditorMigrationOperation> {
		if (!operation.rollbackIntent || operation.rollbackIntent.mutationStarted) {
			return operation;
		}
		return await this.save(operation, { ...operation, rollbackIntent: { ...operation.rollbackIntent, mutationStarted: true } });
	}

	private async rejectRollbackBeforeMutation(operation: EditorMigrationOperation, message: string): Promise<never> {
		await this.save(operation, {
			...operation,
			stage: 'settled',
			aggregateOutcome: aggregateForwardResults(operation),
			cancellationRequested: false,
			rollbackIntent: undefined,
		});
		throw new EditorMigrationApplyError('rollbackDrift', message);
	}

	private async settleRollbackRefusal(operation: EditorMigrationOperation, message: string): Promise<EditorMigrationOperationResult> {
		const intent = operation.rollbackIntent;
		if (!intent?.mutationStarted) {
			throw new Error('A rollback refusal can settle only after a durable mutation has started');
		}
		for (const category of intent.categories) {
			const resources = intent.resources.filter(resource => resource.category === category);
			const restoredCount = resources.filter(resource => resource.state === 'restored').length;
			if (restoredCount === resources.length) {
				operation = await this.recordResult(operation, category, category, 'completed');
			} else {
				operation = await this.recordResult(operation, category, category, 'failed', 'rollbackDrift', `${message}; restored ${restoredCount} of ${resources.length} resources`);
			}
		}
		operation = await this.save(operation, { ...operation, stage: 'settled', aggregateOutcome: 'completedWithIssues', cancellationRequested: false });
		return resultOf(operation);
	}

	private async updateRollbackResource(
		operation: EditorMigrationOperation,
		previous: EditorMigrationRollbackResourceProgress,
		next: EditorMigrationRollbackResourceProgress,
		drift?: EditorMigrationOperation['rollbackDriftSnapshots'][number],
	): Promise<EditorMigrationOperation> {
		const intent = operation.rollbackIntent!;
		const resources = intent.resources.map(resource => sameRollbackResource(resource, previous) ? next : resource);
		return await this.save(operation, {
			...operation,
			rollbackIntent: { ...intent, resources },
			rollbackDriftSnapshots: drift ? [...operation.rollbackDriftSnapshots, drift] : operation.rollbackDriftSnapshots,
		});
	}

	private async settleRollbackCancellation(operation: EditorMigrationOperation): Promise<EditorMigrationOperationResult> {
		operation = await this.save(operation, { ...operation, stage: 'rollbackPending', aggregateOutcome: 'recoverable', cancellationRequested: true });
		return resultOf(operation);
	}

	async acknowledge(operationId: string): Promise<void> {
		await this.withLease(async () => {
			const operation = await this.store.read(operationId);
			if (!operation.aggregateOutcome || (operation.stage !== 'settled' && operation.stage !== 'rolledBack')) {
				throw new Error(`Cannot acknowledge migration operation in ${operation.stage}`);
			}
			await this.save(operation, { ...operation, acknowledged: true });
			await this.assertWriterLease();
			await this.store.delete(operationId);
		});
	}

	private async newOperation(plan: EditorMigrationReviewedPlan, authorization: EditorMigrationConsumedAuthorization): Promise<EditorMigrationOperation> {
		const now = Date.now();
		return {
			schemaVersion: EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
			id: generateUuid(),
			revision: 0,
			createdAt: now,
			updatedAt: now,
			plan,
			integrity: await createEditorMigrationOperationIntegrity(plan),
			authorization,
			stage: 'admitted',
			cancellationRequested: false,
			target: { state: 'pending' },
			snapshots: [],
			snapshotCompletedCategories: [],
			extensionInstallIntents: [],
			retryItemIds: [],
			rollbackDriftSnapshots: [],
			results: [],
			acknowledged: false,
		};
	}

	private async resumePreparation(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperation> {
		if (operation.stage === 'admitted') {
			operation = await this.attachTarget(operation);
		} else {
			operation = await this.reproveTarget(operation);
		}
		if (operation.stage === 'snapshotting' || operation.stage === 'attachingTarget') {
			operation = await this.snapshotSelectedCategories(operation, token);
		}
		if (operation.stage === 'materializing') {
			operation = await this.materializeInheritedCategories(operation, token);
		}
		return operation;
	}

	private async attachTarget(operation: EditorMigrationOperation): Promise<EditorMigrationOperation> {
		const selection = operation.plan.target.selection;
		if (selection.kind === 'existing') {
			const profile = this.profilesService.profiles.find(candidate => candidate.id === selection.profileId);
			assertEligibleProfile(profile);
			this.assertReviewedTargetEvidence(operation, profile);
			return await this.save(operation, { ...operation, stage: 'snapshotting', target: { state: 'attached', profileId: profile.id, profileName: profile.name } });
		}
		const name = selection.name.trim();
		if (!name || this.profilesService.profiles.some(profile => !profile.isTransient && profile.name === name)) {
			throw new Error(`Proposed migration profile '${name}' is no longer available`);
		}
		const reservedId = generateUuid();
		operation = await this.save(operation, { ...operation, stage: 'attachingTarget', target: { state: 'reserved', profileId: reservedId, profileName: name } });
		await this.assertWriterLease();
		const profile = await this.profilesService.createProfile(reservedId, name, {
			icon: selection.options?.icon,
			useDefaultFlags: selection.options?.useDefaultFlags as UseDefaultProfileFlags | undefined,
		});
		if (profile.id !== reservedId || profile.name !== name || profile.isTransient || profile.isInternal) {
			throw new Error('Created migration profile does not match its durable reservation');
		}
		return await this.save(operation, { ...operation, stage: 'snapshotting', target: { state: 'attached', profileId: profile.id, profileName: profile.name } });
	}

	private async reproveTarget(operation: EditorMigrationOperation): Promise<EditorMigrationOperation> {
		const selection = operation.plan.target.selection;
		if (selection.kind === 'proposed') {
			if (!operation.target.profileId || !operation.target.profileName) {
				throw new Error('Migration operation has an invalid target reservation');
			}
			let profile = this.profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
			if (!profile) {
				if (this.profilesService.profiles.some(candidate => !candidate.isTransient && candidate.name === operation.target.profileName)) {
					throw new Error('Reserved migration profile name is owned by another profile');
				}
				if (operation.stage === 'settled' || operation.stage === 'rolledBack') {
					await this.verifyCatalogReplayPostconditions(operation);
				}
				await this.assertWriterLease();
				profile = await this.profilesService.createProfile(operation.target.profileId, operation.target.profileName, {
					...this.proposedProfileOptions(operation),
				});
			}
			assertEligibleProfile(profile);
			this.assertProposedProfileOptions(operation, profile);
			if (operation.target.state !== 'attached') {
				operation = await this.save(operation, { ...operation, target: { ...operation.target, state: 'attached' } });
			}
			return await this.repairMaterializationOwnership(operation, profile);
		}
		const profile = this.requireAttachedProfile(operation);
		return await this.repairMaterializationOwnership(operation, profile);
	}

	private proposedProfileOptions(operation: EditorMigrationOperation): { readonly icon?: string; readonly useDefaultFlags?: UseDefaultProfileFlags } {
		const selection = operation.plan.target.selection;
		if (selection.kind !== 'proposed') {
			throw new Error('Migration operation does not target a proposed profile');
		}
		let useDefaultFlags: EditorMigrationProfileFlags = { ...(selection.options?.useDefaultFlags ?? {}) };
		if (operation.stage === 'rollbackPending' || operation.stage === 'rolledBack') {
			if (operation.rollbackIntent) {
				useDefaultFlags = { ...operation.rollbackIntent.afterFlags };
			}
		} else if (operation.ownershipChange && operation.stage === 'materializing') {
			useDefaultFlags = { ...operation.ownershipChange.afterFlags };
		} else if (operation.ownershipChange && ['applying', 'settled'].includes(operation.stage)) {
			useDefaultFlags = { ...operation.ownershipChange.afterFlags };
		}
		return { icon: selection.options?.icon, useDefaultFlags: useDefaultFlags as UseDefaultProfileFlags };
	}

	private assertProposedProfileOptions(operation: EditorMigrationOperation, profile: IUserDataProfile): void {
		if (profile.id !== operation.target.profileId || profile.name !== operation.target.profileName || profile.icon !== this.proposedProfileOptions(operation).icon) {
			throw new Error('Migration proposed target identity or options changed');
		}
		const expectedStates: EditorMigrationProfileFlags[] = [this.proposedProfileOptions(operation).useDefaultFlags ?? {}];
		if (operation.stage === 'materializing' && operation.ownershipChange) {
			expectedStates.push(operation.ownershipChange.beforeFlags);
		}
		if (operation.stage === 'rollbackPending' && operation.rollbackIntent?.ownershipState === 'pending') {
			expectedStates.push(operation.rollbackIntent.beforeFlags);
		}
		if ((operation.stage === 'settled' || operation.stage === 'rolledBack') && operation.ownershipChange?.state === 'completed') {
			expectedStates.push(operation.ownershipChange.beforeFlags);
		}
		if (operation.stage === 'rolledBack' && operation.rollbackIntent?.ownershipState === 'restored') {
			expectedStates.push(operation.rollbackIntent.beforeFlags);
		}
		if (!expectedStates.some(expected => flagsMatch(profile, expected))) {
			throw new Error('Migration proposed target ownership changed');
		}
	}

	private async repairMaterializationOwnership(operation: EditorMigrationOperation, profile: IUserDataProfile): Promise<EditorMigrationOperation> {
		if (profile.isDefault) {
			return operation;
		}
		if (operation.stage === 'rollbackPending' || operation.stage === 'rolledBack') {
			const intent = operation.rollbackIntent;
			if (!intent) {
				throw new Error('Migration rollback journal has no durable intent');
			}
			const matchesBefore = flagsMatch(profile, intent.beforeFlags);
			const matchesAfter = flagsMatch(profile, intent.afterFlags);
			if (operation.stage === 'rolledBack' || intent.ownershipState === 'restored') {
				if (!matchesBefore && !matchesAfter) {
					throw new Error('Migration rollback profile ownership changed');
				}
				if (matchesBefore) {
					await this.verifyRollbackRestoredResources(operation, intent);
					if (!sameFlags(intent.beforeFlags, intent.afterFlags)) {
						await this.assertWriterLease();
						await this.profilesService.updateProfile(profile, { useDefaultFlags: flagsToUseDefault(intent.afterFlags) });
					}
				}
			} else if (!matchesBefore && !matchesAfter) {
				throw new Error('Migration rollback profile ownership changed');
			}
			return operation;
		}
		if (operation.stage === 'materializing' && operation.ownershipChange) {
			const intent = operation.ownershipChange;
			const matchesBefore = flagsMatch(profile, intent.beforeFlags);
			const matchesAfter = flagsMatch(profile, intent.afterFlags);
			if (!matchesBefore && !matchesAfter) {
				throw new Error('Migration target ownership changed during materialization');
			}
			if (matchesAfter || intent.state === 'completed') {
				await this.verifyMaterializedResources(operation, intent.categories);
				if (intent.categories.includes('extensions') && !await this.matchesExpectedExtensionPostcondition(operation, profile)) {
					throw new Error('Migration extension materialization drifted');
				}
			}
			if (intent.state === 'completed' && matchesBefore) {
				await this.assertWriterLease();
				await this.profilesService.updateProfile(profile, { useDefaultFlags: flagsToUseDefault(intent.afterFlags) });
			}
			return operation;
		}
		const afterMaterialization = ['applying', 'settled', 'rollbackPending', 'rolledBack'].includes(operation.stage);
		for (const category of operation.plan.choices.selectedCategories) {
			const reviewedOwnership = operation.snapshots.find(snapshot => snapshot.category === category)?.ownership
				?? requireTargetCategory(operation.plan, category).ownership;
			const inherits = Boolean(profile.useDefaultFlags?.[category]);
			if (!afterMaterialization && inherits !== (reviewedOwnership === 'default')) {
				throw new Error(`Migration target ${category} ownership changed`);
			}
			if (afterMaterialization && inherits && reviewedOwnership !== 'default') {
				throw new Error(`Migration target unexpectedly inherited ${category}`);
			}
		}
		if (!afterMaterialization) {
			return operation;
		}
		const lost = operation.plan.choices.selectedCategories.filter(category =>
			profile.useDefaultFlags?.[category]
			&& operation.snapshots.some(snapshot => snapshot.category === category && snapshot.ownership === 'default')
			&& operation.ownershipChange?.state === 'completed'
			&& operation.ownershipChange.categories.includes(category)
		);
		if (!lost.length) {
			return operation;
		}
		for (const category of lost) {
			if (category === 'extensions') {
				if (!await this.matchesExpectedExtensionPostcondition(operation, profile)) {
					throw new Error('Cannot restore extension ownership because materialized data drifted');
				}
				continue;
			}
			for (const snapshot of operation.snapshots.filter(entry => entry.category === category)) {
				if (snapshot.category === 'snippets' && !snapshot.item) {
					continue;
				}
				const current = await this.readRaw(URI.parse(snapshot.resource));
				const currentHash = current ? await sha256(current.value) : await absentHash(category);
				if (currentHash !== (snapshot.postApplyHash ?? snapshot.materializedHash)) {
					throw new Error(`Cannot restore ${category} ownership because materialized data drifted`);
				}
			}
		}
		const flags: Record<string, boolean> = { ...(profile.useDefaultFlags ?? {}) };
		lost.forEach(category => delete flags[category]);
		await this.assertWriterLease();
		await this.profilesService.updateProfile(profile, { useDefaultFlags: flags });
		return operation;
	}

	private async verifyMaterializedResources(operation: EditorMigrationOperation, categories: readonly EditorMigrationCategory[]): Promise<void> {
		for (const entry of operation.snapshots.filter(snapshot => categories.includes(snapshot.category) && snapshot.ownership === 'default' && snapshot.category !== 'extensions')) {
			if (entry.category === 'snippets' && !entry.item) {
				continue;
			}
			const expectedHashes = [entry.materializedHash, entry.postApplyHash].filter((hash): hash is string => Boolean(hash));
			if (!expectedHashes.length) {
				throw new Error(`Migration ${entry.category} materialization has no durable postcondition`);
			}
			const current = await this.readRaw(URI.parse(entry.resource));
			const currentHash = current ? await sha256(current.value) : await absentHash(entry.category);
			if (!expectedHashes.includes(currentHash)) {
				throw new Error(`Migration ${entry.category} materialization drifted`);
			}
		}
	}

	private async verifyRollbackRestoredResources(operation: EditorMigrationOperation, intent: EditorMigrationRollbackIntent): Promise<void> {
		for (const progress of intent.resources) {
			const current = await this.readRaw(URI.parse(progress.resource));
			const currentHash = current ? await sha256(current.value) : await absentHash(progress.category);
			if (progress.state === 'restored' && currentHash !== progress.expectedRestoredHash) {
				throw new Error(`Cannot replay rollback ownership because restored ${progress.category} data drifted`);
			}
			if (progress.state === 'pending' && currentHash !== progress.expectedPostApplyHash && currentHash !== progress.expectedRestoredHash) {
				throw new Error(`Cannot replay rollback ownership because pending ${progress.category} data drifted`);
			}
		}
	}

	private async verifyCatalogReplayPostconditions(operation: EditorMigrationOperation): Promise<void> {
		const rollbackResources = new Set<string>();
		if (operation.stage === 'rolledBack') {
			if (!operation.rollbackIntent) {
				throw new Error('Migration rollback journal has no durable intent');
			}
			await this.verifyRollbackRestoredResources(operation, operation.rollbackIntent);
			for (const progress of operation.rollbackIntent.resources) {
				rollbackResources.add(`${progress.category}\0${progress.item ?? ''}\0${progress.resource}`);
			}
		}
		for (const entry of operation.snapshots.filter(snapshot => snapshot.category !== 'extensions' && !(snapshot.category === 'snippets' && !snapshot.item))) {
			if (rollbackResources.has(`${entry.category}\0${entry.item ?? ''}\0${entry.resource}`)) {
				continue;
			}
			const current = await this.readRaw(URI.parse(entry.resource));
			const currentHash = current ? await sha256(current.value) : await absentHash(entry.category);
			const expectedHash = entry.postApplyHash ?? entry.materializedHash ?? entry.byteHash;
			if (currentHash !== expectedHash) {
				throw new Error(`Cannot recreate settled migration profile because ${entry.category} data drifted`);
			}
		}
		if (operation.plan.choices.selectedCategories.includes('extensions')) {
			const entry = operation.snapshots.find(snapshot => snapshot.category === 'extensions');
			if (entry && !await this.matchesExpectedExtensionPostconditionAt(operation, URI.parse(entry.resource))) {
				throw new Error('Cannot recreate settled migration profile because extension data drifted');
			}
		}
	}

	private async matchesExpectedExtensionPostcondition(operation: EditorMigrationOperation, profile: IUserDataProfile): Promise<boolean> {
		return await this.matchesExpectedExtensionPostconditionAt(operation, ownedCategoryResource(profile, 'extensions'));
	}

	private async matchesExpectedExtensionPostconditionAt(operation: EditorMigrationOperation, ownedResource: URI): Promise<boolean> {
		const ownedRaw = await this.readRaw(ownedResource);
		const owned = ownedRaw ? parseEditorMigrationExtensionManifest(ownedRaw.value.toString()) : [];
		const defaultRaw = await this.readRaw(this.profilesService.defaultProfile.extensionsResource);
		const defaults = defaultRaw ? parseEditorMigrationExtensionManifest(defaultRaw.value.toString()) : [];
		const actual = effectiveEditorMigrationExtensions(owned, defaults);
		const reviewed = requireTargetCategory(operation.plan, 'extensions');
		const reviewedExtensions = reviewed.category === 'extensions' ? reviewed.value ?? [] : [];
		const expected = new Map<string, { id: string; uuid: string | null; version: string; applicationScoped: boolean }>(reviewedExtensions.map(extension => [extension.id.toLowerCase(), {
			id: extension.id.toLowerCase(),
			uuid: extension.uuid ?? null,
			version: extension.version,
			applicationScoped: extension.applicationScoped,
		}]));
		for (const intent of operation.extensionInstallIntents) {
			const item = operation.plan.operations.find(candidate => candidate.id === intent.operationId);
			if (!item || item.kind !== 'installExtension') {
				continue;
			}
			const applicationScoped = intent.actualProfileLocation === this.profilesService.defaultProfile.extensionsResource.toString();
			const observed = actual.find(extension => extension.id.toLowerCase() === item.source.id.toLowerCase());
			const result = operation.results.find(candidate => candidate.id === item.id);
			if (result?.outcome === 'completed' || result?.outcome === 'alreadyPresent'
				|| (observed && observed.version === item.source.version && observed.applicationScoped === applicationScoped)) {
				expected.set(item.source.id.toLowerCase(), {
					id: item.source.id.toLowerCase(),
					uuid: item.source.uuid ?? null,
					version: item.source.version,
					applicationScoped,
				});
			}
		}
		const payload = (extensions: readonly { readonly id: string; readonly uuid?: string; readonly version: string; readonly applicationScoped: boolean }[]) => extensions
			.map(extension => ({ id: extension.id.toLowerCase(), uuid: extension.uuid ?? null, version: extension.version, applicationScoped: extension.applicationScoped }))
			.sort((left, right) => left.id.localeCompare(right.id));
		return await fingerprintEditorMigrationValue(payload(actual)) === await fingerprintEditorMigrationValue([...expected.values()].sort((left, right) => left.id.localeCompare(right.id)));
	}

	private async snapshotSelectedCategories(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperation> {
		const profile = this.requireAttachedProfile(operation);
		this.assertReviewedTargetEvidence(operation, profile);
		for (const category of operation.plan.choices.selectedCategories) {
			throwIfCancelled(token);
			if (operation.snapshotCompletedCategories?.includes(category)) {
				continue;
			}
			const reviewed = requireTargetCategory(operation.plan, category);
			const effective = effectiveCategoryResource(profile, this.profilesService.defaultProfile, category);
			const ownedResource = ownedCategoryResource(profile, category);
			if (category === 'snippets') {
				operation = await this.snapshotSnippets(operation, reviewed, effective.resource, ownedResource, token);
				if (!operation.results.some(result => result.id === category && result.outcome === 'failed')) {
					operation = await this.markSnapshotComplete(operation, category);
				}
				continue;
			}
			const raw = await this.readRaw(effective.resource);
			const hash = raw ? await sha256(raw.value) : await absentHash(category);
			if (category === 'extensions' && await this.extensionSemanticHash(profile) !== reviewed.semanticHash) {
				operation = await this.recordResult(operation, category, category, 'failed', 'targetDrift', 'Extensions changed after Review');
				continue;
			}
			if (category !== 'extensions' && hash !== reviewed.contentHash) {
				operation = await this.recordResult(operation, category, category, 'failed', 'targetDrift', `${category} changed after Review`);
				continue;
			}
			if (operation.snapshots.some(snapshot => snapshot.category === category)) {
				operation = await this.markSnapshotComplete(operation, category);
				continue;
			}
			const path = raw ? await this.writeOperationSnapshot(operation.id, `${category}.before`, raw.value) : undefined;
			const hiddenOwned = reviewed.ownership === 'default' && category !== 'extensions' ? await this.readRaw(ownedResource) : undefined;
			const hiddenOwnedSnapshotPath = hiddenOwned ? await this.writeOperationSnapshot(operation.id, `${category}.hidden-owned`, hiddenOwned.value) : undefined;
			const entry: EditorMigrationSnapshotManifestEntry = {
				category,
				state: raw ? 'present' : 'absent',
				ownership: reviewed.ownership,
				resource: (reviewed.ownership === 'default' ? ownedResource : effective.resource).toString(),
				snapshotPath: path,
				byteHash: hash,
				semanticHash: category === 'extensions' ? reviewed.semanticHash : undefined,
				...(reviewed.ownership === 'default' && category !== 'extensions' ? {
					hiddenOwnedState: hiddenOwned ? 'present' as const : 'absent' as const,
					hiddenOwnedSnapshotPath,
					hiddenOwnedByteHash: hiddenOwned ? await sha256(hiddenOwned.value) : await absentHash(category),
				} : {}),
			};
			operation = await this.save(operation, { ...operation, snapshots: [...operation.snapshots, entry] });
			operation = await this.markSnapshotComplete(operation, category);
		}
		return await this.save(operation, { ...operation, stage: 'materializing' });
	}

	private markSnapshotComplete(operation: EditorMigrationOperation, category: EditorMigrationCategory): Promise<EditorMigrationOperation> {
		return this.save(operation, { ...operation, snapshotCompletedCategories: [...new Set([...(operation.snapshotCompletedCategories ?? []), category])] });
	}

	private assertReviewedTargetEvidence(operation: EditorMigrationOperation, profile: IUserDataProfile): void {
		const reviewedProfile = operation.plan.target.profile;
		if (reviewedProfile && (reviewedProfile.id !== profile.id || reviewedProfile.name !== profile.name || reviewedProfile.kind !== (profile.isDefault ? 'default' : 'named'))) {
			throw new Error('Migration target profile identity changed after Review');
		}
		for (const category of operation.plan.choices.selectedCategories) {
			const reviewed = requireTargetCategory(operation.plan, category);
			const inherited = !profile.isDefault && Boolean(profile.useDefaultFlags?.[category]);
			const ownership = inherited ? 'default' : 'target';
			const ownerProfileId = inherited ? this.profilesService.defaultProfile.id : profile.id;
			if (reviewed.ownership !== ownership || (reviewed.ownerProfileId !== undefined && reviewed.ownerProfileId !== ownerProfileId)) {
				throw new Error(`Migration target ${category} ownership changed after Review`);
			}
		}
	}

	private async snapshotSnippets(operation: EditorMigrationOperation, reviewed: EditorMigrationTargetCategorySnapshot, effectiveResource: URI, ownedResource: URI, token: CancellationToken): Promise<EditorMigrationOperation> {
		const expected = reviewed.category === 'snippets' ? reviewed.value ?? [] : [];
		const hiddenNames = reviewed.ownership === 'default' ? await this.snippetNames(ownedResource) : [];
		if (expected.length === 0 && !operation.snapshots.some(snapshot => snapshot.category === 'snippets' && !snapshot.item)) {
			const entry: EditorMigrationSnapshotManifestEntry = { category: 'snippets', state: 'absent', ownership: reviewed.ownership, resource: (reviewed.ownership === 'default' ? ownedResource : effectiveResource).toString(), byteHash: reviewed.contentHash ?? await absentHash('snippets') };
			operation = await this.save(operation, { ...operation, snapshots: [...operation.snapshots, entry] });
		}
		for (const snippet of expected) {
			throwIfCancelled(token);
			if (operation.snapshots.some(snapshot => snapshot.category === 'snippets' && snapshot.item === snippet.name)) {
				continue;
			}
			const target = safeSnippetResource(effectiveResource, snippet.name);
			const ownedTarget = safeSnippetResource(ownedResource, snippet.name);
			const raw = await this.readRaw(target);
			const hash = raw ? await sha256(raw.value) : await absentHash('snippets');
			if (!raw || hash !== snippet.contentHash) {
				return await this.recordResult(operation, 'snippets', 'snippets', 'failed', 'targetDrift', 'Snippets changed after Review');
			}
			const path = await this.writeOperationSnapshot(operation.id, `snippets/${encodeURIComponent(snippet.name)}`, raw.value);
			const hidden = reviewed.ownership === 'default' ? await this.readRaw(ownedTarget) : undefined;
			const hiddenPath = hidden ? await this.writeOperationSnapshot(operation.id, `hidden-snippets/${encodeURIComponent(snippet.name)}`, hidden.value) : undefined;
			operation = await this.save(operation, {
				...operation, snapshots: [...operation.snapshots, {
					category: 'snippets', item: snippet.name, state: 'present', ownership: reviewed.ownership,
					resource: (reviewed.ownership === 'default' ? ownedTarget : target).toString(), snapshotPath: path, byteHash: hash,
					...(reviewed.ownership === 'default' ? { hiddenOwnedState: hidden ? 'present' as const : 'absent' as const, hiddenOwnedSnapshotPath: hiddenPath, hiddenOwnedByteHash: hidden ? await sha256(hidden.value) : await absentHash('snippets') } : {}),
				}]
			});
			throwIfCancelled(token);
		}
		for (const name of hiddenNames.filter(name => !expected.some(snippet => snippet.name === name))) {
			throwIfCancelled(token);
			const resource = safeSnippetResource(ownedResource, name);
			if (operation.snapshots.some(snapshot => snapshot.category === 'snippets' && snapshot.resource === resource.toString())) {
				continue;
			}
			const hidden = await this.readRaw(resource);
			if (!hidden) {
				continue;
			}
			const hiddenPath = await this.writeOperationSnapshot(operation.id, `hidden-snippets/${encodeURIComponent(name)}`, hidden.value);
			operation = await this.save(operation, {
				...operation, snapshots: [...operation.snapshots, {
					category: 'snippets', item: name, state: 'absent', ownership: 'default', resource: resource.toString(), byteHash: await absentHash('snippets'),
					hiddenOwnedState: 'present', hiddenOwnedSnapshotPath: hiddenPath, hiddenOwnedByteHash: await sha256(hidden.value),
				}]
			});
			throwIfCancelled(token);
		}
		return operation;
	}

	private async snippetNames(resource: URI): Promise<readonly string[]> {
		try {
			return ((await this.fileService.resolve(resource)).children ?? [])
				.filter(child => child.isFile && /\.(?:json|code-snippets)$/i.test(child.name))
				.map(child => child.name)
				.sort((left, right) => left.localeCompare(right));
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return [];
			}
			throw error;
		}
	}

	private async materializeInheritedCategories(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperation> {
		let profile = this.requireAttachedProfile(operation);
		if (profile.isDefault) {
			return await this.save(operation, { ...operation, stage: 'applying' });
		}
		const candidates = operation.plan.choices.selectedCategories.filter(category =>
			operation.snapshots.some(snapshot => snapshot.category === category && snapshot.ownership === 'default')
			&& (operation.ownershipChange?.categories.includes(category)
				|| !operation.results.some(result => result.id === category && (result.outcome === 'failed' || result.outcome === 'unavailable'))
				|| operation.retryItemIds.includes(category))
		);
		const prepared: EditorMigrationCategory[] = operation.ownershipChange ? [...operation.ownershipChange.categories] : [];
		for (const category of candidates) {
			throwIfCancelled(token);
			const owned = ownedCategoryResource(profile, category);
			if (category === 'snippets') {
				for (const snapshot of operation.snapshots.filter(entry => entry.category === category && entry.ownership === 'default')) {
					throwIfCancelled(token);
					if (!snapshot.item) {
						continue;
					}
					operation = await this.materializeSnapshot(operation, snapshot, snapshot.item ? safeSnippetResource(owned, snapshot.item) : owned);
					throwIfCancelled(token);
				}
			} else if (category === 'extensions') {
				if (operation.ownershipChange?.categories.includes(category)) {
					continue;
				}
				const local = this.extensionManagementServerService.localExtensionManagementServer;
				if (!local) {
					operation = await this.recordExtensionMaterializationOutcome(operation, 'unavailable', 'extensionServiceUnavailable', 'Local extension service is unavailable');
					continue;
				}
				try {
					const defaultSemanticBefore = await this.extensionSemanticHash(this.profilesService.defaultProfile);
					await this.assertWriterLease();
					await local.extensionManagementService.copyExtensions(this.profilesService.defaultProfile.extensionsResource, owned);
					const copiedSemantic = await this.extensionSemanticHash(profile, true);
					const reviewed = requireTargetCategory(operation.plan, 'extensions');
					if (copiedSemantic !== reviewed.semanticHash || await this.extensionSemanticHash(this.profilesService.defaultProfile) !== defaultSemanticBefore) {
						operation = await this.recordExtensionMaterializationOutcome(operation, 'failed', 'extensionMaterializationMismatch', 'Extension materialization did not preserve the reviewed effective set');
						continue;
					}
				} catch (error) {
					if (isCancellationError(error) || error instanceof EditorMigrationLeaseLostError) {
						throw error;
					}
					operation = await this.recordExtensionMaterializationOutcome(operation, 'failed', 'extensionMaterializationFailed', errorMessage(error));
					continue;
				}
			} else {
				const snapshot = operation.snapshots.find(entry => entry.category === category && entry.ownership === 'default');
				if (snapshot) {
					operation = await this.materializeSnapshot(operation, snapshot, owned);
				}
			}
			if (!prepared.includes(category)) {
				prepared.push(category);
			}
		}
		if (prepared.length) {
			if (!operation.ownershipChange || prepared.some(category => !operation.ownershipChange?.categories.includes(category))) {
				const beforeFlags = profileFlags(profile);
				const afterFlags = { ...beforeFlags };
				for (const category of prepared) {
					afterFlags[category] = false;
				}
				operation = await this.save(operation, { ...operation, ownershipChange: { categories: prepared, beforeFlags, afterFlags, state: 'pending' } });
			}
			const intent = operation.ownershipChange!;
			await this.verifyMaterializedResources(operation, prepared.filter(category => category !== 'extensions'));
			profile = this.requireAttachedProfile(operation);
			const matchesBefore = flagsMatch(profile, intent.beforeFlags);
			const matchesAfter = flagsMatch(profile, intent.afterFlags);
			if (!matchesBefore && !matchesAfter) {
				throw new Error('Migration target ownership changed during materialization');
			}
			if (matchesBefore) {
				await this.assertWriterLease();
				await this.profilesService.updateProfile(profile, { useDefaultFlags: flagsToUseDefault(intent.afterFlags) });
			}
			profile = this.requireAttachedProfile(operation);
			if (!flagsMatch(profile, intent.afterFlags)) {
				throw new Error('Migration target ownership update was not durable');
			}
			operation = await this.save(operation, { ...operation, ownershipChange: { ...intent, state: 'completed' } });
		}
		return await this.save(operation, { ...operation, stage: 'applying' });
	}

	private async recordExtensionMaterializationOutcome(operation: EditorMigrationOperation, outcome: 'unavailable' | 'failed', code: string, message: string): Promise<EditorMigrationOperation> {
		operation = await this.recordResult(operation, 'extensions', 'extensions', outcome, code, message);
		for (const item of operation.plan.operations.filter((item): item is EditorMigrationInstallExtensionOperation => item.kind === 'installExtension')) {
			operation = await this.recordResult(operation, item.id, 'extensions', outcome, code, message);
		}
		return operation;
	}

	private async materializeSnapshot(operation: EditorMigrationOperation, entry: EditorMigrationSnapshotManifestEntry, resource: URI): Promise<EditorMigrationOperation> {
		if (entry.materializedHash) {
			const current = await this.readRaw(resource);
			const currentHash = current ? await sha256(current.value) : await absentHash(entry.category);
			if (![entry.materializedHash, entry.postApplyHash].includes(currentHash)) {
				throw new Error(`Migration ${entry.category} materialization drifted`);
			}
			return operation;
		}
		if (entry.state === 'present') {
			await this.writeAtomic(resource, await this.readVerifiedSnapshot(operation, entry));
		} else {
			await this.deleteIfExists(resource);
		}
		const current = await this.readRaw(resource);
		const materializedHash = current ? await sha256(current.value) : await absentHash(entry.category);
		if (materializedHash !== entry.byteHash) {
			throw new Error(`Migration ${entry.category} materialization did not reproduce its reviewed seed`);
		}
		const snapshots = operation.snapshots.map(snapshot => snapshot === entry ? { ...snapshot, materializedHash, postApplyHash: materializedHash } : snapshot);
		return await this.save(operation, { ...operation, snapshots });
	}

	private async execute(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperationResult> {
		operation = await this.reproveTarget(operation);
		for (const category of CATEGORY_ORDER.filter(category => operation.plan.choices.selectedCategories.includes(category))) {
			operation = await this.reproveTarget(operation);
			if (token.isCancellationRequested) {
				operation = await this.cancelPending(operation);
				break;
			}
			if (category === 'extensions') {
				const materializationResult = operation.results.find(result => result.id === category);
				if (!materializationResult || !['failed', 'unavailable'].includes(materializationResult.outcome) || operation.retryItemIds.includes(category)) {
					operation = await this.applyExtensions(operation, token);
				}
			} else if (!operation.results.some(result => result.id === category) || operation.retryItemIds.includes(category)) {
				operation = await this.applyFileCategory(operation, category, token);
			}
			if (token.isCancellationRequested) {
				operation = await this.cancelPending(operation);
				break;
			}
		}
		const expectedIds = expectedResultIds(operation.plan);
		const expectedResults = expectedIds.map(id => operation.results.find(result => result.id === id));
		const outcomes = expectedResults.flatMap(result => result ? [result.outcome] : []);
		const recoverable = expectedResults.some(result => !result || result.outcome === 'failed' || result.outcome === 'canceled');
		const aggregateOutcome = deriveEditorMigrationAggregateOutcome(outcomes, recoverable);
		operation = await this.save(operation, { ...operation, stage: 'settled', aggregateOutcome, retryItemIds: [] });
		return resultOf(operation);
	}

	private async applyFileCategory(operation: EditorMigrationOperation, category: Exclude<EditorMigrationCategory, 'extensions'>, token: CancellationToken): Promise<EditorMigrationOperation> {
		const profile = this.requireAttachedProfile(operation);
		if (operation.results.some(result => result.id === category && result.outcome === 'failed') && !operation.retryItemIds.includes(category)) {
			return operation;
		}
		try {
			if (category === 'snippets') {
				return await this.applySnippets(operation, profile, token);
			}
			const resource = ownedCategoryResource(profile, category);
			const current = await this.readRaw(resource);
			const currentHash = current ? await sha256(current.value) : await absentHash(category);
			const baseline = operation.snapshots.find(snapshot => snapshot.category === category && snapshot.resource === resource.toString());
			if (!baseline) {
				return await this.recordResult(operation, category, category, 'failed', 'targetDrift', `${category} changed after admission`);
			}
			const baselineContents = baseline.snapshotPath
				? (await this.readVerifiedSnapshot(operation, baseline)).toString()
				: (category === 'settings' ? '{}\n' : '[]\n');
			const operations = operation.plan.operations.filter(item => item.category === category);
			const expected = category === 'settings'
				? reduceEditorMigrationSettings(baselineContents, operations.filter(item => item.kind === 'setSetting'))
				: reduceEditorMigrationKeybindings(baselineContents, operation.plan.evidence, operations.filter((item): item is EditorMigrationKeybindingOperation => item.category === 'keybindings'));
			const written = VSBuffer.fromString(expected);
			const postApplyHash = await sha256(written);
			if (currentHash === postApplyHash) {
				if (currentHash === baseline.byteHash && (operations.length === 0 || baseline.postApplyHash !== postApplyHash)) {
					return await this.recordResult(operation, category, category, 'alreadyPresent');
				}
				operation = await this.withPostApplyHash(operation, category, resource, postApplyHash);
				return await this.recordResult(operation, category, category, 'completed');
			}
			if (currentHash !== baseline.byteHash) {
				return await this.recordResult(operation, category, category, 'failed', 'targetDrift', `${category} changed after admission`);
			}
			if (expected === baselineContents) {
				return await this.recordResult(operation, category, category, 'alreadyPresent');
			}
			await this.writeAtomic(resource, written, current?.mtime, current?.etag);
			operation = await this.withPostApplyHash(operation, category, resource, postApplyHash);
			return await this.recordResult(operation, category, category, 'completed');
		} catch (error) {
			if (isCancellationError(error) || error instanceof EditorMigrationLeaseLostError) {
				throw error;
			}
			return await this.recordResult(operation, category, category, 'failed', 'categoryWriteFailed', errorMessage(error));
		}
	}

	private async applySnippets(operation: EditorMigrationOperation, profile: IUserDataProfile, token: CancellationToken): Promise<EditorMigrationOperation> {
		for (const item of operation.plan.operations.filter(item => item.category === 'snippets')) {
			throwIfCancelled(token);
			if (operation.results.some(result => result.id === item.id) && !operation.retryItemIds.includes(item.id)) {
				continue;
			}
			const resource = safeSnippetResource(ownedCategoryResource(profile, 'snippets'), item.source.name);
			const current = await this.readRaw(resource);
			const contents = VSBuffer.fromString(`${JSON.stringify(item.source.contents, undefined, '\t')}\n`);
			const postApplyHash = await sha256(contents);
			if (current && await sha256(current.value) === postApplyHash) {
				operation = await this.withPostApplyHash(operation, 'snippets', resource, postApplyHash, item.source.name);
				operation = await this.recordResult(operation, item.id, 'snippets', 'completed');
				continue;
			}
			if (item.kind === 'addSnippet' && current) {
				operation = await this.recordResult(operation, item.id, 'snippets', 'failed', 'targetDrift', `Snippet '${item.source.name}' now exists`);
				continue;
			}
			const baseline = operation.snapshots.find(snapshot => snapshot.category === 'snippets' && snapshot.item === item.source.name && snapshot.resource === resource.toString());
			if (item.kind === 'replaceSnippet' && (!current || !baseline || await sha256(current.value) !== baseline.byteHash)) {
				operation = await this.recordResult(operation, item.id, 'snippets', 'failed', 'targetDrift', `Snippet '${item.source.name}' changed after admission`);
				continue;
			}
			await this.writeAtomic(resource, contents, current?.mtime, current?.etag);
			operation = await this.withPostApplyHash(operation, 'snippets', resource, postApplyHash, item.source.name);
			operation = await this.recordResult(operation, item.id, 'snippets', 'completed');
			throwIfCancelled(token);
		}
		return await this.recordResult(operation, 'snippets', 'snippets', operation.results.some(result => result.id !== 'snippets' && result.category === 'snippets' && result.outcome === 'failed') ? 'failed' : 'completed');
	}

	private async applyExtensions(operation: EditorMigrationOperation, token: CancellationToken): Promise<EditorMigrationOperation> {
		for (const item of operation.plan.operations.filter((item): item is EditorMigrationInstallExtensionOperation => item.kind === 'installExtension')) {
			if (token.isCancellationRequested || (operation.results.some(result => result.id === item.id) && !operation.retryItemIds.includes(item.id))) {
				continue;
			}
			operation = await this.applyExtension(operation, item, token);
		}
		if (token.isCancellationRequested) {
			return operation;
		}
		const extensionResults = operation.plan.operations.filter(item => item.kind === 'installExtension').map(item => operation.results.find(result => result.id === item.id));
		if (extensionResults.some(result => !result)) {
			return operation;
		}
		return await this.recordResult(operation, 'extensions', 'extensions', deriveExtensionCategoryOutcome(extensionResults.flatMap(result => result ? [result.outcome] : [])));
	}

	private async applyExtension(operation: EditorMigrationOperation, item: EditorMigrationInstallExtensionOperation, token: CancellationToken): Promise<EditorMigrationOperation> {
		const local = this.extensionManagementServerService.localExtensionManagementServer;
		if (!local) {
			return await this.recordResult(operation, item.id, 'extensions', 'unavailable', 'extensionServiceUnavailable', 'Local extension service is unavailable');
		}
		const profile = this.requireAttachedProfile(operation);
		const installed = await effectiveInstalled(local.extensionManagementService, profile, this.profilesService.defaultProfile);
		const existing = installed.find(extension => extension.identifier.id.toLowerCase() === item.source.id.toLowerCase());
		const installIntent = operation.extensionInstallIntents.find(intent => intent.operationId === item.id);
		if (existing) {
			if (!installIntent) {
				return await this.recordResult(operation, item.id, 'extensions', 'alreadyPresent');
			}
			if (!matchesReviewedExtension(existing, item)) {
				return await this.recordResult(operation, item.id, 'extensions', 'failed', 'extensionInstallDrift', 'The in-flight extension installation does not match the reviewed coordinate');
			}
			let reconciled = existing;
			const actualProfile = reconciled.isApplicationScoped ? this.profilesService.defaultProfile : profile;
			if (actualProfile.extensionsResource.toString() !== installIntent.actualProfileLocation) {
				return await this.recordResult(operation, item.id, 'extensions', 'failed', 'extensionInstallDrift', 'The in-flight extension installation used an unexpected profile location');
			}
			if (reconciled.pinned) {
				await this.assertWriterLease();
				reconciled = await local.extensionManagementService.updateMetadata(reconciled, { pinned: false }, actualProfile.extensionsResource);
			}
			if (reconciled.pinned) {
				return await this.recordResult(operation, item.id, 'extensions', 'failed', 'extensionInstallFailed', 'Extension remained pinned after installation recovery');
			}
			return await this.recordResult(operation, item.id, 'extensions', 'completed');
		}
		const productVersion: IProductVersion = { version: operation.plan.target.environment.productVersion, date: operation.plan.target.environment.productDate };
		const exact = (await this.extensionGalleryService.getExtensions([{ id: item.source.id, uuid: item.source.uuid, version: item.source.version, preRelease: item.source.selectedChannel === 'preRelease' }], {
			compatible: false,
			productVersion,
			targetPlatform: item.source.targetPlatform as TargetPlatform,
		}, token))[0];
		if (!exact) {
			return await this.recordResult(operation, item.id, 'extensions', 'unavailable', 'exactReleaseUnavailable', 'Reviewed extension release is no longer available');
		}
		if (exact.identifier.id.toLowerCase() !== item.source.id.toLowerCase() || exact.version !== item.source.version || exact.properties.targetPlatform !== item.source.targetPlatform) {
			return await this.recordResult(operation, item.id, 'extensions', 'incompatible', 'exactReleaseChanged', 'Gallery returned a different extension coordinate');
		}
		if (exact.identifier.uuid?.toLowerCase() !== item.source.uuid?.toLowerCase()
			|| (exact.properties.isPreReleaseVersion ? 'preRelease' : 'stable') !== item.source.selectedChannel
			|| (exact.properties.engine ?? '*') !== item.source.engine
			|| item.source.galleryIdentity !== operation.plan.target.environment.galleryIdentity
			|| !await this.extensionGalleryService.isExtensionCompatible(exact, item.source.selectedChannel === 'preRelease', item.source.targetPlatform as TargetPlatform, productVersion)) {
			return await this.recordResult(operation, item.id, 'extensions', 'incompatible', 'exactReleaseIncompatible', 'Reviewed extension release is no longer compatible');
		}
		try {
			const manifest = await this.extensionGalleryService.getManifest(exact, token);
			if (!manifest) {
				return await this.recordResult(operation, item.id, 'extensions', 'unavailable', 'exactManifestUnavailable', 'Reviewed extension manifest is no longer available');
			}
			const expectedActualProfile = isApplicationScopedExtension(manifest) ? this.profilesService.defaultProfile : profile;
			if (!installIntent) {
				operation = await this.save(operation, { ...operation, extensionInstallIntents: [...operation.extensionInstallIntents, { operationId: item.id, actualProfileLocation: expectedActualProfile.extensionsResource.toString(), applicationScoped: isApplicationScopedExtension(manifest) }] });
			} else if (installIntent.actualProfileLocation !== expectedActualProfile.extensionsResource.toString()) {
				return await this.recordResult(operation, item.id, 'extensions', 'failed', 'extensionInstallDrift', 'The reviewed extension scope changed after its install intent was recorded');
			}
			await this.assertWriterLease();
			let installedExtension = await local.extensionManagementService.installFromGallery(exact, {
				profileLocation: expectedActualProfile.extensionsResource,
				isMachineScoped: false,
				donotIncludePackAndDependencies: true,
				installGivenVersion: true,
				installPreReleaseVersion: item.source.selectedChannel === 'preRelease',
			});
			const actualProfile = installedExtension.isApplicationScoped ? this.profilesService.defaultProfile : profile;
			if (actualProfile.extensionsResource.toString() !== expectedActualProfile.extensionsResource.toString()) {
				throw new Error('Extension manager used an unexpected profile location');
			}
			if (installedExtension.pinned) {
				await this.assertWriterLease();
				installedExtension = await local.extensionManagementService.updateMetadata(installedExtension, { pinned: false }, actualProfile.extensionsResource);
			}
			if (installedExtension.pinned) {
				throw new Error('Extension remained pinned after exact-version installation');
			}
			const observed = (await effectiveInstalled(local.extensionManagementService, profile, this.profilesService.defaultProfile)).find(extension => extension.identifier.id.toLowerCase() === item.source.id.toLowerCase());
			if (!observed || !matchesReviewedExtension(observed, item) || observed.pinned) {
				throw new Error('Installed extension postcondition does not match the reviewed coordinate');
			}
			return await this.recordResult(operation, item.id, 'extensions', 'completed');
		} catch (error) {
			if (isCancellationError(error) || error instanceof EditorMigrationLeaseLostError) {
				throw error;
			}
			return await this.recordResult(operation, item.id, 'extensions', 'failed', 'extensionInstallFailed', errorMessage(error));
		}
	}

	private async cancelPending(operation: EditorMigrationOperation): Promise<EditorMigrationOperation> {
		for (const id of expectedResultIds(operation.plan)) {
			if (!operation.results.some(result => result.id === id)) {
				const planItem = operation.plan.operations.find(item => item.id === id);
				const category = planItem?.category ?? id as EditorMigrationCategory;
				operation = await this.recordResult(operation, id, category, 'canceled');
			}
		}
		return await this.save(operation, { ...operation, cancellationRequested: true });
	}

	private async finishCancellation(operation: EditorMigrationOperation): Promise<EditorMigrationOperationResult> {
		operation = await this.cancelPending(operation);
		const outcomes = expectedResultIds(operation.plan).map(id => operation.results.find(result => result.id === id)?.outcome).filter((outcome): outcome is EditorMigrationItemOutcome => outcome !== undefined);
		operation = await this.save(operation, { ...operation, stage: 'settled', aggregateOutcome: deriveEditorMigrationAggregateOutcome(outcomes, true), retryItemIds: [] });
		return resultOf(operation);
	}

	private async restoreSnapshot(operation: EditorMigrationOperation, entry: EditorMigrationSnapshotManifestEntry, resource: URI): Promise<void> {
		if (entry.ownership === 'default') {
			if (entry.hiddenOwnedState === 'present') {
				if (!entry.hiddenOwnedSnapshotPath || !entry.hiddenOwnedByteHash) {
					throw new Error('Present hidden owned snapshot has no recovery payload');
				}
				const payload = await this.store.readSnapshot(operation.id, entry.hiddenOwnedSnapshotPath);
				if (await sha256(payload) !== entry.hiddenOwnedByteHash) {
					throw new Error('Hidden owned snapshot payload failed hash verification');
				}
				await this.writeAtomic(resource, payload);
			} else {
				await this.deleteIfExists(resource);
			}
			return;
		}
		if (entry.state === 'absent') {
			await this.deleteIfExists(resource);
			return;
		}
		if (!entry.snapshotPath) {
			throw new Error('Present migration snapshot has no recovery payload');
		}
		const payload = await this.readVerifiedSnapshot(operation, entry);
		await this.writeAtomic(resource, payload);
	}

	private async readVerifiedSnapshot(operation: EditorMigrationOperation, entry: EditorMigrationSnapshotManifestEntry): Promise<VSBuffer> {
		if (!entry.snapshotPath) {
			throw new Error('Present migration snapshot has no recovery payload');
		}
		const payload = await this.store.readSnapshot(operation.id, entry.snapshotPath);
		if (await sha256(payload) !== entry.byteHash) {
			throw new Error('Migration snapshot payload failed hash verification');
		}
		return payload;
	}

	private async recordResult(operation: EditorMigrationOperation, id: string, category: EditorMigrationCategory, outcome: EditorMigrationItemOutcome, code?: string, message?: string): Promise<EditorMigrationOperation> {
		const previous = operation.results.find(result => result.id === id);
		const result: EditorMigrationItemResult = {
			id,
			category,
			outcome,
			attempts: (previous?.attempts ?? 0) + 1,
			...(code && message ? { diagnostic: { code, message } } : {}),
		};
		return await this.save(operation, { ...operation, retryItemIds: operation.retryItemIds.filter(item => item !== id), results: [...operation.results.filter(item => item.id !== id), result] });
	}

	private async withPostApplyHash(operation: EditorMigrationOperation, category: EditorMigrationCategory, resource: URI, postApplyHash: string, item?: string): Promise<EditorMigrationOperation> {
		const snapshots = operation.snapshots.map(snapshot => snapshot.category === category && snapshot.resource === resource.toString() && snapshot.item === item ? { ...snapshot, postApplyHash } : snapshot);
		if (!snapshots.some(snapshot => snapshot.category === category && snapshot.resource === resource.toString() && snapshot.item === item)) {
			snapshots.push({ category, item, state: 'absent', ownership: 'target', resource: resource.toString(), byteHash: await absentHash(category), postApplyHash });
		}
		return await this.save(operation, { ...operation, snapshots });
	}

	private async save(previous: EditorMigrationOperation, next: EditorMigrationOperation): Promise<EditorMigrationOperation> {
		await this.assertWriterLease();
		const saved = await this.store.update(previous, next);
		this.reportProgress(saved);
		return saved;
	}

	private async writeOperationSnapshot(operationId: string, path: string, contents: VSBuffer): Promise<string> {
		await this.assertWriterLease();
		return await this.store.writeSnapshot(operationId, path, contents);
	}

	private requireAttachedProfile(operation: EditorMigrationOperation): IUserDataProfile {
		if (operation.target.state !== 'attached' || !operation.target.profileId) {
			throw new Error('Migration operation has no attached target');
		}
		const profile = this.profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
		assertEligibleProfile(profile);
		if (operation.target.profileName !== profile.name) {
			throw new Error('Migration target profile identity changed');
		}
		return profile;
	}

	private async readRaw(resource: URI): Promise<{ readonly value: VSBuffer; readonly mtime: number; readonly etag: string } | undefined> {
		try {
			const content = await this.fileService.readFile(resource, { atomic: true });
			return { value: content.value, mtime: content.mtime, etag: content.etag };
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw error;
		}
	}

	private async deleteIfExists(resource: URI, recursive = false): Promise<void> {
		try {
			await this.assertWriterLease();
			await this.fileService.del(resource, { recursive });
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				throw error;
			}
		}
	}

	private async extensionSemanticHash(profile: IUserDataProfile, forceOwned = false): Promise<string> {
		const ownedResource = ownedCategoryResource(profile, 'extensions');
		const ownedRaw = await this.readRaw(!forceOwned && !profile.isDefault && profile.useDefaultFlags?.extensions ? this.profilesService.defaultProfile.extensionsResource : ownedResource);
		const owned = ownedRaw ? parseEditorMigrationExtensionManifest(ownedRaw.value.toString()) : [];
		let effective = owned;
		if (!profile.isDefault && (forceOwned || !profile.useDefaultFlags?.extensions)) {
			const defaultRaw = await this.readRaw(this.profilesService.defaultProfile.extensionsResource);
			const defaults = defaultRaw ? parseEditorMigrationExtensionManifest(defaultRaw.value.toString()) : [];
			effective = effectiveEditorMigrationExtensions(owned, defaults);
		}
		return await fingerprintEditorMigrationValue(effective.map(extension => ({ id: extension.id, uuid: extension.uuid ?? null, version: extension.version, applicationScoped: extension.applicationScoped })));
	}

	private async writeAtomic(resource: URI, contents: VSBuffer, mtime?: number, etag?: string): Promise<void> {
		await this.assertWriterLease();
		await this.fileService.createFolder(URI.joinPath(resource, '..'));
		const atomic = this.fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite) ? { postfix: '.hucode-migration-tmp' } : undefined;
		await this.fileService.writeFile(resource, contents, { mtime, etag, atomic });
		const verified = await this.fileService.readFile(resource, { atomic: true });
		if (await sha256(verified.value) !== await sha256(contents)) {
			throw new Error(`Migration write verification failed for ${resource.toString()}`);
		}
	}

	private async withLease<T>(task: () => Promise<T>): Promise<T> {
		if (this.leaseCallActive) {
			throw new EditorMigrationApplyError('writerContention', 'Another editor migration operation is already running in this window');
		}
		this.leaseCallActive = true;
		const owner = generateUuid();
		let acquired = false;
		try {
			if (!await this.shellControllerService.acquireEditorMigrationWriterLease(owner)) {
				throw new EditorMigrationApplyError('writerContention', 'Another editor migration Apply operation holds the writer lease');
			}
			acquired = true;
			this.activeLeaseOwner = owner;
			return await task();
		} finally {
			if (this.activeLeaseOwner === owner) {
				this.activeLeaseOwner = undefined;
			}
			try {
				if (acquired) {
					await this.shellControllerService.releaseEditorMigrationWriterLease(owner);
				}
			} finally {
				this.leaseCallActive = false;
			}
		}
	}

	private async withProgressReporter<T>(reporter: EditorMigrationApplyProgressReporter | undefined, task: () => Promise<T>): Promise<T> {
		if (this.progressReporter) {
			throw new EditorMigrationApplyError('writerContention', 'Another editor migration operation is already reporting progress in this window');
		}
		this.progressReporter = reporter;
		try {
			return await task();
		} finally {
			this.progressReporter = undefined;
		}
	}

	private reportProgress(operation: EditorMigrationOperation): void {
		if (!this.progressReporter) {
			return;
		}
		try {
			this.progressReporter(toEditorMigrationApplyProgress(operation));
		} catch (error) {
			this.logService.warn(`Editor migration progress reporter failed: ${errorMessage(error)}`);
		}
	}

	private async assertWriterLease(): Promise<void> {
		if (!this.activeLeaseOwner || !await this.shellControllerService.validateEditorMigrationWriterLease(this.activeLeaseOwner)) {
			throw new EditorMigrationLeaseLostError();
		}
	}
}

class EditorMigrationLeaseLostError extends Error {
	constructor() {
		super('Editor migration writer lease authority was lost');
	}
}

function profileFlags(profile: IUserDataProfile): EditorMigrationProfileFlags {
	return { ...(profile.useDefaultFlags ?? {}) };
}

function flagsMatch(profile: IUserDataProfile, expected: EditorMigrationProfileFlags): boolean {
	const actual = profile.useDefaultFlags ?? {};
	return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].every(key => Boolean(actual[key as keyof UseDefaultProfileFlags]) === Boolean(expected[key]));
}

function flagsToUseDefault(flags: EditorMigrationProfileFlags): UseDefaultProfileFlags {
	return Object.fromEntries(Object.entries(flags).filter(([, value]) => value).map(([key]) => [key, true])) as UseDefaultProfileFlags;
}

function sameFlags(left: EditorMigrationProfileFlags, right: EditorMigrationProfileFlags): boolean {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].every(key => Boolean(left[key]) === Boolean(right[key]));
}

function sameRollbackResource(left: EditorMigrationRollbackResourceProgress, right: EditorMigrationRollbackResourceProgress): boolean {
	return left.category === right.category && left.item === right.item && left.resource === right.resource;
}

function sameCategories(left: readonly EditorMigrationCategory[], right: readonly EditorMigrationCategory[]): boolean {
	return left.length === right.length && left.every(category => right.includes(category));
}

function findRollbackSnapshot(operation: EditorMigrationOperation, progress: EditorMigrationRollbackResourceProgress): EditorMigrationSnapshotManifestEntry {
	const snapshot = operation.snapshots.find(candidate => candidate.category === progress.category && candidate.item === progress.item && candidate.resource === progress.resource && candidate.postApplyHash === progress.expectedPostApplyHash);
	if (!snapshot) {
		throw new Error(`Migration rollback snapshot for ${progress.category} is missing or changed`);
	}
	return snapshot;
}

function requireTargetCategory(plan: EditorMigrationReviewedPlan, category: EditorMigrationCategory): EditorMigrationTargetCategorySnapshot {
	const snapshot = plan.target.categories.find(item => item.category === category);
	if (!snapshot) {
		throw new Error(`Reviewed migration plan has no ${category} target snapshot`);
	}
	return snapshot;
}

function effectiveCategoryResource(profile: IUserDataProfile, defaultProfile: IUserDataProfile, category: EditorMigrationCategory): { readonly resource: URI; readonly ownership: 'target' | 'default' } {
	return profile.isDefault || !profile.useDefaultFlags?.[category]
		? { resource: ownedCategoryResource(profile, category), ownership: 'target' }
		: { resource: ownedCategoryResource(defaultProfile, category), ownership: 'default' };
}

function ownedCategoryResource(profile: IUserDataProfile, category: EditorMigrationCategory): URI {
	if (profile.isDefault) {
		switch (category) {
			case 'settings': return profile.settingsResource;
			case 'keybindings': return profile.keybindingsResource;
			case 'snippets': return profile.snippetsHome;
			case 'extensions': return profile.extensionsResource;
		}
	}
	switch (category) {
		case 'settings': return joinPath(profile.location, 'settings.json');
		case 'keybindings': return joinPath(profile.location, 'keybindings.json');
		case 'snippets': return joinPath(profile.location, 'snippets');
		case 'extensions': return joinPath(profile.location, 'extensions.json');
	}
}

function safeSnippetResource(home: URI, name: string): URI {
	if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || !/\.(?:json|code-snippets)$/i.test(name)) {
		throw new Error(`Invalid migration snippet name '${name}'`);
	}
	return joinPath(home, name);
}

function matchesReviewedExtension(extension: ILocalExtension, operation: EditorMigrationInstallExtensionOperation): boolean {
	return extension.identifier.id.toLowerCase() === operation.source.id.toLowerCase()
		&& extension.identifier.uuid?.toLowerCase() === operation.source.uuid?.toLowerCase()
		&& extension.manifest.version === operation.source.version
		&& extension.targetPlatform === operation.source.targetPlatform
		&& extension.isPreReleaseVersion === (operation.source.selectedChannel === 'preRelease');
}

async function effectiveInstalled(service: IProfileAwareExtensionManagementService, profile: IUserDataProfile, defaultProfile: IUserDataProfile) {
	const owned = await service.getInstalled(undefined, ownedCategoryResource(profile, 'extensions'));
	if (profile.isDefault) {
		return owned;
	}
	const applicationScoped = (await service.getInstalled(undefined, defaultProfile.extensionsResource)).filter(extension => extension.isApplicationScoped);
	return [...owned, ...applicationScoped.filter(extension => !owned.some(item => item.identifier.id.toLowerCase() === extension.identifier.id.toLowerCase()))];
}

function assertEligibleProfile(profile: IUserDataProfile | undefined): asserts profile is IUserDataProfile {
	if (!profile || profile.isInternal || profile.isTransient) {
		throw new Error('Migration target profile is missing, internal, or transient');
	}
}

function uniqueFileCategories(categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): Exclude<EditorMigrationCategory, 'extensions'>[] {
	return CATEGORY_ORDER.filter((category): category is Exclude<EditorMigrationCategory, 'extensions'> => category !== 'extensions' && categories.includes(category));
}

function expectedResultIds(plan: EditorMigrationReviewedPlan): readonly string[] {
	return [...new Set([
		...plan.choices.selectedCategories,
		...plan.operations.filter(operation => operation.category === 'snippets' || operation.category === 'extensions').map(operation => operation.id),
	])];
}

function preparationRestartStage(operation: EditorMigrationOperation): EditorMigrationOperation['stage'] {
	if (operation.target.state === 'pending') {
		return 'admitted';
	}
	if (operation.target.state === 'reserved') {
		return 'attachingTarget';
	}
	if (operation.plan.choices.selectedCategories.some(category => !operation.snapshotCompletedCategories?.includes(category))) {
		return 'snapshotting';
	}
	if (operation.plan.choices.selectedCategories.some(category =>
		operation.snapshots.some(snapshot => snapshot.category === category && snapshot.ownership === 'default')
		&& !(operation.ownershipChange?.state === 'completed' && operation.ownershipChange.categories.includes(category)))) {
		return 'materializing';
	}
	return 'applying';
}

function deriveExtensionCategoryOutcome(outcomes: readonly EditorMigrationItemOutcome[]): EditorMigrationItemOutcome {
	if (outcomes.length === 0 || outcomes.every(outcome => outcome === 'completed' || outcome === 'alreadyPresent')) {
		return 'completed';
	}
	for (const outcome of ['failed', 'canceled', 'incompatible', 'unavailable', 'skipped'] as const) {
		if (outcomes.includes(outcome)) {
			return outcome;
		}
	}
	return 'completed';
}

function aggregateForwardResults(operation: EditorMigrationOperation): EditorMigrationOperationResult['aggregateOutcome'] {
	return deriveEditorMigrationAggregateOutcome(operation.results.map(result => result.outcome));
}

async function sha256(contents: VSBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', contents.buffer);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function absentHash(category: EditorMigrationCategory): Promise<string> {
	return fingerprintEditorMigrationValue({ category, state: 'absent' });
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

function resultOf(operation: EditorMigrationOperation): EditorMigrationOperationResult {
	if (!operation.aggregateOutcome) {
		throw new Error('Migration operation result is not durable');
	}
	return { operationId: operation.id, aggregateOutcome: operation.aggregateOutcome, stage: operation.stage, results: operation.results };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

registerSingleton(IEditorMigrationApplyService, EditorMigrationApplyService, InstantiationType.Delayed);
