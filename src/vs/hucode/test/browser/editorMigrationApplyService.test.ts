/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Schemas } from '../../../base/common/network.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { AbstractNativeEnvironmentService, INativeEnvironmentPaths } from '../../../platform/environment/common/environmentService.js';
import { IExtensionGalleryService, IGalleryExtension, ILocalExtension, InstallOptions } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, IFileDeleteOptions } from '../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { InMemoryUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { IExtensionManagementServerService, IProfileAwareExtensionManagementService } from '../../../workbench/services/extensionManagement/common/extensionManagement.js';
import { EditorMigrationApplyService } from '../../browser/migration/editorMigrationApplyService.js';
import { EditorMigrationOperationStore } from '../../browser/migration/editorMigrationOperationStore.js';
import { EditorMigrationApplyAuthorization, EditorMigrationApplyError } from '../../common/migration/editorMigrationApply.js';
import { IEditorMigrationPlanningService, EditorMigrationPlanOperation, EditorMigrationReviewedPlan } from '../../common/migration/editorMigrationPlanning.js';
import { fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft } from '../../common/migration/editorMigrationPlanner.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationCategorySnapshot, EditorMigrationSnippet, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';

const ROOT = URI.file('editor-migration-apply-tests').with({ scheme: 'hucode-apply-test' });

