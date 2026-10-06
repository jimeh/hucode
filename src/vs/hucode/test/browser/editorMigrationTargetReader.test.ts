/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Schemas } from '../../../base/common/network.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { AbstractNativeEnvironmentService, INativeEnvironmentPaths } from '../../../platform/environment/common/environmentService.js';
import { IExtensionGalleryService, IExtensionInfo, IExtensionManagementService, IExtensionQueryOptions, IGalleryExtension } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { TargetPlatform } from '../../../platform/extensions/common/extensions.js';
import { IExtensionsScannerService } from '../../../platform/extensionManagement/common/extensionsScannerService.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { AGENTS_WINDOW_PROFILE_ID, InMemoryUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataSyncUtilService } from '../../../platform/userDataSync/common/userDataSync.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { EditorMigrationPlanningService } from '../../browser/migration/editorMigrationPlanningService.js';
import { EditorMigrationTargetReader } from '../../browser/migration/editorMigrationTargetReader.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceSnapshot, IEditorMigrationSourceService } from '../../common/migration/editorMigrationSource.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EDITOR_MIGRATION_POLICY_VERSION, EditorMigrationPlanningError, EditorMigrationReviewedPlan, EditorMigrationTargetEnvironment, EditorMigrationTargetSnapshot } from '../../common/migration/editorMigrationPlanning.js';

const ROOT = URI.file('editor-migration-target-tests').with({ scheme: 'hucode-target-test' });
const FIRST_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_UUID = '22222222-2222-4222-8222-222222222222';
const THIRD_UUID = '33333333-3333-4333-8333-333333333333';
const environment: EditorMigrationTargetEnvironment = {
	targetPlatform: 'linux-x64',
	productVersion: '1.100.0',
	hucodeVersion: '0.0.1',
	galleryIdentity: 'open-vsx',
	policyVersion: EDITOR_MIGRATION_POLICY_VERSION,
};

class TestEnvironmentService extends AbstractNativeEnvironmentService {
	constructor(private readonly _appSettingsHome: URI) {
		const userDataDir = _appSettingsHome.fsPath.replace(/\/User$/, '');
		const paths: INativeEnvironmentPaths = { userDataDir, homeDir: userDataDir, tmpDir: userDataDir };
		super(Object.create(null), paths, { _serviceBrand: undefined, ...product });
	}
	override get userRoamingDataHome(): URI { return this._appSettingsHome.with({ scheme: Schemas.vscodeUserData }); }
	override get cacheHome(): URI { return this.userRoamingDataHome; }
}

suite('EditorMigrationTargetReader', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let profilesService: InMemoryUserDataProfilesService;

	setup(() => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(ROOT.scheme, provider));
		disposables.add(fileService.registerProvider(Schemas.vscodeUserData, provider));
		profilesService = disposables.add(new InMemoryUserDataProfilesService(
			new TestEnvironmentService(joinPath(ROOT, 'User')),
			fileService,
			disposables.add(new UriIdentityService(fileService)),
			logService,
		));
	});

	test('snapshots Default and ordinary named targets with explicit inherited ownership', async () => {
		await fileService.writeFile(profilesService.defaultProfile.settingsResource, VSBuffer.fromString('{ "editor.fontSize": 14 }'));
		const named = await profilesService.createNamedProfile('Work', { useDefaultFlags: { settings: true } });
		await fileService.writeFile(named.keybindingsResource, VSBuffer.fromString('[{"key":"ctrl+k","command":"work"}]'));
		const mutations: string[] = [];
		const reader = new EditorMigrationTargetReader(fileService, mutationRejectingProxy(profilesService, mutations));

		const defaultSnapshot = await reader.inspect({ kind: 'existing', profileId: profilesService.defaultProfile.id }, ['settings'], environment, [], CancellationToken.None);
		const namedSnapshot = await reader.inspect({ kind: 'existing', profileId: named.id }, ['settings', 'keybindings'], environment, [], CancellationToken.None);

		assert.strictEqual(defaultSnapshot.profile?.kind, 'default');
		assert.deepStrictEqual(namedSnapshot.categories.map(category => [category.category, category.ownership, category.ownerProfileId, category.state]), [
			['settings', 'default', profilesService.defaultProfile.id, 'present'],
			['keybindings', 'target', named.id, 'present'],
		]);
		assert.deepStrictEqual(mutations, []);
	});

	test('fingerprints only the selected existing profile identity and flags', async () => {
		const selected = await profilesService.createNamedProfile('Selected');
		const reader = new EditorMigrationTargetReader(fileService, profilesService);
		const initial = await reader.inspect({ kind: 'existing', profileId: selected.id }, ['settings'], environment, [], CancellationToken.None);

		const unrelated = await profilesService.createNamedProfile('Unrelated');
		await profilesService.updateProfile(unrelated, { name: 'Renamed unrelated' });
		const afterUnrelatedRename = await reader.inspect({ kind: 'existing', profileId: selected.id }, ['settings'], environment, [], CancellationToken.None);
		const transient = await profilesService.createTransientProfile();
		const afterTransientChurn = await reader.inspect({ kind: 'existing', profileId: selected.id }, ['settings'], environment, [], CancellationToken.None);

		assert.strictEqual(afterUnrelatedRename.catalogFingerprint, initial.catalogFingerprint);
		assert.strictEqual(afterUnrelatedRename.fingerprint, initial.fingerprint);
		assert.strictEqual(afterTransientChurn.catalogFingerprint, initial.catalogFingerprint);
		assert.strictEqual(afterTransientChurn.fingerprint, initial.fingerprint);

		const renamed = await profilesService.updateProfile(selected, { name: 'Renamed selected' });
		const afterSelectedRename = await reader.inspect({ kind: 'existing', profileId: selected.id }, ['settings'], environment, [], CancellationToken.None);
		assert.notStrictEqual(afterSelectedRename.catalogFingerprint, initial.catalogFingerprint);
		const flagged = await profilesService.updateProfile(renamed, { useDefaultFlags: { extensions: true } });
		const afterSelectedFlags = await reader.inspect({ kind: 'existing', profileId: flagged.id }, ['settings'], environment, [], CancellationToken.None);
		assert.notStrictEqual(afterSelectedFlags.catalogFingerprint, afterSelectedRename.catalogFingerprint);

		await profilesService.removeProfile(transient);
		const afterTransientRemoval = await reader.inspect({ kind: 'existing', profileId: flagged.id }, ['settings'], environment, [], CancellationToken.None);
		assert.strictEqual(afterTransientRemoval.fingerprint, afterSelectedFlags.fingerprint);
	});

	test('models proposed targets without allocating an ID or touching the profile catalog', async () => {
		const mutations: string[] = [];
		const reader = new EditorMigrationTargetReader(fileService, mutationRejectingProxy(profilesService, mutations));
		const before = profilesService.profiles.map(profile => profile.id);

		const snapshot = await reader.inspect({ kind: 'proposed', name: '  New profile  ', options: { icon: 'beaker', useDefaultFlags: { extensions: true } } }, ['settings'], environment, [], CancellationToken.None);

		assert.deepStrictEqual(snapshot.selection, { kind: 'proposed', name: 'New profile', options: { icon: 'beaker', useDefaultFlags: { extensions: true } } });
		assert.strictEqual(snapshot.profile, undefined);
		assert.strictEqual(snapshot.nameAvailable, true);
		assert.deepStrictEqual(profilesService.profiles.map(profile => profile.id), before);
		assert.deepStrictEqual(mutations, []);
	});

	test('rejects internal and transient targets while preserving proposed name checks', async () => {
		const transient = await profilesService.createTransientProfile();
		const internal = await profilesService.createProfile(AGENTS_WINDOW_PROFILE_ID, 'Agents');
		await profilesService.createNamedProfile('Taken');
		const reader = new EditorMigrationTargetReader(fileService, profilesService);

		await assert.rejects(
			() => reader.inspect({ kind: 'existing', profileId: transient.id }, ['settings'], environment, [], CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'ineligibleTarget',
		);
		await assert.rejects(
			() => reader.inspect({ kind: 'existing', profileId: internal.id }, ['settings'], environment, [], CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'ineligibleTarget',
		);
		const proposed = await reader.inspect({ kind: 'proposed', name: 'Taken' }, ['settings'], environment, [], CancellationToken.None);
		assert.strictEqual(proposed.nameAvailable, false);
	});

	test('parses extension manifests directly and ignores metadata-only rewrites semantically', async () => {
		const profile = await profilesService.createNamedProfile('Extensions');
		const firstManifest = [{ identifier: { id: 'Pub.One', uuid: SECOND_UUID }, version: '1.2.3', metadata: { id: FIRST_UUID, preRelease: false }, location: { path: '/first' } }];
		await fileService.writeFile(profile.extensionsResource, VSBuffer.fromString(JSON.stringify(firstManifest)));
		const reader = new EditorMigrationTargetReader(fileService, profilesService);
		const first = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['extensions'], environment, [], CancellationToken.None);
		const firstExtensions = first.categories[0];
		assert.ok(firstExtensions?.category === 'extensions');
		assert.strictEqual(firstExtensions.value?.[0]?.uuid, FIRST_UUID);

		firstManifest[0].location.path = '/metadata-only-rewrite';
		await fileService.writeFile(profile.extensionsResource, VSBuffer.fromString(JSON.stringify(firstManifest)));
		const second = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['extensions'], environment, [], CancellationToken.None);

		assert.notStrictEqual(first.categories[0].contentHash, second.categories[0].contentHash);
		assert.strictEqual(first.categories[0].semanticHash, second.categories[0].semanticHash);
		assert.strictEqual(first.fingerprint, second.fingerprint);

		firstManifest[0].metadata.id = THIRD_UUID;
		await fileService.writeFile(profile.extensionsResource, VSBuffer.fromString(JSON.stringify(firstManifest)));
		const uuidDrift = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['extensions'], environment, [], CancellationToken.None);
		assert.notStrictEqual(uuidDrift.categories[0].semanticHash, second.categories[0].semanticHash);
		assert.notStrictEqual(uuidDrift.fingerprint, second.fingerprint);
	});

	test('reads effective named and inherited Default extension membership', async () => {
		await fileService.writeFile(profilesService.defaultProfile.extensionsResource, VSBuffer.fromString(JSON.stringify([
			{ id: 'pub.application', version: '1.0.0', metadata: { id: FIRST_UUID, isApplicationScoped: true } },
			{ id: 'pub.default-only', version: '1.0.0', metadata: { id: SECOND_UUID } },
		])));
		const named = await profilesService.createNamedProfile('Named extensions');
		await fileService.writeFile(named.extensionsResource, VSBuffer.fromString(JSON.stringify([
			{ id: 'pub.named', version: '1.0.0', metadata: { id: THIRD_UUID } },
		])));
		const inherited = await profilesService.createNamedProfile('Inherited extensions', { useDefaultFlags: { extensions: true } });
		const reader = new EditorMigrationTargetReader(fileService, profilesService);

		const namedSnapshot = await reader.inspect({ kind: 'existing', profileId: named.id }, ['extensions'], environment, [], CancellationToken.None);
		const inheritedSnapshot = await reader.inspect({ kind: 'existing', profileId: inherited.id }, ['extensions'], environment, [], CancellationToken.None);
		const namedExtensions = namedSnapshot.categories[0];
		const inheritedExtensions = inheritedSnapshot.categories[0];

		assert.ok(namedExtensions?.category === 'extensions');
		assert.deepStrictEqual(namedExtensions.value?.map(extension => extension.id), ['pub.application', 'pub.named']);
		assert.ok(inheritedExtensions?.category === 'extensions');
		assert.deepStrictEqual([inheritedExtensions.ownership, inheritedExtensions.ownerProfileId], ['default', profilesService.defaultProfile.id]);
		assert.deepStrictEqual(inheritedExtensions.value?.map(extension => extension.id), ['pub.application', 'pub.default-only']);
	});

	test('canonicalizes absent snippets and rejects disappearing or changing directories', async () => {
		const profile = await profilesService.createNamedProfile('Snippets');
		const reader = new EditorMigrationTargetReader(fileService, profilesService);
		const missing = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['snippets'], environment, [], CancellationToken.None);
		await fileService.createFolder(profile.snippetsHome);
		const empty = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['snippets'], environment, [], CancellationToken.None);

		assert.deepStrictEqual([missing.categories[0].state, empty.categories[0].state], ['absent', 'absent']);
		assert.strictEqual(empty.categories[0].contentHash, missing.categories[0].contentHash);

		const snippetResource = joinPath(profile.snippetsHome, 'typescript.json');
		await fileService.writeFile(snippetResource, VSBuffer.fromString('{"Log":{"prefix":"log","body":["console.log($1)"]}}'));
		const nonEmpty = await reader.inspect({ kind: 'existing', profileId: profile.id }, ['snippets'], environment, [], CancellationToken.None);
		const nonEmptySnippets = nonEmpty.categories[0];
		assert.ok(nonEmptySnippets?.category === 'snippets');
		assert.strictEqual(nonEmptySnippets.state, 'present');
		assert.deepStrictEqual(nonEmptySnippets.value?.map(snippet => snippet.name), ['typescript.json']);

		let removed = false;
		const disappearingFiles = new Proxy(fileService, {
			get(target, property, receiver) {
				if (property === 'resolve') {
					return async (resource: URI) => {
						const result = await target.resolve(resource);
						if (!removed && resource.toString() === profile.snippetsHome.toString()) {
							removed = true;
							await target.del(snippetResource);
						}
						return result;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		await assert.rejects(
			() => new EditorMigrationTargetReader(disappearingFiles, profilesService).inspect({ kind: 'existing', profileId: profile.id }, ['snippets'], environment, [], CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'resourceUnavailable' && /disappeared/.test(error.message),
		);

		await fileService.writeFile(snippetResource, VSBuffer.fromString('{}'));
		const changingDirectoryFiles = new Proxy(fileService, {
			get(target, property, receiver) {
				if (property === 'stat') {
					return async (resource: URI) => {
						const stat = await target.stat(resource);
						return resource.toString() === profile.snippetsHome.toString() ? { ...stat, mtime: stat.mtime + 1 } : stat;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		await assert.rejects(
			() => new EditorMigrationTargetReader(changingDirectoryFiles, profilesService).inspect({ kind: 'existing', profileId: profile.id }, ['snippets'], environment, [], CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'resourceUnavailable' && /snippets changed/.test(error.message),
		);
	});

	test('rejects malformed manifests, changing resources, and cancellation', async () => {
		const profile = await profilesService.createNamedProfile('Unsafe');
		await fileService.writeFile(profile.extensionsResource, VSBuffer.fromString('{'));
		const reader = new EditorMigrationTargetReader(fileService, profilesService);
		await assert.rejects(
			() => reader.inspect({ kind: 'existing', profileId: profile.id }, ['extensions'], environment, [], CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'invalidExtensionManifest',
		);

		await fileService.writeFile(profile.settingsResource, VSBuffer.fromString('{}'));
		let statCalls = 0;
		const changingFiles = new Proxy(fileService, {
			get(target, property, receiver) {
				if (property === 'stat') {
					return async (resource: URI) => {
						const stat = await target.stat(resource);
						statCalls++;
						return statCalls === 2 ? { ...stat, mtime: stat.mtime + 1 } : stat;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		await assert.rejects(
			() => new EditorMigrationTargetReader(changingFiles, profilesService).inspect({ kind: 'existing', profileId: profile.id }, ['settings'], environment, [], CancellationToken.None),
			/resource changed during planning read/,
		);

		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		await assert.rejects(
			() => reader.inspect({ kind: 'existing', profileId: profile.id }, ['settings'], environment, [], cancellation.token),
			(error: unknown) => error instanceof CancellationError,
		);
		cancellation.dispose();

		const duringReadCancellation = new CancellationTokenSource();
		const cancelingFiles = new Proxy(fileService, {
			get(target, property, receiver) {
				if (property === 'readFileStream') {
					return async (...args: Parameters<FileService['readFileStream']>) => {
						const result = await target.readFileStream(...args);
						duringReadCancellation.cancel();
						return result;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		await assert.rejects(
			() => new EditorMigrationTargetReader(cancelingFiles, profilesService).inspect({ kind: 'existing', profileId: profile.id }, ['settings'], environment, [], duringReadCancellation.token),
			(error: unknown) => error instanceof CancellationError,
		);
		duringReadCancellation.dispose();
	});

	test('uses the renderer-safe extension target platform with controlled gallery evidence', async () => {
		const calls: string[] = [];
		const galleryQueries: IExtensionQueryOptions[] = [];
		const galleryExtension = {
			type: 'gallery',
			identifier: { id: 'pub.available', uuid: 'gallery-uuid' },
			version: '2.0.0',
			properties: { targetPlatform: TargetPlatform.LINUX_X64, isPreReleaseVersion: false, engine: '^1.100.0' },
		} as unknown as IGalleryExtension;
		const scannerService = new Proxy({
			scanSystemExtensions: async () => {
				calls.push('scanSystemExtensions');
				return [];
			},
		}, {
			get(target, property, receiver) {
				if (Reflect.has(target, property)) {
					return Reflect.get(target, property, receiver);
				}
				if (typeof property === 'string' && property.startsWith('scan')) {
					return () => {
						calls.push(property);
						throw new Error(`Unexpected scanner call '${property}'`);
					};
				}
				return undefined;
			},
		}) as unknown as IExtensionsScannerService;
		const galleryService = {
			isEnabled: () => true,
			getExtensions: async (_extensions: readonly IExtensionInfo[], options: IExtensionQueryOptions) => {
				galleryQueries.push(options);
				return [galleryExtension];
			},
			getCompatibleExtension: async () => {
				calls.push('getCompatibleExtension');
				return galleryExtension;
			},
			isExtensionCompatible: async () => true,
		} as unknown as IExtensionGalleryService;
		const service = new EditorMigrationPlanningService(
			fileService,
			mutationRejectingProxy(profilesService, calls),
			scannerService,
			galleryService,
			{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
			{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
			{ readSourceProfile: async () => sourceSnapshot() } as unknown as IEditorMigrationSourceService,
			rendererExtensionManagement(TargetPlatform.LINUX_ARM64),
		);

		const target = await service.inspectTarget({ kind: 'existing', profileId: profilesService.defaultProfile.id }, ['extensions'], CancellationToken.None);
		const draft = await service.createDraftFromCurrentEvidence(sourceSnapshot(), target, CancellationToken.None);

		assert.deepStrictEqual(calls, ['scanSystemExtensions', 'getCompatibleExtension']);
		assert.strictEqual(galleryQueries.length, 1);
		assert.strictEqual(galleryQueries[0].compatible, false);
		assert.strictEqual(galleryQueries[0].targetPlatform, target.environment.targetPlatform);
		assert.strictEqual(target.environment.targetPlatform, TargetPlatform.LINUX_ARM64);
		assert.deepStrictEqual(draft.evidence.gallery, [{
			id: 'pub.available',
			requestedChannel: 'preRelease',
			status: 'available',
			uuid: 'gallery-uuid',
			version: '2.0.0',
			targetPlatform: 'linux-x64',
			selectedChannel: 'stable',
			engine: '^1.100.0',
			galleryIdentity: 'open-vsx',
		}]);
		assert.ok(draft.warnings.some(warning => warning.code === 'preReleaseFellBackToStable'));
	});

	test('distinguishes gallery unavailability and cancels during gallery inspection', async () => {
		const target = emptyExtensionTarget(profilesService.defaultProfile.id);
		const disabled = planningServiceWithGallery(fileService, profilesService, {
			isEnabled: () => false,
		});
		await assert.rejects(
			() => disabled.createDraftFromCurrentEvidence(sourceSnapshot(), target, CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'galleryUnavailable',
		);
		const failing = planningServiceWithGallery(fileService, profilesService, {
			isEnabled: () => true,
			getExtensions: async () => { throw new Error('network failure'); },
		});
		await assert.rejects(
			() => failing.createDraftFromCurrentEvidence(sourceSnapshot(), target, CancellationToken.None),
			(error: unknown) => error instanceof EditorMigrationPlanningError && error.code === 'galleryUnavailable',
		);

		const cancellation = new CancellationTokenSource();
		const canceled = planningServiceWithGallery(fileService, profilesService, {
			isEnabled: () => true,
			getExtensions: async () => {
				cancellation.cancel();
				return [];
			},
		});
		await assert.rejects(
			() => canceled.createDraftFromCurrentEvidence(sourceSnapshot(), target, cancellation.token),
			(error: unknown) => error instanceof CancellationError,
		);
		cancellation.dispose();
	});

	test('reports each non-gallery verification drift independently without mutation', async () => {
		const current = { source: settingsSourceSnapshot('source-content'), target: settingsTarget(profilesService.defaultProfile.id, 'target-content') };
		let sourceUnavailable = false;
		const service = new EditorMigrationPlanningService(
			fileService,
			mutationRejectingProxy(profilesService, []),
			{ scanSystemExtensions: async () => [] } as unknown as IExtensionsScannerService,
			{ isEnabled: () => true } as unknown as IExtensionGalleryService,
			{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
			{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
			{
				readSourceProfile: async () => {
					if (sourceUnavailable) {
						throw new Error('stale source ref');
					}
					return current.source;
				},
			} as unknown as IEditorMigrationSourceService,
			rendererExtensionManagement(),
		);
		service.inspectTarget = async () => current.target;
		const draft = await service.createDraftFromCurrentEvidence(current.source, current.target, CancellationToken.None);
		const plan = await service.acceptDraft(draft, {
			selectedCategories: ['settings'],
			decisions: draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => ({ id: decision.id, choice: 'preserveTarget' })),
		});

		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unchanged', reasons: [] });
		current.source = settingsSourceSnapshot('changed-source');
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['sourceChanged'] });
		current.source = settingsSourceSnapshot('source-content');
		current.target = settingsTarget(profilesService.defaultProfile.id, 'changed-target');
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['targetContentChanged'] });
		current.target = { ...settingsTarget(profilesService.defaultProfile.id, 'target-content'), categories: [{ ...settingsTarget(profilesService.defaultProfile.id, 'target-content').categories[0], ownership: 'default', ownerProfileId: 'other' }] };
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['targetOwnershipChanged'] });
		current.target = { ...settingsTarget(profilesService.defaultProfile.id, 'target-content'), catalogFingerprint: 'changed-catalog' };
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['profileCatalogChanged'] });
		current.target = { ...settingsTarget(profilesService.defaultProfile.id, 'target-content'), environment: { ...environment, productVersion: '2.0.0' } };
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['environmentChanged'] });
		current.target = settingsTarget(profilesService.defaultProfile.id, 'target-content');
		const changedChoices = JSON.parse(JSON.stringify(plan)) as EditorMigrationReviewedPlan;
		(changedChoices.choices.decisions[0] as { choice: 'import' | 'preserveTarget' }).choice = 'import';
		assert.deepStrictEqual(await service.verifyPlan(changedChoices, CancellationToken.None), { status: 'changed', reasons: ['choicesChanged'] });

		const policyDraft = service.createDraft(current.source, current.target, {
			registryIgnoredSettings: ['editor.fontSize'],
			normalizedKeys: {},
			keybindingPlatform: '',
			gallery: [],
		});
		const policyPlan = await service.acceptDraft(policyDraft, { selectedCategories: ['settings'], decisions: [] });
		assert.deepStrictEqual(await service.verifyPlan(policyPlan, CancellationToken.None), { status: 'changed', reasons: ['policyChanged'] });

		current.target = proposedSettingsTarget(true, 'proposed-catalog');
		const proposedDraft = await service.createDraftFromCurrentEvidence(current.source, current.target, CancellationToken.None);
		const proposedPlan = await service.acceptDraft(proposedDraft, { selectedCategories: ['settings'], decisions: [] });
		current.target = proposedSettingsTarget(false, 'occupied-catalog');
		assert.deepStrictEqual(await service.verifyPlan(proposedPlan, CancellationToken.None), { status: 'changed', reasons: ['proposedNameChanged'] });
		current.target = settingsTarget(profilesService.defaultProfile.id, 'target-content');
		sourceUnavailable = true;
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unavailable', reasons: ['sourceUnavailable'] });
	});

	test('maps target eligibility drift separately from target resource failures', async () => {
		const source = settingsSourceSnapshot('source-content');
		const target = settingsTarget(profilesService.defaultProfile.id, 'target-content');
		const service = new EditorMigrationPlanningService(
			fileService,
			mutationRejectingProxy(profilesService, []),
			{ scanSystemExtensions: async () => [] } as unknown as IExtensionsScannerService,
			{ isEnabled: () => true } as unknown as IExtensionGalleryService,
			{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
			{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
			{ readSourceProfile: async () => source } as unknown as IEditorMigrationSourceService,
			rendererExtensionManagement(),
		);
		service.inspectTarget = async () => target;
		const draft = await service.createDraftFromCurrentEvidence(source, target, CancellationToken.None);
		const plan = await service.acceptDraft(draft, {
			selectedCategories: ['settings'],
			decisions: draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => ({ id: decision.id, choice: 'preserveTarget' })),
		});

		for (const code of ['targetNotFound', 'ineligibleTarget'] as const) {
			service.inspectTarget = async () => { throw new EditorMigrationPlanningError(code, code); };
			assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unavailable', reasons: ['profileCatalogChanged'] });
		}
		for (const code of ['resourceUnavailable', 'invalidExtensionManifest'] as const) {
			service.inspectTarget = async () => { throw new EditorMigrationPlanningError(code, code); };
			assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unavailable', reasons: ['targetContentChanged'] });
		}
	});

	test('keeps a reviewed exact gallery coordinate valid when latest advances', async () => {
		let latestVersion = '1.0.0';
		let exactAvailable = true;
		const extension = (version: string) => ({
			type: 'gallery',
			identifier: { id: 'pub.available', uuid: 'gallery-uuid' },
			version,
			properties: { targetPlatform: TargetPlatform.LINUX_X64, isPreReleaseVersion: false, engine: '^1.100.0' },
		} as unknown as IGalleryExtension);
		const target = emptyExtensionTarget(profilesService.defaultProfile.id);
		const source = sourceSnapshot();
		const gallery = {
			isEnabled: () => true,
			getExtensions: async (queries: readonly IExtensionInfo[]) => {
				const requestedVersion = queries[0].version;
				return requestedVersion ? exactAvailable ? [extension(requestedVersion)] : [] : [extension(latestVersion)];
			},
			getCompatibleExtension: async (candidate: IGalleryExtension) => candidate,
			isExtensionCompatible: async () => true,
		} as unknown as IExtensionGalleryService;
		const service = new EditorMigrationPlanningService(
			fileService,
			mutationRejectingProxy(profilesService, []),
			{ scanSystemExtensions: async () => [] } as unknown as IExtensionsScannerService,
			gallery,
			{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
			{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
			{ readSourceProfile: async () => source } as unknown as IEditorMigrationSourceService,
			rendererExtensionManagement(),
		);
		service.inspectTarget = async () => target;
		const draft = await service.createDraftFromCurrentEvidence(source, target, CancellationToken.None);
		const plan = await service.acceptDraft(draft, { selectedCategories: ['extensions'], decisions: [] });

		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unchanged', reasons: [] });
		latestVersion = '2.0.0';
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unchanged', reasons: [] });
		exactAvailable = false;
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['galleryChanged'] });
	});

	test('reopens review when compact unavailable evidence is reclassified', async () => {
		let available = false;
		const extension = {
			type: 'gallery',
			identifier: { id: 'pub.available', uuid: 'gallery-uuid' },
			version: '1.0.0',
			properties: { targetPlatform: TargetPlatform.LINUX_X64, isPreReleaseVersion: false, engine: '^1.100.0' },
		} as unknown as IGalleryExtension;
		const target = emptyExtensionTarget(profilesService.defaultProfile.id);
		const source = sourceSnapshot();
		const gallery = {
			isEnabled: () => true,
			getExtensions: async () => available ? [extension] : [],
			getCompatibleExtension: async () => available ? extension : null,
			isExtensionCompatible: async () => true,
		} as unknown as IExtensionGalleryService;
		const service = new EditorMigrationPlanningService(
			fileService,
			mutationRejectingProxy(profilesService, []),
			{ scanSystemExtensions: async () => [] } as unknown as IExtensionsScannerService,
			gallery,
			{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
			{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
			{ readSourceProfile: async () => source } as unknown as IEditorMigrationSourceService,
			rendererExtensionManagement(),
		);
		service.inspectTarget = async () => target;
		const draft = await service.createDraftFromCurrentEvidence(source, target, CancellationToken.None);
		const plan = await service.acceptDraft(draft, { selectedCategories: ['extensions'], decisions: [] });

		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'unchanged', reasons: [] });
		available = true;
		assert.deepStrictEqual(await service.verifyPlan(plan, CancellationToken.None), { status: 'changed', reasons: ['galleryChanged'] });
	});
});

function planningServiceWithGallery(
	fileService: FileService,
	profilesService: InMemoryUserDataProfilesService,
	gallery: Partial<IExtensionGalleryService>,
): EditorMigrationPlanningService {
	return new EditorMigrationPlanningService(
		fileService,
		profilesService,
		{ scanSystemExtensions: async () => [] } as unknown as IExtensionsScannerService,
		gallery as IExtensionGalleryService,
		{ resolveUserBindings: async () => ({}) } as unknown as IUserDataSyncUtilService,
		{ ...product, version: '1.100.0', hucodeVersion: '0.0.1', extensionsGallery: { serviceUrl: 'open-vsx' } } as IProductService,
		{ readSourceProfile: async () => sourceSnapshot() } as unknown as IEditorMigrationSourceService,
		rendererExtensionManagement(),
	);
}

function rendererExtensionManagement(targetPlatform = TargetPlatform.LINUX_X64): IExtensionManagementService {
	return {
		getTargetPlatform: async () => targetPlatform,
	} as unknown as IExtensionManagementService;
}

function sourceSnapshot(): EditorMigrationSourceSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:gallery' },
		adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' },
		categories: [{ category: 'extensions', state: 'present', value: [{ id: 'pub.available', version: '1.0.0', preRelease: true }] }],
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['extensions'], entries: [], value: 'source' },
	};
}

function emptyExtensionTarget(profileId: string): EditorMigrationTargetSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'existing', profileId },
		profile: { id: profileId, name: 'Default', kind: 'default' },
		eligible: true,
		catalogFingerprint: 'catalog',
		requestedCategories: ['extensions'],
		categories: [{ category: 'extensions', ownership: 'target', ownerProfileId: profileId, state: 'absent', contentHash: 'absent', semanticHash: 'empty', value: [] }],
		environment,
		builtIns: [],
		fingerprint: 'target',
	};
}

function settingsSourceSnapshot(contentHash: string): EditorMigrationSourceSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:settings' },
		adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' },
		categories: [{ category: 'settings', state: 'present', value: { 'editor.fontSize': 16 } }],
		diagnostics: [],
		fingerprint: {
			schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
			algorithm: 'sha256',
			categories: ['settings'],
			entries: [{ category: 'settings', identityDigest: 'settings', state: 'present', contentHash }],
			value: contentHash,
		},
	};
}

function settingsTarget(profileId: string, contentHash: string): EditorMigrationTargetSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'existing', profileId },
		profile: { id: profileId, name: 'Default', kind: 'default' },
		eligible: true,
		catalogFingerprint: 'catalog',
		requestedCategories: ['settings'],
		categories: [{ category: 'settings', ownership: 'target', ownerProfileId: profileId, state: 'present', contentHash, value: { 'editor.fontSize': 14 } }],
		environment,
		builtIns: [],
		fingerprint: contentHash,
	};
}

function proposedSettingsTarget(nameAvailable: boolean, catalogFingerprint: string): EditorMigrationTargetSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'proposed', name: 'New profile' },
		eligible: true,
		nameAvailable,
		catalogFingerprint,
		requestedCategories: ['settings'],
		categories: [{ category: 'settings', ownership: 'target', state: 'absent', contentHash: 'absent', value: {} }],
		environment,
		builtIns: [],
		fingerprint: catalogFingerprint,
	};
}

function mutationRejectingProxy(profilesService: InMemoryUserDataProfilesService, mutations: string[]): InMemoryUserDataProfilesService {
	const mutationMethods = new Set(['createNamedProfile', 'createProfile', 'createTransientProfile', 'removeProfile', 'updateProfile', 'setProfileForWorkspace']);
	return new Proxy(profilesService, {
		get(target, property, receiver) {
			if (typeof property === 'string' && mutationMethods.has(property)) {
				return () => {
					mutations.push(property);
					throw new Error(`Unexpected profile mutation '${property}'`);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