suite('EditorMigrationApplyService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let provider: AtomicInMemoryFileSystemProvider;
	let profilesService: InMemoryUserDataProfilesService;
	let acquired: string[];
	let released: string[];
	let service: EditorMigrationApplyService;
	let planning: IEditorMigrationPlanningService;
	let shell: IHucodeShellControllerService;
	let logService: NullLogService;

	setup(() => {
		logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		provider = disposables.add(new AtomicInMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(ROOT.scheme, provider));
		disposables.add(fileService.registerProvider(Schemas.vscodeUserData, provider));
		profilesService = disposables.add(new InMemoryUserDataProfilesService(
			new TestEnvironmentService(joinPath(ROOT, 'User')),
			fileService,
			disposables.add(new UriIdentityService(fileService)),
			logService,
		));
		acquired = [];
		released = [];
		planning = { verifyPlan: async () => ({ status: 'unchanged', reasons: [] }) } as unknown as IEditorMigrationPlanningService;
		shell = {
			acquireEditorMigrationWriterLease: async (id: string) => { acquired.push(id); return true; },
			validateEditorMigrationWriterLease: async (id: string) => acquired.includes(id) && !released.includes(id),
			releaseEditorMigrationWriterLease: async (id: string) => { released.push(id); },
		} as unknown as IHucodeShellControllerService;
		service = new EditorMigrationApplyService(
			fileService,
			profilesService,
			planning,
			{} as IExtensionGalleryService,
			{ localExtensionManagementServer: null } as unknown as IExtensionManagementServerService,
			shell,
			logService,
		);
	});

	test('installs only the reviewed exact extension through the local no-dialog service and clears its pin', async () => {
		const plan = await extensionPlan(profilesService.defaultProfile.id);
		const exact = {
			identifier: { id: 'pub.extension' },
			version: '2.0.0',
			properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' },
		} as unknown as IGalleryExtension;
		let installed: ILocalExtension[] = [];
		let installOptions: InstallOptions | undefined;
		let installCalls = 0;
		let metadataUpdates = 0;
		const extensionService = {
			getInstalled: async () => installed,
			installFromGallery: async (_gallery: IGalleryExtension, options: InstallOptions) => {
				installCalls++;
				installOptions = options;
				const local = { identifier: exact.identifier, manifest: { name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^9.9.9' } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: true, isApplicationScoped: false } as unknown as ILocalExtension;
				installed = [local];
				return local;
			},
			updateMetadata: async (local: ILocalExtension) => {
				metadataUpdates++;
				const updated = { ...local, pinned: false };
				installed = [updated];
				return updated;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		const gallery = {
			getExtensions: async () => [exact],
			isExtensionCompatible: async () => true,
			getManifest: async () => ({ name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' } }),
		} as unknown as IExtensionGalleryService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, gallery, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);

		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [[plan.operations[0].id, 'completed'], ['extensions', 'completed']]);
		assert.strictEqual(installOptions?.profileLocation?.toString(), profilesService.defaultProfile.extensionsResource.toString());
		assert.strictEqual(installOptions?.donotIncludePackAndDependencies, true);
		assert.strictEqual(installOptions?.installGivenVersion, true);
		assert.strictEqual(installOptions?.installPreReleaseVersion, true);
		assert.strictEqual(metadataUpdates, 1);
		assert.strictEqual(installed[0].pinned, false);

		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await store.update(completed, { ...completed, stage: 'applying', results: [], aggregateOutcome: undefined });
		const recovered = await service.resume(result.operationId, CancellationToken.None);
		assert.deepStrictEqual(recovered.results.map(item => [item.id, item.outcome]), [[plan.operations[0].id, 'completed'], ['extensions', 'completed']]);
		assert.strictEqual(installCalls, 1, 'recovery must reconcile the durable install intent without reinstalling');
	});

	test('places application-scoped extensions in the Default profile', async () => {
		const profile = await profilesService.createProfile('application-scope-target', 'Application Scope Target');
		const base = await extensionPlan(profile.id);
		const plan = await finalizePlan({ ...base, target: { ...base.target, profile: { id: profile.id, name: profile.name, kind: 'named' as const }, categories: base.target.categories.map(category => ({ ...category, ownerProfileId: profile.id })) } });
		const exact = { identifier: { id: 'pub.extension' }, version: '2.0.0', properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' } } as unknown as IGalleryExtension;
		let installed: ILocalExtension[] = [];
		let profileLocation: URI | undefined;
		const extensionService = {
			getInstalled: async () => installed,
			installFromGallery: async (_gallery: IGalleryExtension, options: InstallOptions) => {
				profileLocation = options.profileLocation;
				const local = { identifier: exact.identifier, manifest: { name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' }, contributes: { localizations: [{ languageId: 'test', translations: [] }] } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: false, isApplicationScoped: true } as unknown as ILocalExtension;
				installed = [local];
				return local;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async () => [exact],
			isExtensionCompatible: async () => true,
			getManifest: async () => ({ name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' }, contributes: { localizations: [{ languageId: 'test', translations: [] }] } }),
		} as unknown as IExtensionGalleryService, { localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService } } as unknown as IExtensionManagementServerService, shell, logService);

		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(result.aggregateOutcome, 'completed');
		assert.strictEqual(profileLocation?.toString(), profilesService.defaultProfile.extensionsResource.toString());
	});

	test('admits and reconciles a settings write completed before its result checkpoint', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);

		assert.strictEqual(result.aggregateOutcome, 'completed');
		assert.strictEqual(result.stage, 'settled');
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['settings', 'completed']]);
		assert.strictEqual(acquired.length, 1);
		assert.deepStrictEqual(released, acquired);
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Imported');
		assert.ok(profile && !profile.isTransient && !profile.isInternal);
		assert.match((await fileService.readFile(profile.settingsResource)).value.toString(), /"editor.wordWrap": "on"/);

		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await store.update(completed, { ...completed, stage: 'applying', results: [], aggregateOutcome: undefined });
		const recoveredResult = await service.resume(result.operationId, CancellationToken.None);
		assert.deepStrictEqual(recoveredResult.results.map(item => [item.id, item.outcome]), [['settings', 'completed']]);
		const recoveredOperation = await store.read(result.operationId);
		await fileService.del(profile.settingsResource);
		await store.update(recoveredOperation, { ...recoveredOperation, stage: 'snapshotting', snapshotCompletedCategories: [], results: [], aggregateOutcome: undefined });
		await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual((await service.getOperation(result.operationId)).snapshots.filter(snapshot => snapshot.category === 'settings').length, 1);

		const recoverable = await service.listRecoverableOperations();
		assert.deepStrictEqual(recoverable.map(item => item.id), [result.operationId]);
		assert.strictEqual((await service.getOperation(result.operationId)).authorization.planFingerprint, plan.fingerprints.plan);
		await service.acknowledge(result.operationId);
		await assert.rejects(() => service.getOperation(result.operationId));
	});

	test('reports only durable monotonic revisions and ignores a failing progress reporter', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const revisions: number[] = [];
		const result = await service.apply(plan, authorization, CancellationToken.None, progress => revisions.push(progress.revision));

		assert.ok(revisions.length > 3);
		assert.deepStrictEqual(revisions, [...new Set(revisions)].sort((a, b) => a - b));
		assert.strictEqual(revisions[0], 0);
		assert.strictEqual(revisions.at(-1), (await service.getOperation(result.operationId)).revision);

		const secondPlan = await proposedSettingsPlan(['settings'], 'Reporter Failure');
		const secondAuthorization = await service.createApplyAuthorization(secondPlan, []);
		const second = await service.apply(secondPlan, secondAuthorization, CancellationToken.None, () => { throw new Error('presentation failed'); });
		assert.strictEqual(second.aggregateOutcome, 'completed');
	});

	test('rejects missing authorization and pre-admission cancellation before lease, journal, or profile creation', async () => {
		const plan = await proposedSettingsPlan();
		await assert.rejects(() => service.apply(plan, undefined as unknown as EditorMigrationApplyAuthorization, CancellationToken.None), /malformed/);
		const authorization = await service.createApplyAuthorization(plan, []);
		const cancellation = disposables.add(new CancellationTokenSource());
		cancellation.cancel();
		await assert.rejects(() => service.apply(plan, authorization, cancellation.token));

		assert.deepStrictEqual(acquired, []);
		assert.strictEqual(profilesService.profiles.some(profile => profile.name === 'Imported'), false);
		assert.deepStrictEqual(await service.listRecoverableOperations(), []);
	});

	test('acquires the writer lease before cleaning acknowledged recovery data', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await store.update(completed, { ...completed, acknowledged: true });
		acquired.length = 0;
		released.length = 0;

		assert.deepStrictEqual(await service.listRecoverableOperations(), []);
		assert.strictEqual(acquired.length, 1);
		assert.deepStrictEqual(released, acquired);
		await assert.rejects(() => store.read(result.operationId));
	});

	test('lists other recovery records when acknowledged cleanup cannot acquire the writer lease', async () => {
		const firstPlan = await proposedSettingsPlan(['settings'], 'Cleanup Deferred');
		const first = await service.apply(firstPlan, await service.createApplyAuthorization(firstPlan, []), CancellationToken.None);
		const secondPlan = await proposedSettingsPlan(['settings'], 'Still Recoverable');
		const second = await service.apply(secondPlan, await service.createApplyAuthorization(secondPlan, []), CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(first.operationId);
		await store.update(completed, { ...completed, acknowledged: true });
		shell = {
			acquireEditorMigrationWriterLease: async () => false,
			releaseEditorMigrationWriterLease: async () => { },
		} as unknown as IHucodeShellControllerService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, { localExtensionManagementServer: null } as unknown as IExtensionManagementServerService, shell, logService);

		assert.deepStrictEqual((await service.listRecoverableOperations()).map(summary => summary.id), [second.operationId]);
		assert.strictEqual((await store.read(first.operationId)).acknowledged, true);
	});

	test('rejects a stale aggregate plan fingerprint before lease or journal admission', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const mutated = { ...plan, operations: [...plan.operations, { id: 'settings:editor.fontSize', category: 'settings' as const, kind: 'setSetting' as const, item: 'editor.fontSize', source: 18 }] };

		await assert.rejects(() => service.apply(mutated, authorization, CancellationToken.None), /non-canonical, stale, or corrupt/);
		assert.deepStrictEqual(acquired, []);
		assert.deepStrictEqual(await service.listRecoverableOperations(), []);
	});

	test('returns typed plan drift and writer contention failures', async () => {
		const plan = await proposedSettingsPlan();
		planning = { verifyPlan: async () => ({ status: 'changed', reasons: ['sourceChanged'] }) } as unknown as IEditorMigrationPlanningService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, { localExtensionManagementServer: null } as unknown as IExtensionManagementServerService, shell, logService);
		const authorization = await service.createApplyAuthorization(plan, []);
		await assert.rejects(() => service.apply(plan, authorization, CancellationToken.None), (error: EditorMigrationApplyError) => error.code === 'planDrift');

		shell = { acquireEditorMigrationWriterLease: async () => false } as unknown as IHucodeShellControllerService;
		planning = { verifyPlan: async () => ({ status: 'unchanged', reasons: [] }) } as unknown as IEditorMigrationPlanningService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, { localExtensionManagementServer: null } as unknown as IExtensionManagementServerService, shell, logService);
		const nextAuthorization = await service.createApplyAuthorization(plan, []);
		await assert.rejects(() => service.apply(plan, nextAuthorization, CancellationToken.None), (error: EditorMigrationApplyError) => error.code === 'writerContention');
	});

	test('stops at a durable boundary when the main writer lease loses authority', async () => {
		const plan = await proposedSettingsPlan();
		let validations = 0;
		shell = {
			acquireEditorMigrationWriterLease: async () => true,
			validateEditorMigrationWriterLease: async () => ++validations === 1,
			releaseEditorMigrationWriterLease: async () => { },
		} as unknown as IHucodeShellControllerService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, { localExtensionManagementServer: null } as unknown as IExtensionManagementServerService, shell, logService);
		const authorization = await service.createApplyAuthorization(plan, []);
		await assert.rejects(() => service.apply(plan, authorization, CancellationToken.None), /writer lease authority was lost/);
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Imported');
		assert.strictEqual(profile, undefined);
		const recoverable = await service.listRecoverableOperations();
		assert.strictEqual(recoverable.length, 1);
		assert.strictEqual((await service.getOperation(recoverable[0].id)).stage, 'admitted');
		assert.strictEqual(validations, 2);
	});

	test('does not let a second call substitute authority after the first lease is invalidated', async () => {
		const firstPlan = await proposedSettingsPlan(['settings'], 'Lease A');
		const secondPlan = await proposedSettingsPlan(['settings'], 'Lease B');
		let unblockFirst!: () => void;
		const firstBlocked = new Promise<void>(resolve => unblockFirst = resolve);
		let verificationCalls = 0;
		planning = {
			verifyPlan: async () => {
				if (++verificationCalls === 1) {
					await firstBlocked;
				}
				return { status: 'unchanged', reasons: [] };
			},
		} as unknown as IEditorMigrationPlanningService;
		let remoteAuthority: string | undefined;
		let signalAcquired!: () => void;
		const acquiredFirst = new Promise<void>(resolve => signalAcquired = resolve);
		let acquisitionCalls = 0;
		shell = {
			acquireEditorMigrationWriterLease: async (id: string) => {
				acquisitionCalls++;
				if (remoteAuthority) {
					return false;
				}
				remoteAuthority = id;
				signalAcquired();
				return true;
			},
			validateEditorMigrationWriterLease: async (id: string) => remoteAuthority === id,
			releaseEditorMigrationWriterLease: async (id: string) => {
				if (remoteAuthority === id) {
					remoteAuthority = undefined;
				}
			},
		} as unknown as IHucodeShellControllerService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, { localExtensionManagementServer: null } as unknown as IExtensionManagementServerService, shell, logService);
		const firstAuthorization = await service.createApplyAuthorization(firstPlan, []);
		const secondAuthorization = await service.createApplyAuthorization(secondPlan, []);
		const first = service.apply(firstPlan, firstAuthorization, CancellationToken.None);
		await acquiredFirst;
		remoteAuthority = undefined;
		const secondDisposition = await service.apply(secondPlan, secondAuthorization, CancellationToken.None).then(() => 'completed', () => 'rejected');
		unblockFirst();
		await assert.rejects(() => first, /writer lease authority was lost/);

		assert.strictEqual(secondDisposition, 'rejected');
		assert.strictEqual(acquisitionCalls, 1);
		assert.strictEqual(profilesService.profiles.some(candidate => candidate.name === 'Lease A' || candidate.name === 'Lease B'), false);
	});

	test('settles cancellation requested after admission and between selected categories', async () => {
		const plan = await proposedSettingsPlan(['settings', 'keybindings']);
		const cancellation = disposables.add(new CancellationTokenSource());
		provider.onDidReadFile = resource => {
			if (resource.path.endsWith('/settings.json') && !resource.path.includes('/hucode/migration/')) {
				cancellation.cancel();
			}
		};
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, cancellation.token);

		assert.strictEqual(result.stage, 'settled');
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['settings', 'canceled'], ['keybindings', 'canceled']]);
		assert.strictEqual((await service.getOperation(result.operationId)).cancellationRequested, true);

		provider.onDidReadFile = undefined;
		const betweenPlan = await proposedSettingsPlan(['settings', 'keybindings'], 'Imported Between');
		const betweenCancellation = disposables.add(new CancellationTokenSource());
		provider.onDidWriteFile = resource => {
			if (resource.path.endsWith('/settings.json') && !resource.path.includes('/hucode/migration/')) {
				betweenCancellation.cancel();
			}
		};
		const betweenAuthorization = await service.createApplyAuthorization(betweenPlan, []);
		const between = await service.apply(betweenPlan, betweenAuthorization, betweenCancellation.token);
		assert.deepStrictEqual(between.results.map(item => [item.id, item.outcome]), [['settings', 'completed'], ['keybindings', 'canceled']]);
	});

	test('retries canceled snippet snapshotting from the next durable file boundary', async () => {
		const snippets: readonly Pick<EditorMigrationSnippet, 'name' | 'contents'>[] = [
			{ name: 'one.code-snippets', contents: { One: { prefix: 'one', body: ['one'] } } },
			{ name: 'two.code-snippets', contents: { Two: { prefix: 'two', body: ['two'] } } },
		];
		for (const snippet of snippets) {
			await fileService.writeFile(joinPath(profilesService.defaultProfile.snippetsHome, snippet.name), VSBuffer.fromString(snippetText(snippet.contents)));
		}
		const profile = await profilesService.createProfile('cancel-snapshot-snippets', 'Cancel Snapshot Snippets', { useDefaultFlags: { snippets: true } });
		const plan = await inheritedSnippetsPlan(profile.id, profile.name, snippets);
		const cancellation = disposables.add(new CancellationTokenSource());
		let snapshotWrites = 0;
		provider.onDidWriteFile = resource => {
			if (resource.path.includes('/snapshots/snippets/encode') || resource.path.includes('/snapshots/snippets/one')) {
				if (++snapshotWrites === 1) {
					cancellation.cancel();
				}
			}
		};
		const authorization = await service.createApplyAuthorization(plan, []);
		const canceled = await service.apply(plan, authorization, cancellation.token);
		const interrupted = await service.getOperation(canceled.operationId);
		assert.strictEqual(interrupted.snapshotCompletedCategories?.includes('snippets'), false);
		assert.strictEqual(interrupted.snapshots.filter(snapshot => snapshot.item).length, 1);

		provider.onDidWriteFile = undefined;
		const retried = await service.retry(canceled.operationId, CancellationToken.None);
		assert.strictEqual(retried.aggregateOutcome, 'completed');
		assert.strictEqual((await service.getOperation(canceled.operationId)).snapshots.filter(snapshot => snapshot.item).length, 2);
	});

	test('retries canceled snippet materialization and Apply without touching later files early', async () => {
		const inheritedSnippets: readonly Pick<EditorMigrationSnippet, 'name' | 'contents'>[] = [
			{ name: 'one.code-snippets', contents: { One: { prefix: 'one', body: ['one'] } } },
			{ name: 'two.code-snippets', contents: { Two: { prefix: 'two', body: ['two'] } } },
		];
		for (const snippet of inheritedSnippets) {
			await fileService.writeFile(joinPath(profilesService.defaultProfile.snippetsHome, snippet.name), VSBuffer.fromString(snippetText(snippet.contents)));
		}
		const inherited = await profilesService.createProfile('cancel-materialize-snippets', 'Cancel Materialize Snippets', { useDefaultFlags: { snippets: true } });
		const inheritedPlan = await inheritedSnippetsPlan(inherited.id, inherited.name, inheritedSnippets);
		const materializeCancellation = disposables.add(new CancellationTokenSource());
		let materializedWrites = 0;
		provider.onDidWriteFile = resource => {
			if (resource.path.includes('/cancel-materialize-snippets/snippets/') && ++materializedWrites === 1) {
				materializeCancellation.cancel();
			}
		};
		const inheritedAuthorization = await service.createApplyAuthorization(inheritedPlan, []);
		const canceledMaterialization = await service.apply(inheritedPlan, inheritedAuthorization, materializeCancellation.token);
		assert.strictEqual(await fileService.exists(joinPath(inherited.location, 'snippets', 'two.code-snippets')), false);
		provider.onDidWriteFile = undefined;
		assert.strictEqual((await service.retry(canceledMaterialization.operationId, CancellationToken.None)).aggregateOutcome, 'completed');
		assert.strictEqual(await fileService.exists(joinPath(inherited.location, 'snippets', 'two.code-snippets')), true);

		const applyPlan = await proposedSnippetsPlan('Cancel Apply Snippets', ['one.code-snippets', 'two.code-snippets']);
		const applyCancellation = disposables.add(new CancellationTokenSource());
		let applyWrites = 0;
		provider.onDidWriteFile = resource => {
			if (resource.path.includes('/snippets/') && !resource.path.includes('/hucode/migration/') && ++applyWrites === 1) {
				applyCancellation.cancel();
			}
		};
		const applyAuthorization = await service.createApplyAuthorization(applyPlan, []);
		const canceledApply = await service.apply(applyPlan, applyAuthorization, applyCancellation.token);
		const applyProfile = profilesService.profiles.find(candidate => candidate.name === 'Cancel Apply Snippets');
		assert.ok(applyProfile);
		assert.strictEqual(await fileService.exists(joinPath(applyProfile.location, 'snippets', 'two.code-snippets')), false);
		provider.onDidWriteFile = undefined;
		assert.strictEqual((await service.retry(canceledApply.operationId, CancellationToken.None)).aggregateOutcome, 'completed');
		assert.strictEqual(await fileService.exists(joinPath(applyProfile.location, 'snippets', 'two.code-snippets')), true);
	});

	test('reports an extensions category with no install operations', async () => {
		const plan = await finalizePlan({ ...(await extensionPlan(profilesService.defaultProfile.id)), operations: [] });
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['extensions', 'completed']]);
		assert.strictEqual(result.aggregateOutcome, 'completed');
	});

	test('keeps an existing profile inherited when extension materialization is unavailable, then retries it', async () => {
		const profile = await profilesService.createProfile('inherited-extensions-retry', 'Inherited extensions', { useDefaultFlags: { extensions: true } });
		const plan = await inheritedExtensionPlan(profile.id, profile.name);
		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const extensionId = plan.operations[0].id;

		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [
			['extensions', 'unavailable'],
			[extensionId, 'unavailable'],
		]);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.extensions, true);

		const exact = {
			identifier: { id: 'pub.extension' },
			version: '2.0.0',
			properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' },
		} as unknown as IGalleryExtension;
		let installed: ILocalExtension[] = [];
		let installs = 0;
		const extensionService = {
			copyExtensions: async (_from: URI, to: URI) => fileService.writeFile(to, VSBuffer.fromString('[]')),
			getInstalled: async () => installed,
			installFromGallery: async () => {
				installs++;
				const local = { identifier: exact.identifier, manifest: { name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: false, isApplicationScoped: false } as unknown as ILocalExtension;
				installed = [local];
				return local;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async () => [exact],
			isExtensionCompatible: async () => true,
			getManifest: async () => ({ name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' } }),
		} as unknown as IExtensionGalleryService, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);

		const retried = await service.retry(result.operationId, CancellationToken.None);
		assert.deepStrictEqual(retried.results.map(item => [item.id, item.outcome, item.attempts]), [
			[extensionId, 'completed', 2],
			['extensions', 'completed', 2],
		]);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.extensions, undefined);
		assert.strictEqual(installs, 1);
	});

	test('durably cancels extension work when the gallery cancels after admission', async () => {
		const plan = await extensionPlan(profilesService.defaultProfile.id);
		const extensionService = { getInstalled: async () => [] } as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async () => { throw new CancellationError(); },
		} as unknown as IExtensionGalleryService, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);
		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(result.stage, 'settled');
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['extensions', 'canceled'], [plan.operations[0].id, 'canceled']]);
	});

	test('reports mixed extension outcomes and retries only failed work with durable attempts', async () => {
		const base = await extensionPlan(profilesService.defaultProfile.id);
		const firstOperation = base.operations[0];
		if (firstOperation.kind !== 'installExtension') {
			throw new Error('Expected extension operation fixture');
		}
		const second = { ...firstOperation, id: 'extensions:other.missing', item: 'other.missing', source: { ...firstOperation.source, id: 'other.missing' } };
		const plan = await finalizePlan({ ...base, operations: [...base.operations, second] });
		const galleryExtension = (id: string) => ({ identifier: { id }, version: '2.0.0', properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' } }) as unknown as IGalleryExtension;
		let missingAvailable = false;
		let installs = 0;
		let installed: ILocalExtension[] = [];
		const extensionService = {
			getInstalled: async () => installed,
			installFromGallery: async (galleryItem: IGalleryExtension) => {
				installs++;
				const [publisher, name] = galleryItem.identifier.id.split('.');
				const local = { identifier: galleryItem.identifier, manifest: { name, publisher, version: galleryItem.version, engines: { vscode: '^1.135.0' } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: false, isApplicationScoped: false } as unknown as ILocalExtension;
				installed = [...installed, local];
				return local;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		const gallery = {
			getExtensions: async (queries: readonly { id: string }[]) => queries[0].id === 'pub.extension' || missingAvailable ? [galleryExtension(queries[0].id)] : [],
			isExtensionCompatible: async () => true,
			getManifest: async (galleryItem: IGalleryExtension) => ({ name: galleryItem.identifier.id.split('.')[1], publisher: galleryItem.identifier.id.split('.')[0], version: galleryItem.version, engines: { vscode: '^1.135.0' } }),
		} as unknown as IExtensionGalleryService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, gallery, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);

		const authorization = await service.createApplyAuthorization(plan, ['other', 'pub']);
		const first = await service.apply(plan, authorization, CancellationToken.None);
		assert.deepStrictEqual(first.results.map(item => [plan.operations.find(operation => operation.id === item.id)?.item ?? item.id, item.outcome, item.attempts]), [
			['other.missing', 'unavailable', 1],
			['pub.extension', 'completed', 1],
			['extensions', 'unavailable', 1],
		]);

		missingAvailable = true;
		const retried = await service.retry(first.operationId, CancellationToken.None);
		assert.deepStrictEqual(retried.results.map(item => [plan.operations.find(operation => operation.id === item.id)?.item ?? item.id, item.outcome, item.attempts]), [
			['pub.extension', 'completed', 1],
			['other.missing', 'completed', 2],
			['extensions', 'completed', 2],
		]);
		assert.strictEqual(installs, 2);
	});

	test('repairs reverted inherited extension ownership against completed partial installs', async () => {
		const profile = await profilesService.createProfile('partial-extension-repair', 'Partial Extension Repair', { useDefaultFlags: { extensions: true } });
		const base = await inheritedExtensionPlan(profile.id, profile.name);
		const firstOperation = base.operations[0];
		if (firstOperation.kind !== 'installExtension') {
			throw new Error('Expected extension operation fixture');
		}
		const plan = await finalizePlan({ ...base, operations: [...base.operations, { ...firstOperation, id: 'ignored-by-canonical-planner', item: 'other.missing', source: { ...firstOperation.source, id: 'other.missing' } }] });
		let missingAvailable = false;
		let installed: ILocalExtension[] = [];
		let installs = 0;
		const extensionService = {
			copyExtensions: async (_from: URI, to: URI) => fileService.writeFile(to, VSBuffer.fromString('[]')),
			getInstalled: async () => installed,
			installFromGallery: async (galleryItem: IGalleryExtension, options: InstallOptions) => {
				installs++;
				const [publisher, name] = galleryItem.identifier.id.split('.');
				const local = { identifier: galleryItem.identifier, manifest: { name, publisher, version: galleryItem.version, engines: { vscode: '^7.7.7' } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: false, isApplicationScoped: false } as unknown as ILocalExtension;
				installed = [...installed, local];
				const manifest = installed.map(extension => ({ identifier: extension.identifier, version: extension.manifest.version }));
				await fileService.writeFile(options.profileLocation!, VSBuffer.fromString(JSON.stringify(manifest)));
				return local;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		const galleryExtension = (id: string) => ({ identifier: { id }, version: '2.0.0', properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' } }) as unknown as IGalleryExtension;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async (queries: readonly { id: string }[]) => queries[0].id === 'pub.extension' || missingAvailable ? [galleryExtension(queries[0].id)] : [],
			isExtensionCompatible: async () => true,
			getManifest: async (galleryItem: IGalleryExtension) => ({ name: galleryItem.identifier.id.split('.')[1], publisher: galleryItem.identifier.id.split('.')[0], version: galleryItem.version, engines: { vscode: '^1.135.0' } }),
		} as unknown as IExtensionGalleryService, { localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService } } as unknown as IExtensionManagementServerService, shell, logService);

		const authorization = await service.createApplyAuthorization(plan, ['other', 'pub']);
		const first = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(first.results.find(result => plan.operations.find(operation => operation.id === result.id)?.item === 'pub.extension')?.outcome, 'completed');
		await profilesService.updateProfile(profile, { useDefaultFlags: { extensions: true } });
		missingAvailable = true;
		const retried = await service.retry(first.operationId, CancellationToken.None);
		assert.strictEqual(retried.aggregateOutcome, 'completed');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.extensions, undefined);
		assert.strictEqual(installs, 2);
	});

	test('keeps inherited extension ownership when materialization is unavailable or mismatched', async () => {
		const unavailableProfile = await profilesService.createProfile('extensions-unavailable', 'Extensions Unavailable', { useDefaultFlags: { extensions: true } });
		const unavailablePlan = await inheritedExtensionPlan(unavailableProfile.id, unavailableProfile.name);
		const unavailableAuthorization = await service.createApplyAuthorization(unavailablePlan, ['pub']);
		const unavailable = await service.apply(unavailablePlan, unavailableAuthorization, CancellationToken.None);
		assert.strictEqual(unavailable.results.find(result => result.id === 'extensions')?.outcome, 'unavailable');
		assert.strictEqual(profilesService.profiles.find(profile => profile.id === unavailableProfile.id)?.useDefaultFlags?.extensions, true);

		const mismatchProfile = await profilesService.createProfile('extensions-mismatch', 'Extensions Mismatch', { useDefaultFlags: { extensions: true } });
		const mismatchPlan = await inheritedExtensionPlan(mismatchProfile.id, mismatchProfile.name);
		const extensionService = {
			copyExtensions: async (_from: URI, to: URI) => fileService.writeFile(to, VSBuffer.fromString('[{"identifier":{"id":"drift.extension"},"version":"1.0.0"}]')),
			getInstalled: async () => [],
		} as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {} as IExtensionGalleryService, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);
		const mismatchAuthorization = await service.createApplyAuthorization(mismatchPlan, ['pub']);
		const mismatch = await service.apply(mismatchPlan, mismatchAuthorization, CancellationToken.None);
		assert.strictEqual(mismatch.results.find(result => result.id === 'extensions')?.outcome, 'failed');
		assert.strictEqual(profilesService.profiles.find(profile => profile.id === mismatchProfile.id)?.useDefaultFlags?.extensions, true);
	});

	test('recreates a lost attached proposed profile with its reserved identity', async () => {
		const base = await proposedSettingsPlan();
		const plan = await finalizePlan({ ...base, target: { ...base.target, selection: { kind: 'proposed', name: 'Imported', options: { icon: 'zap' } } } });
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const operation = await service.getOperation(result.operationId);
		const profile = profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
		assert.ok(profile);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		await store.update(operation, { ...operation, stage: 'applying', aggregateOutcome: undefined });
		await profilesService.removeProfile(profile);

		await service.resume(result.operationId, CancellationToken.None);
		const recreated = profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
		assert.strictEqual(recreated?.name, operation.target.profileName);
		assert.strictEqual(recreated?.icon, 'zap');
	});

	test('recreates a catalog-lost proposed profile while its settled operation is unacknowledged', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const operation = await service.getOperation(result.operationId);
		const profile = profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
		assert.ok(profile);
		await profilesService.removeProfile(profile);

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, result.aggregateOutcome);
		assert.strictEqual(profilesService.profiles.some(candidate => candidate.id === operation.target.profileId), true);
	});

	test('refuses to recreate a partially rolled-back proposed profile when an unrolled category drifted', async () => {
		const base = await proposedSettingsPlan(['settings', 'keybindings']);
		const plan = await finalizePlan({
			...base,
			operations: [...base.operations, {
				id: 'keybindings:add', category: 'keybindings', kind: 'addKeybinding', item: 'ctrl+k',
				source: { key: 'ctrl+k', command: 'workbench.action.files.save' },
				relatedTargetIds: [],
			} satisfies EditorMigrationPlanOperation],
		});
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		const operation = await service.getOperation(result.operationId);
		const profile = profilesService.profiles.find(candidate => candidate.id === operation.target.profileId);
		assert.ok(profile);
		const keybindings = operation.snapshots.find(entry => entry.category === 'keybindings');
		assert.ok(keybindings?.postApplyHash);
		await fileService.writeFile(URI.parse(keybindings.resource), VSBuffer.fromString('[{"key":"ctrl+x","command":"drifted"}]\n'));
		await profilesService.removeProfile(profile);

		await assert.rejects(() => service.resume(result.operationId, CancellationToken.None), /keybindings data drifted/);
		assert.strictEqual(profilesService.profiles.some(candidate => candidate.id === operation.target.profileId), false);
	});

	test('replays a settled inherited ownership update after catalog persistence loss', async () => {
		const contents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(contents));
		const profile = await profilesService.createProfile('settled-ownership-replay', 'Settled Ownership Replay', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, contents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'completed');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, undefined);
	});

	test('replays settled empty-snippets ownership without reading the directory marker', async () => {
		const profile = await profilesService.createProfile('settled-empty-snippets', 'Settled Empty Snippets', { useDefaultFlags: { snippets: true } });
		const plan = await inheritedEmptySnippetsWithAddPlan(profile.id, profile.name);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		await profilesService.updateProfile(profile, { useDefaultFlags: { snippets: true } });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'completed');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.snippets, undefined);
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'snippets', 'added.code-snippets')), true);
	});

	test('rejects existing target identity and ownership races before admission snapshots', async () => {
		const contents = '{\n\t"editor.fontSize": 12\n}\n';
		const renamed = await profilesService.createProfile('renamed-race', 'Before Rename');
		await fileService.writeFile(renamed.settingsResource, VSBuffer.fromString(contents));
		const renamePlanBase = await inheritedSettingsPlan(renamed.id, renamed.name, contents);
		const renamePlan = await finalizePlan({ ...renamePlanBase, target: { ...renamePlanBase.target, categories: renamePlanBase.target.categories.map(category => ({ ...category, ownership: 'target' as const, ownerProfileId: renamed.id })) } });
		const renameAuthorization = await service.createApplyAuthorization(renamePlan, []);
		await profilesService.updateProfile(renamed, { name: 'After Rename' });
		await assert.rejects(() => service.apply(renamePlan, renameAuthorization, CancellationToken.None), /identity changed after Review/);

		const inherited = await profilesService.createProfile('ownership-race', 'Ownership Race', { useDefaultFlags: { settings: true } });
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(contents));
		await fileService.writeFile(inherited.settingsResource, VSBuffer.fromString(contents));
		const ownershipPlan = await inheritedSettingsPlan(inherited.id, inherited.name, contents);
		const ownershipAuthorization = await service.createApplyAuthorization(ownershipPlan, []);
		await profilesService.updateProfile(inherited, { useDefaultFlags: {} });
		await assert.rejects(() => service.apply(ownershipPlan, ownershipAuthorization, CancellationToken.None), /ownership changed after Review/);

		const owner = await profilesService.createProfile('owner-race', 'Owner Race', { useDefaultFlags: { settings: true } });
		const ownerPlanBase = await inheritedSettingsPlan(owner.id, owner.name, contents);
		const ownerPlan = { ...ownerPlanBase, target: { ...ownerPlanBase.target, categories: ownerPlanBase.target.categories.map(category => ({ ...category, ownerProfileId: 'wrong-owner' })) } };
		await assert.rejects(() => service.createApplyAuthorization(ownerPlan, []), /non-canonical, stale, or corrupt/);
	});

	test('refuses a corrupt inherited snapshot before materialization writes target or Default', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('inherited-profile', 'Inherited', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		const snapshot = completed.snapshots.find(entry => entry.category === 'settings');
		assert.ok(snapshot?.snapshotPath);
		await store.writeSnapshot(completed.id, snapshot.snapshotPath, VSBuffer.fromString('corrupt'));
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });
		const ownedSettings = joinPath(profile.location, 'settings.json');
		await fileService.del(ownedSettings);
		await store.update(completed, {
			...completed,
			stage: 'materializing',
			ownershipChange: undefined,
			snapshots: completed.snapshots.map(entry => ({ ...entry, materializedHash: undefined, postApplyHash: undefined })),
			results: [],
			aggregateOutcome: undefined,
		});

		await assert.rejects(() => service.resume(result.operationId, CancellationToken.None), /snapshot.*hash/i);
		assert.strictEqual(await fileService.exists(ownedSettings), false);
		assert.strictEqual((await fileService.readFile(profilesService.defaultProfile.settingsResource)).value.toString(), defaultContents);
	});

	test('replays interrupted ownership materialization without writing the Default category', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('materialize-replay', 'Materialize Replay', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });
		const ownedSettings = joinPath(profile.location, 'settings.json');
		await fileService.del(ownedSettings);
		await store.update(completed, {
			...completed,
			stage: 'materializing',
			ownershipChange: undefined,
			snapshots: completed.snapshots.map(entry => ({ ...entry, materializedHash: undefined, postApplyHash: undefined })),
			results: [],
			aggregateOutcome: undefined,
		});

		const recovered = await service.resume(result.operationId, CancellationToken.None);
		assert.deepStrictEqual(recovered.results.map(item => [item.id, item.outcome]), [['settings', 'completed']]);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, undefined);
		assert.match((await fileService.readFile(ownedSettings)).value.toString(), /"editor.wordWrap": "on"/);
		assert.strictEqual((await fileService.readFile(profilesService.defaultProfile.settingsResource)).value.toString(), defaultContents);
	});

	test('repairs completed materialization ownership before retrying a later failed item', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('repair-failed-result', 'Repair Failed Result', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });
		await store.update(completed, {
			...completed,
			results: [{ id: 'settings', category: 'settings', outcome: 'failed', attempts: 1, diagnostic: { code: 'injected', message: 'later failure' } }],
			aggregateOutcome: 'recoverable',
		});

		const retried = await service.retry(result.operationId, CancellationToken.None);
		assert.deepStrictEqual(retried.results.map(item => [item.id, item.outcome, item.attempts]), [['settings', 'completed', 2]]);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, undefined);
	});

	test('repairs completed extension materialization before an unavailable retry', async () => {
		const profile = await profilesService.createProfile('repair-extension-result', 'Repair Extension Result', { useDefaultFlags: { extensions: true } });
		const plan = await inheritedExtensionPlan(profile.id, profile.name);
		const extensionService = {
			copyExtensions: async (_from: URI, to: URI) => fileService.writeFile(to, VSBuffer.fromString('[]')),
			getInstalled: async () => [],
		} as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async () => [],
		} as unknown as IExtensionGalleryService, {
			localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService },
		} as unknown as IExtensionManagementServerService, shell, logService);
		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(result.results.find(item => item.id === plan.operations[0].id)?.outcome, 'unavailable');
		await profilesService.updateProfile(profile, { useDefaultFlags: { extensions: true } });

		const retried = await service.retry(result.operationId, CancellationToken.None);
		assert.strictEqual(retried.results.find(item => item.id === plan.operations[0].id)?.attempts, 2);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.extensions, undefined);
	});

	test('retries failed extension materialization after inherited settings reached its post-Apply hash', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('mixed-materialization-retry', 'Mixed Materialization Retry', { useDefaultFlags: { settings: true, extensions: true } });
		const settings = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const extensions = await inheritedExtensionPlan(profile.id, profile.name);
		const plan = await finalizePlan({
			...settings,
			target: { ...settings.target, requestedCategories: ['settings', 'extensions'], categories: [...settings.target.categories, ...extensions.target.categories] },
			choices: { selectedCategories: ['settings', 'extensions'], decisions: [] },
			operations: [...settings.operations, ...extensions.operations],
		});
		const authorization = await service.createApplyAuthorization(plan, ['pub']);
		const first = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(first.results.find(result => result.id === 'settings')?.outcome, 'completed');
		assert.strictEqual(first.results.find(result => result.id === 'extensions')?.outcome, 'unavailable');

		const exact = { identifier: { id: 'pub.extension' }, version: '2.0.0', properties: { targetPlatform: 'linux-x64', isPreReleaseVersion: true, engine: '^1.135.0' } } as unknown as IGalleryExtension;
		let installed: ILocalExtension[] = [];
		const extensionService = {
			copyExtensions: async (_from: URI, to: URI) => fileService.writeFile(to, VSBuffer.fromString('[]')),
			getInstalled: async () => installed,
			installFromGallery: async () => {
				const local = { identifier: exact.identifier, manifest: { name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^8.8.8' } }, targetPlatform: 'linux-x64', isPreReleaseVersion: true, pinned: false, isApplicationScoped: false } as unknown as ILocalExtension;
				installed = [local];
				return local;
			},
		} as unknown as IProfileAwareExtensionManagementService;
		service = new EditorMigrationApplyService(fileService, profilesService, planning, {
			getExtensions: async () => [exact], isExtensionCompatible: async () => true,
			getManifest: async () => ({ name: 'extension', publisher: 'pub', version: exact.version, engines: { vscode: '^1.135.0' } }),
		} as unknown as IExtensionGalleryService, { localExtensionManagementServer: { id: 'local', label: 'Local', extensionManagementService: extensionService } } as unknown as IExtensionManagementServerService, shell, logService);

		const retried = await service.retry(first.operationId, CancellationToken.None);
		assert.strictEqual(retried.aggregateOutcome, 'completed');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, undefined);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.extensions, undefined);
	});

	test('reconciles ownership already changed while the materialization journal is pending', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('ownership-window', 'Ownership Window', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		await fileService.writeFile(joinPath(profile.location, 'settings.json'), VSBuffer.fromString(defaultContents));
		assert.ok(completed.ownershipChange);
		await store.update(completed, { ...completed, stage: 'materializing', ownershipChange: { ...completed.ownershipChange, state: 'pending' }, results: [], aggregateOutcome: undefined });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'completed');
		assert.match((await fileService.readFile(joinPath(profile.location, 'settings.json'))).value.toString(), /"editor.wordWrap": "on"/);
	});

	test('replays completed materialization ownership after its catalog update is reverted', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('completed-ownership-revert', 'Completed Ownership Revert', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const completed = await store.read(result.operationId);
		assert.strictEqual(completed.ownershipChange?.state, 'completed');
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });
		await store.update(completed, { ...completed, stage: 'materializing', results: [], aggregateOutcome: undefined });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'completed');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, undefined);
	});

	test('rolls back an inherited no-op materialization with its proven seed hash', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('noop-materialize', 'No-op Materialize', { useDefaultFlags: { settings: true } });
		const base = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const plan = await finalizePlan({ ...base, operations: [] });
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['settings', 'alreadyPresent']]);

		const rolledBack = await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		assert.strictEqual(rolledBack.aggregateOutcome, 'rolledBack');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, true);
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'settings.json')), false);
	});

	test('preserves unrelated profile inheritance flags through materialization and rollback', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('complete-flags', 'Complete Flags', { useDefaultFlags: { settings: true, tasks: true, prompts: true, mcp: true, languageModels: true, globalState: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		let current = profilesService.profiles.find(candidate => candidate.id === profile.id);
		assert.deepStrictEqual(current?.useDefaultFlags, { tasks: true, prompts: true, mcp: true, languageModels: true, globalState: true });

		await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		current = profilesService.profiles.find(candidate => candidate.id === profile.id);
		assert.deepStrictEqual(current?.useDefaultFlags, { settings: true, tasks: true, prompts: true, mcp: true, languageModels: true, globalState: true });
	});

	test('preserves hidden owned resources while inherited and restores them on rollback', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		const hiddenContents = '{\n\t"editor.fontSize": 99\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('hidden-owned', 'Hidden Owned', { useDefaultFlags: { settings: true } });
		const ownedSettings = joinPath(profile.location, 'settings.json');
		await fileService.writeFile(ownedSettings, VSBuffer.fromString(hiddenContents));
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.match((await fileService.readFile(ownedSettings)).value.toString(), /"editor.wordWrap": "on"/);

		await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		assert.strictEqual((await fileService.readFile(ownedSettings)).value.toString(), hiddenContents);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, true);
	});

	test('restores unrelated hidden snippets after inherited materialization rollback', async () => {
		const defaultSnippet = { name: 'default.code-snippets', contents: { Default: { prefix: 'default', body: ['default'] } } };
		await fileService.writeFile(joinPath(profilesService.defaultProfile.snippetsHome, defaultSnippet.name), VSBuffer.fromString(snippetText(defaultSnippet.contents)));
		const profile = await profilesService.createProfile('hidden-snippets', 'Hidden Snippets', { useDefaultFlags: { snippets: true } });
		const hiddenResource = joinPath(profile.location, 'snippets', 'hidden.code-snippets');
		const hiddenContents = snippetText({ Hidden: { prefix: 'hidden', body: ['hidden'] } });
		await fileService.writeFile(hiddenResource, VSBuffer.fromString(hiddenContents));
		const plan = await inheritedSnippetsPlan(profile.id, profile.name, [defaultSnippet]);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual(await fileService.exists(hiddenResource), false);

		await service.rollback(result.operationId, { categories: ['snippets'] }, CancellationToken.None);
		assert.strictEqual((await fileService.readFile(hiddenResource)).value.toString(), hiddenContents);
	});

	test('resumes a durable rollback intent instead of returning to forward Apply', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		const interrupted = await service.rollback(result.operationId, { categories: ['settings'] }, cancellation.token);
		assert.strictEqual(interrupted.stage, 'rollbackPending');
		assert.strictEqual(interrupted.aggregateOutcome, 'recoverable');
		const pending = await service.getOperation(result.operationId);
		assert.ok(pending.rollbackIntent);

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Imported');
		assert.ok(profile);
		assert.strictEqual(await fileService.exists(profile.settingsResource), false);
	});

	test('rejects forward retry while a pre-mutation rollback request can be superseded', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		await service.rollback(result.operationId, { categories: ['settings'] }, cancellation.token);

		await assert.rejects(() => service.retry(result.operationId, CancellationToken.None), /rollback.*resume/i);
		assert.strictEqual((await service.getOperation(result.operationId)).stage, 'rollbackPending');
		const inspection = await service.inspectRollback(result.operationId, ['settings']);
		const superseded = await service.rollback(result.operationId, { categories: ['settings'], forceCategories: ['settings'], inspectionFingerprint: inspection.fingerprint }, CancellationToken.None);
		assert.strictEqual(superseded.aggregateOutcome, 'rolledBack');
	});

	test('acknowledges only settled or rolled-back operations', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const store = new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource);
		const settled = await store.read(result.operationId);
		await store.update(settled, { ...settled, stage: 'applying', aggregateOutcome: undefined });

		await assert.rejects(() => service.acknowledge(result.operationId), /cannot acknowledge.*applying/i);
		assert.strictEqual((await service.getOperation(result.operationId)).stage, 'applying');
		await service.resume(result.operationId, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		await service.rollback(result.operationId, { categories: ['settings'] }, cancellation.token);
		await assert.rejects(() => service.acknowledge(result.operationId), /cannot acknowledge.*rollbackPending/i);
		assert.strictEqual((await service.getOperation(result.operationId)).stage, 'rollbackPending');
	});

	test('reconciles rollback ownership already restored before its journal checkpoint', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('rollback-ownership-window', 'Rollback Ownership Window', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		await service.rollback(result.operationId, { categories: ['settings'] }, cancellation.token);
		const pending = await service.getOperation(result.operationId);
		assert.strictEqual(pending.rollbackIntent?.ownershipState, 'pending');
		await profilesService.updateProfile(profile, { useDefaultFlags: { settings: true } });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, true);
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'settings.json')), false);
	});

	test('replays rolled-back ownership after its catalog update is reverted', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('rolled-back-ownership-revert', 'Rolled Back Ownership Revert', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const rolledBack = await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		assert.strictEqual(rolledBack.aggregateOutcome, 'rolledBack');
		await profilesService.updateProfile(profile, { useDefaultFlags: {} });

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.settings, true);
	});

	test('keeps rollback recoverable when canceled after ownership restoration', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const profile = await profilesService.createProfile('rollback-ownership-cancel', 'Rollback Ownership Cancel', { useDefaultFlags: { settings: true } });
		const plan = await inheritedSettingsPlan(profile.id, profile.name, defaultContents);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		const originalUpdateProfile = profilesService.updateProfile.bind(profilesService);
		profilesService.updateProfile = async (candidate, options) => {
			const updated = await originalUpdateProfile(candidate, options);
			if (options.useDefaultFlags?.settings) {
				cancellation.cancel();
			}
			return updated;
		};

		const interrupted = await service.rollback(result.operationId, { categories: ['settings'] }, cancellation.token);
		assert.strictEqual(interrupted.stage, 'rollbackPending');
		const pending = await service.getOperation(result.operationId);
		assert.strictEqual(pending.rollbackIntent?.ownershipState, 'restored');
		assert.strictEqual(pending.rollbackIntent?.resources[0].state, 'pending');
		profilesService.updateProfile = originalUpdateProfile;

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
	});

	test('resumes an existing inherited target after ownership and one resource were restored', async () => {
		const snippets: readonly Pick<EditorMigrationSnippet, 'name' | 'contents'>[] = [
			{ name: 'one.code-snippets', contents: { One: { prefix: 'one', body: ['one'] } } },
			{ name: 'two.code-snippets', contents: { Two: { prefix: 'two', body: ['two'] } } },
		];
		for (const snippet of snippets) {
			await fileService.writeFile(joinPath(profilesService.defaultProfile.snippetsHome, snippet.name), VSBuffer.fromString(snippetText(snippet.contents)));
		}
		const profile = await profilesService.createProfile('existing-inherited-rollback', 'Existing Inherited Rollback', { useDefaultFlags: { snippets: true } });
		const plan = await inheritedSnippetsPlan(profile.id, profile.name, snippets);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const cancellation = new CancellationTokenSource();
		provider.onDidDelete = resource => {
			if (resource.path.includes('/snippets/')) {
				cancellation.cancel();
			}
		};
		const interrupted = await service.rollback(result.operationId, { categories: ['snippets'] }, cancellation.token);
		assert.strictEqual(interrupted.stage, 'rollbackPending');
		const pending = await service.getOperation(result.operationId);
		assert.strictEqual(pending.rollbackIntent?.ownershipState, 'restored');
		assert.deepStrictEqual(pending.rollbackIntent?.resources.map(resource => resource.state), ['restored', 'pending']);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.snippets, true);
		provider.onDidDelete = undefined;

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.snippets, true);
	});

	test('proves proposed profile options through final rollback recovery', async () => {
		const base = await proposedSettingsPlan(['settings'], 'Proposed Inherited');
		const plan = await finalizePlan({
			...base,
			target: {
				...base.target,
				selection: { kind: 'proposed', name: 'Proposed Inherited', options: { useDefaultFlags: { snippets: true } } },
			},
		});
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const rolledBack = await service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None);
		assert.strictEqual(rolledBack.aggregateOutcome, 'rolledBack');
		const final = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(final.aggregateOutcome, 'rolledBack');
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Proposed Inherited');
		assert.strictEqual(profile?.useDefaultFlags?.snippets, true);
	});

	test('rolls back an added snippet without treating an inherited empty-directory marker as a resource', async () => {
		const profile = await profilesService.createProfile('empty-inherited-snippets', 'Empty Inherited Snippets', { useDefaultFlags: { snippets: true } });
		const unknown = joinPath(profile.location, 'snippets', 'do-not-delete.txt');
		await fileService.writeFile(unknown, VSBuffer.fromString('private unknown file'));
		const plan = await inheritedEmptySnippetsWithAddPlan(profile.id, profile.name);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.strictEqual((await fileService.readFile(unknown)).value.toString(), 'private unknown file');
		const rolledBack = await service.rollback(result.operationId, { categories: ['snippets'] }, CancellationToken.None);
		assert.strictEqual(rolledBack.aggregateOutcome, 'rolledBack');
		const operation = await service.getOperation(result.operationId);
		assert.deepStrictEqual(operation.rollbackIntent?.resources.map(resource => resource.item), ['added.code-snippets']);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.snippets, true);
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'snippets', 'added.code-snippets')), false);
		assert.strictEqual((await fileService.readFile(unknown)).value.toString(), 'private unknown file');
	});

	test('preflights every inherited snippet and refuses unrelated drift before rollback mutation', async () => {
		const snippets: readonly Pick<EditorMigrationSnippet, 'name' | 'contents'>[] = [
			{ name: 'one.code-snippets', contents: { One: { prefix: 'one', body: ['one'] } } },
			{ name: 'two.code-snippets', contents: { Two: { prefix: 'two', body: ['two'] } } },
		];
		for (const snippet of snippets) {
			await fileService.writeFile(joinPath(profilesService.defaultProfile.snippetsHome, snippet.name), VSBuffer.fromString(snippetText(snippet.contents)));
		}
		const profile = await profilesService.createProfile('inherited-snippets', 'Inherited Snippets', { useDefaultFlags: { snippets: true } });
		const plan = await inheritedSnippetsPlan(profile.id, profile.name, snippets);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const ownedOne = joinPath(profile.location, 'snippets', snippets[0].name);
		const ownedTwo = joinPath(profile.location, 'snippets', snippets[1].name);
		await fileService.writeFile(ownedTwo, VSBuffer.fromString('{ "drift": true }\n'));

		await assert.rejects(() => service.rollback(result.operationId, { categories: ['snippets'] }, CancellationToken.None), /changed after Apply/);
		assert.strictEqual(profilesService.profiles.find(candidate => candidate.id === profile.id)?.useDefaultFlags?.snippets, undefined);
		assert.strictEqual((await fileService.readFile(ownedOne)).value.toString(), snippetText(snippets[0].contents));
		assert.strictEqual((await fileService.readFile(ownedTwo)).value.toString(), '{ "drift": true }\n');
	});

	test('checkpoints one restored resource and resumes rollback after cancellation', async () => {
		const plan = await proposedSnippetsPlan('Two Snippets', ['one.code-snippets', 'two.code-snippets']);
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Two Snippets');
		assert.ok(profile);
		const cancellation = new CancellationTokenSource();
		let deletes = 0;
		provider.onDidDelete = resource => {
			if (resource.path.includes('/snippets/')) {
				deletes++;
				if (deletes === 1) {
					cancellation.cancel();
				}
			}
		};

		const interrupted = await service.rollback(result.operationId, { categories: ['snippets'] }, cancellation.token);
		assert.strictEqual(interrupted.stage, 'rollbackPending');
		const pending = await service.getOperation(result.operationId);
		assert.deepStrictEqual(pending.rollbackIntent?.resources.map(resource => resource.state), ['restored', 'pending']);
		provider.onDidDelete = undefined;

		const resumed = await service.resume(result.operationId, CancellationToken.None);
		assert.strictEqual(resumed.aggregateOutcome, 'rolledBack');
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'snippets', 'one.code-snippets')), false);
		assert.strictEqual(await fileService.exists(joinPath(profile.location, 'snippets', 'two.code-snippets')), false);
	});

	test('rolls back only proven mutations, preserves drift before force, and never rolls back extensions', async () => {
		const plan = await proposedSettingsPlan();
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		const profile = profilesService.profiles.find(candidate => candidate.name === 'Imported');
		assert.ok(profile);
		await assert.rejects(() => service.rollback(result.operationId, { categories: ['keybindings'] }, CancellationToken.None), /unselected/);
		await assert.rejects(() => service.rollback(result.operationId, { categories: ['extensions'] } as never, CancellationToken.None), /not supported/);

		await fileService.writeFile(profile.settingsResource, VSBuffer.fromString('{ "drift": true }'));
		await assert.rejects(() => service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None), /changed after Apply/);

		const forcePlan = await proposedSettingsPlan(['settings'], 'Imported Force');
		const forceAuthorization = await service.createApplyAuthorization(forcePlan, []);
		const forceResult = await service.apply(forcePlan, forceAuthorization, CancellationToken.None);
		const forceProfile = profilesService.profiles.find(candidate => candidate.name === 'Imported Force');
		assert.ok(forceProfile);
		await fileService.writeFile(forceProfile.settingsResource, VSBuffer.fromString('{ "drift": true }'));
		const inspection = await service.inspectRollback(forceResult.operationId, ['settings']);
		assert.deepStrictEqual(inspection.driftedCategories, ['settings']);
		const forced = await service.rollback(forceResult.operationId, { categories: ['settings'], forceCategories: ['settings'], inspectionFingerprint: inspection.fingerprint }, CancellationToken.None);
		assert.strictEqual(forced.aggregateOutcome, 'rolledBack');
		assert.strictEqual(await fileService.exists(forceProfile.settingsResource), false);
		const forcedOperation = await service.getOperation(forceResult.operationId);
		assert.strictEqual(forcedOperation.rollbackDriftSnapshots.length, 1);
		assert.ok(await new EditorMigrationOperationStore(fileService, profilesService.defaultProfile.settingsResource).readSnapshot(forceResult.operationId, forcedOperation.rollbackDriftSnapshots[0].snapshotPath));
	});

	test('rejects rollback when Apply proved the category was already present rather than mutated', async () => {
		const profile = await profilesService.createProfile('already-present', 'Already Present');
		const contents = '{\n\t"editor.wordWrap": "on"\n}\n';
		await fileService.writeFile(profile.settingsResource, VSBuffer.fromString(contents));
		const base = await inheritedSettingsPlan(profile.id, profile.name, contents);
		const plan = await finalizePlan({ ...base, target: { ...base.target, categories: [{ ...base.target.categories[0], ownership: 'target' }] }, operations: [] });
		const authorization = await service.createApplyAuthorization(plan, []);
		const result = await service.apply(plan, authorization, CancellationToken.None);
		assert.deepStrictEqual(result.results.map(item => [item.id, item.outcome]), [['settings', 'alreadyPresent']]);
		await assert.rejects(() => service.rollback(result.operationId, { categories: ['settings'] }, CancellationToken.None), /did not prove a mutated postcondition/);
		assert.strictEqual((await fileService.readFile(profile.settingsResource)).value.toString(), contents);
	});

	test('restores inherited ownership without mutating Default and removes an Apply-added snippet', async () => {
		const defaultContents = '{\n\t"editor.fontSize": 12\n}\n';
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString(defaultContents));
		const inheritedProfile = await profilesService.createProfile('rollback-inherited', 'Rollback Inherited', { useDefaultFlags: { settings: true } });
		const inheritedPlan = await inheritedSettingsPlan(inheritedProfile.id, inheritedProfile.name, defaultContents);
		const inheritedAuthorization = await service.createApplyAuthorization(inheritedPlan, []);
		const inheritedResult = await service.apply(inheritedPlan, inheritedAuthorization, CancellationToken.None);
		await service.rollback(inheritedResult.operationId, { categories: ['settings'] }, CancellationToken.None);
		const restoredProfile = profilesService.profiles.find(candidate => candidate.id === inheritedProfile.id);
		assert.strictEqual(restoredProfile?.useDefaultFlags?.settings, true);
		assert.strictEqual(await fileService.exists(joinPath(inheritedProfile.location, 'settings.json')), false);
		assert.strictEqual((await fileService.readFile(profilesService.defaultProfile.settingsResource)).value.toString(), defaultContents);

		const snippetPlan = await proposedSnippetPlan('Snippet Target');
		const snippetAuthorization = await service.createApplyAuthorization(snippetPlan, []);
		const snippetResult = await service.apply(snippetPlan, snippetAuthorization, CancellationToken.None);
		const snippetProfile = profilesService.profiles.find(candidate => candidate.name === 'Snippet Target');
		assert.ok(snippetProfile);
		const snippetResource = joinPath(snippetProfile.location, 'snippets', 'example.code-snippets');
		assert.strictEqual(await fileService.exists(snippetResource), true);
		await service.rollback(snippetResult.operationId, { categories: ['snippets'] }, CancellationToken.None);
		assert.strictEqual(await fileService.exists(snippetResource), false);
	});
});

class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {
	onDidReadFile: ((resource: URI) => void) | undefined;
	onDidWriteFile: ((resource: URI) => void) | undefined;
	onDidDelete: ((resource: URI) => void) | undefined;

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicRead | FileSystemProviderCapabilities.FileAtomicWrite;
	}

	override async readFile(resource: URI): Promise<Uint8Array> {
		this.onDidReadFile?.(resource);
		return await super.readFile(resource);
	}

	override async writeFile(resource: URI, content: Uint8Array, opts: Parameters<InMemoryFileSystemProvider['writeFile']>[2]): Promise<void> {
		await super.writeFile(resource, content, opts);
		this.onDidWriteFile?.(resource);
	}

	override async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		await super.delete(resource, opts);
		this.onDidDelete?.(resource);
	}
}

class TestEnvironmentService extends AbstractNativeEnvironmentService {
	constructor(private readonly _appSettingsHome: URI) {
		const userDataDir = _appSettingsHome.fsPath.replace(/\/User$/, '');
		const paths: INativeEnvironmentPaths = { userDataDir, homeDir: userDataDir, tmpDir: userDataDir };
		super(Object.create(null), paths, { _serviceBrand: undefined, ...product });
	}
	override get userRoamingDataHome(): URI { return this._appSettingsHome.with({ scheme: Schemas.vscodeUserData }); }
	override get cacheHome(): URI { return this.userRoamingDataHome; }
}

async function proposedSettingsPlan(categories: readonly ('settings' | 'keybindings')[] = ['settings'], name = 'Imported'): Promise<EditorMigrationReviewedPlan> {
	const absent = await fingerprintEditorMigrationValue({ category: 'settings', state: 'absent' });
	const absentKeybindings = await fingerprintEditorMigrationValue({ category: 'keybindings', state: 'absent' });
	const plan = {
		schemaVersion: 2,
		source: {} as EditorMigrationReviewedPlan['source'],
		target: {
			schemaVersion: 2,
			selection: { kind: 'proposed', name },
			eligible: true,
			nameAvailable: true,
			catalogFingerprint: 'catalog',
			requestedCategories: categories,
			categories: [
				...(categories.includes('settings') ? [{ category: 'settings' as const, ownership: 'target' as const, state: 'absent' as const, contentHash: absent, value: {} }] : []),
				...(categories.includes('keybindings') ? [{ category: 'keybindings' as const, ownership: 'target' as const, state: 'absent' as const, contentHash: absentKeybindings, value: [] }] : []),
			],
			environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.1', galleryIdentity: 'open-vsx', policyVersion: 1 },
			builtIns: [],
			fingerprint: 'target',
		},
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] },
		choices: { selectedCategories: categories, decisions: [] },
		operations: [{ id: 'settings:editor.wordWrap', category: 'settings', kind: 'setSetting', item: 'editor.wordWrap', source: 'on' }],
		exclusions: [], prerequisites: [], warnings: [],
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
	} satisfies EditorMigrationReviewedPlan;
	return categories.length ? await finalizePlan(plan) : plan;
}

async function inheritedSettingsPlan(profileId: string, profileName: string, contents: string): Promise<EditorMigrationReviewedPlan> {
	const plan = await proposedSettingsPlan();
	return await finalizePlan({
		...plan,
		target: {
			...plan.target,
			selection: { kind: 'existing', profileId },
			profile: { id: profileId, name: profileName, kind: 'named' },
			categories: [{ category: 'settings', ownership: 'default', state: 'present', contentHash: await fingerprintBytes(contents), value: { 'editor.fontSize': 12 } }],
		},
	});
}

async function proposedSnippetPlan(name: string): Promise<EditorMigrationReviewedPlan> {
	return await proposedSnippetsPlan(name, ['example.code-snippets']);
}

async function proposedSnippetsPlan(name: string, names: readonly string[]): Promise<EditorMigrationReviewedPlan> {
	const plan = await proposedSettingsPlan([], name);
	const absent = await fingerprintEditorMigrationValue({ category: 'snippets', state: 'absent' });
	return await finalizePlan({
		...plan,
		target: { ...plan.target, requestedCategories: ['snippets'], categories: [{ category: 'snippets', ownership: 'target', state: 'absent', contentHash: absent, value: [] }] },
		choices: { selectedCategories: ['snippets'], decisions: [] },
		operations: names.map(snippetName => ({ id: `snippets:${snippetName}`, category: 'snippets' as const, kind: 'addSnippet' as const, item: snippetName, source: { name: snippetName, contents: { Example: { prefix: snippetName, body: [snippetName] } }, contentHash: `source-${snippetName}` } })),
		fingerprints: { ...plan.fingerprints, plan: 'snippet-plan' },
	});
}

async function inheritedSnippetsPlan(
	profileId: string,
	profileName: string,
	snippets: readonly Pick<EditorMigrationSnippet, 'name' | 'contents'>[],
): Promise<EditorMigrationReviewedPlan> {
	const plan = await proposedSettingsPlan([], profileName);
	const value = await Promise.all(snippets.map(async snippet => ({ ...snippet, contentHash: await fingerprintBytes(snippetText(snippet.contents)) })));
	return await finalizePlan({
		...plan,
		target: {
			...plan.target,
			selection: { kind: 'existing', profileId },
			profile: { id: profileId, name: profileName, kind: 'named' },
			requestedCategories: ['snippets'],
			categories: [{ category: 'snippets', ownership: 'default', state: 'present', contentHash: await fingerprintEditorMigrationValue(value), value }],
		},
		choices: { selectedCategories: ['snippets'], decisions: [] },
		operations: [],
		fingerprints: { ...plan.fingerprints, plan: 'inherited-snippets-plan' },
	});
}

async function inheritedEmptySnippetsWithAddPlan(profileId: string, profileName: string): Promise<EditorMigrationReviewedPlan> {
	const plan = await proposedSnippetsPlan(profileName, ['added.code-snippets']);
	const absent = await fingerprintEditorMigrationValue({ category: 'snippets', state: 'absent' });
	return await finalizePlan({
		...plan,
		target: {
			...plan.target,
			selection: { kind: 'existing', profileId },
			profile: { id: profileId, name: profileName, kind: 'named' },
			categories: [{ category: 'snippets', ownership: 'default', state: 'absent', contentHash: absent, value: [] }],
		},
		fingerprints: { ...plan.fingerprints, plan: 'inherited-empty-snippets-add-plan' },
	});
}

function snippetText(contents: EditorMigrationSnippet['contents']): string {
	return `${JSON.stringify(contents, undefined, '\t')}\n`;
}

async function fingerprintBytes(contents: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', VSBuffer.fromString(contents).buffer);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function extensionPlan(profileId: string): Promise<EditorMigrationReviewedPlan> {
	const absent = await fingerprintEditorMigrationValue({ category: 'extensions', state: 'absent' });
	const semanticHash = await fingerprintEditorMigrationValue([]);
	return await finalizePlan({
		schemaVersion: 2,
		source: {} as EditorMigrationReviewedPlan['source'],
		target: {
			schemaVersion: 2,
			selection: { kind: 'existing', profileId },
			profile: { id: profileId, name: 'Default', kind: 'default' },
			eligible: true,
			catalogFingerprint: 'catalog',
			requestedCategories: ['extensions'],
			categories: [{ category: 'extensions', ownership: 'target', ownerProfileId: profileId, state: 'absent', contentHash: absent, semanticHash, value: [] }],
			environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.1', galleryIdentity: 'open-vsx', policyVersion: 1 },
			builtIns: [],
			fingerprint: 'target',
		},
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: '', gallery: [] },
		choices: { selectedCategories: ['extensions'], decisions: [] },
		operations: [{
			id: 'extensions:pub.extension', category: 'extensions', kind: 'installExtension', item: 'pub.extension',
			source: { id: 'pub.extension', requestedChannel: 'preRelease', status: 'available', version: '2.0.0', targetPlatform: 'linux-x64', selectedChannel: 'preRelease', engine: '^1.135.0', galleryIdentity: 'open-vsx' },
		}],
		exclusions: [], prerequisites: [], warnings: [],
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'extension-plan' },
	});
}

async function inheritedExtensionPlan(profileId: string, profileName: string): Promise<EditorMigrationReviewedPlan> {
	const plan = await extensionPlan(profileId);
	return await finalizePlan({
		...plan,
		target: {
			...plan.target,
			selection: { kind: 'existing', profileId },
			profile: { id: profileId, name: profileName, kind: 'named' },
			categories: plan.target.categories.map(category => ({ ...category, ownership: 'default' as const, ownerProfileId: undefined })),
		},
		fingerprints: { ...plan.fingerprints, plan: `inherited-extension-plan-${profileId}` },
	});
}

async function finalizePlan(plan: EditorMigrationReviewedPlan): Promise<EditorMigrationReviewedPlan> {
	const source = sourceForOperations(plan.operations, plan.target.requestedCategories);
	const evidence = {
		...plan.evidence,
		gallery: plan.operations.filter((operation): operation is Extract<EditorMigrationPlanOperation, { kind: 'installExtension' }> => operation.kind === 'installExtension').map(operation => operation.source),
	};
	const draft = createEditorMigrationPlanDraft(source, plan.target, evidence);
	return await acceptEditorMigrationPlanDraft(draft, {
		selectedCategories: plan.choices.selectedCategories,
		decisions: draft.decisions
			.filter(decision => decision.kind === 'conflict' && plan.choices.selectedCategories.includes(decision.category))
			.map(decision => ({ id: decision.id, choice: 'import' })),
	});
}

function sourceForOperations(operations: readonly EditorMigrationPlanOperation[], categories: readonly EditorMigrationReviewedPlan['choices']['selectedCategories'][number][]): EditorMigrationSourceSnapshot {
	const snapshots: EditorMigrationCategorySnapshot[] = categories.map(category => {
		switch (category) {
			case 'settings': return { category, state: 'present', value: Object.fromEntries(operations.filter(operation => operation.kind === 'setSetting').map(operation => [operation.item, operation.source])) } as EditorMigrationCategorySnapshot;
			case 'keybindings': return { category, state: 'present', value: operations.filter((operation): operation is Extract<EditorMigrationPlanOperation, { kind: 'addKeybinding' | 'replaceKeybinding' }> => operation.kind === 'addKeybinding' || operation.kind === 'replaceKeybinding').map(operation => operation.source) } as EditorMigrationCategorySnapshot;
			case 'snippets': return { category, state: 'present', value: operations.filter((operation): operation is Extract<EditorMigrationPlanOperation, { kind: 'addSnippet' | 'replaceSnippet' }> => operation.kind === 'addSnippet' || operation.kind === 'replaceSnippet').map(operation => operation.source) } as EditorMigrationCategorySnapshot;
			case 'extensions': return { category, state: 'present', value: operations.filter((operation): operation is Extract<EditorMigrationPlanOperation, { kind: 'installExtension' }> => operation.kind === 'installExtension').map(operation => ({ id: operation.source.id, uuid: operation.source.uuid, version: operation.source.version, preRelease: operation.source.requestedChannel === 'preRelease' })) } as EditorMigrationCategorySnapshot;
		}
	});
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:apply-test' },
		adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' },
		categories: snapshots,
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories, entries: [], value: 'apply-test-source' },
	};
}
