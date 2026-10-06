/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../base/common/buffer.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { EditorMigrationOperationStore } from '../../browser/migration/editorMigrationOperationStore.js';
import { EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION, EditorMigrationOperation, createEditorMigrationOperationIntegrity } from '../../common/migration/editorMigrationApply.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EDITOR_MIGRATION_POLICY_VERSION, EditorMigrationTargetSnapshot } from '../../common/migration/editorMigrationPlanning.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft } from '../../common/migration/editorMigrationPlanner.js';
import { fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';

const ROOT = URI.from({ scheme: 'hucode-migration-store-test', path: '/User' });

suite('EditorMigrationOperationStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let provider: AtomicInMemoryFileSystemProvider;
	let store: EditorMigrationOperationStore;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		provider = disposables.add(new AtomicInMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(ROOT.scheme, provider));
		store = new EditorMigrationOperationStore(fileService, joinPath(ROOT, 'settings.json'));
	});

	test('atomically revisions journals and retains separately hashed snapshot payloads', async () => {
		const initial = await operation('one');
		await store.create(initial);
		assert.deepStrictEqual(await store.read('one'), initial);

		const snapshotPath = await store.writeSnapshot('one', 'snippets/example.json', VSBuffer.fromString('private contents'));
		assert.strictEqual(snapshotPath, 'snippets/example.json');
		assert.strictEqual((await store.readSnapshot('one', snapshotPath)).toString(), 'private contents');

		const updated = await store.update(initial, { ...initial, stage: 'applying' }, 20);
		assert.strictEqual(updated.revision, 1);
		assert.strictEqual(updated.updatedAt, 20);
		await assert.rejects(() => store.update(initial, initial), /revision changed/);
	});

	test('lists unknown schemas without rewriting and removes acknowledged private data', async () => {
		await store.create(await operation('supported'));
		await fileService.createFolder(joinPath(store.root, 'legacy'));
		await fileService.writeFile(joinPath(store.root, 'legacy', 'operation.json'), VSBuffer.fromString('{"schemaVersion":1,"id":"legacy"}'));
		await fileService.createFolder(joinPath(store.root, 'future'));
		await fileService.writeFile(joinPath(store.root, 'future', 'operation.json'), VSBuffer.fromString('{"schemaVersion":99,"id":"future"}'));

		const listed = await store.list();
		assert.deepStrictEqual(listed.map(item => [item.id, item.unsupportedSchemaVersion]), [['future', 99], ['legacy', 1], ['supported', undefined]]);
		assert.strictEqual((await fileService.readFile(joinPath(store.root, 'future', 'operation.json'))).value.toString(), '{"schemaVersion":99,"id":"future"}');
		assert.strictEqual((await fileService.readFile(joinPath(store.root, 'legacy', 'operation.json'))).value.toString(), '{"schemaVersion":1,"id":"legacy"}');

		await store.delete('supported');
		assert.strictEqual(await fileService.exists(joinPath(store.root, 'supported')), false);
	});

	test('rejects traversal in operation and snapshot paths', async () => {
		await assert.rejects(() => operation('../escape').then(value => store.create(value)), /invalid segment/);
		await store.create(await operation('safe'));
		await assert.rejects(() => store.writeSnapshot('safe', '../escape', VSBuffer.fromString('no')), /invalid segment/);
	});

	test('rejects admission when the operation provider cannot guarantee atomic storage', async () => {
		const root = URI.from({ scheme: 'hucode-migration-non-atomic', path: '/User' });
		const nonAtomicFileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(nonAtomicFileService.registerProvider(root.scheme, disposables.add(new InMemoryFileSystemProvider())));
		const nonAtomicStore = new EditorMigrationOperationStore(nonAtomicFileService, joinPath(root, 'settings.json'));
		await assert.rejects(() => operation('non-atomic').then(value => nonAtomicStore.create(value)), /requires atomic operation storage/);
	});

	test('isolates a corrupt supported record while listing valid recovery operations', async () => {
		await store.create(await operation('valid'));
		const corrupt = await operation('corrupt');
		await fileService.createFolder(joinPath(store.root, 'corrupt'));
		await fileService.writeFile(joinPath(store.root, 'corrupt', 'operation.json'), VSBuffer.fromString(JSON.stringify({ ...corrupt, plan: { ...corrupt.plan, operations: [{ changed: true }] } })));

		const listed = await store.list();
		assert.deepStrictEqual(listed.map(item => [item.id, item.unsupportedSchemaVersion]), [['corrupt', -1], ['valid', undefined]]);
		assert.deepStrictEqual((await store.read('valid')).id, 'valid');
	});

	test('propagates transient journal read failures without misclassifying recovery data', async () => {
		await store.create(await operation('temporarily-unavailable'));
		provider.readFileError = createFileSystemProviderError('temporary journal read failure', FileSystemProviderErrorCode.Unavailable);

		await assert.rejects(() => store.list(), /temporary journal read failure/);
		provider.readFileError = undefined;
		assert.deepStrictEqual((await store.list()).map(item => [item.id, item.unsupportedSchemaVersion]), [['temporarily-unavailable', undefined]]);
	});

	test('skips a journal removed while recovery operations are being enumerated', async () => {
		await store.create(await operation('removed-during-list'));
		provider.readFileError = createFileSystemProviderError('journal removed', FileSystemProviderErrorCode.FileNotFound);

		assert.deepStrictEqual(await store.list(), []);
	});

	test('reads a schema-v2 rollback journal written before mutationStarted existed', async () => {
		const base = await operation('legacy-rollback-intent');
		const legacyIntent = {
			categories: ['settings'],
			forceCategories: [],
			beforeFlags: {},
			afterFlags: {},
			ownershipState: 'pending',
			resources: [],
		};
		const raw = `${JSON.stringify({ ...base, stage: 'rollbackPending', rollbackIntent: legacyIntent })}\n`;
		assert.ok(!raw.includes('mutationStarted'), 'the fixture must reproduce the omission, not an explicit value');
		const resource = joinPath(store.root, base.id, 'operation.json');
		await fileService.writeFile(resource, VSBuffer.fromString(raw));

		const read = await store.read(base.id);
		assert.strictEqual(read.rollbackIntent?.mutationStarted, false, 'the known same-version omission reads as not yet mutated');
		assert.deepStrictEqual((await store.list()).map(item => [item.id, item.recoverable, item.unsupportedSchemaVersion]), [[base.id, true, undefined]]);
		assert.strictEqual((await fileService.readFile(resource)).value.toString(), raw, 'reading and listing must not rewrite the journal');

		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({ ...base, stage: 'rollbackPending', rollbackIntent: { ...legacyIntent, mutationStarted: 'yes' } })));
		await assert.rejects(() => store.read(base.id), /unsupported or corrupt/, 'an explicit non-boolean stays corrupt');
		assert.deepStrictEqual((await store.list()).map(item => [item.id, item.unsupportedSchemaVersion]), [[base.id, -1]]);

		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({ ...base, stage: 'rollbackPending', rollbackIntent: 'corrupt' })));
		await assert.rejects(() => store.read(base.id), /unsupported or corrupt/, 'a malformed rollback intent must not be normalized into a supported record');

		for (const rollbackIntent of [
			{ ...legacyIntent, categories: ['extensions'] },
			{ ...legacyIntent, beforeFlags: [] },
			{ ...legacyIntent, afterFlags: { settings: 'yes' } },
			{ ...legacyIntent, resources: [{}] },
		]) {
			await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({ ...base, stage: 'rollbackPending', rollbackIntent })));
			await assert.rejects(() => store.read(base.id), /unsupported or corrupt/, 'malformed nested rollback data must not be normalized');
			assert.deepStrictEqual((await store.list()).map(item => [item.id, item.unsupportedSchemaVersion]), [[base.id, -1]]);
		}

		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({ ...base, stage: 'rollbackPending', rollbackIntent: { ...legacyIntent, mutationStarted: true } })));
		assert.strictEqual((await store.read(base.id)).rollbackIntent?.mutationStarted, true, 'an explicit value is preserved');
	});

	test('reads planner-independent persisted evidence but rejects aggregate fingerprint tampering', async () => {
		const original = await operation('planner-independent');
		const changedPlan = {
			...original.plan,
			source: {
				...original.plan.source,
				categories: [{ category: 'settings' as const, state: 'present' as const, value: { changedAfterAdmission: true } }],
			},
		};
		const changedSource: EditorMigrationOperation = {
			...original, plan: {
				...changedPlan,
			},
			integrity: await createEditorMigrationOperationIntegrity(changedPlan),
		};
		await store.create(changedSource);
		assert.deepStrictEqual((await store.read(changedSource.id)).plan.source.categories, changedSource.plan.source.categories);

		const mutations = [
			{ ...changedSource.plan, target: { ...changedSource.plan.target, catalogFingerprint: 'tampered' } },
			{ ...changedSource.plan, evidence: { ...changedSource.plan.evidence, keybindingPlatform: 'tampered' } },
			{ ...changedSource.plan, choices: { ...changedSource.plan.choices, selectedCategories: [] } },
		];
		for (const plan of mutations) {
			await writeRawOperation(fileService, store, { ...changedSource, plan });
			await assert.rejects(() => store.read(changedSource.id), /unsupported or corrupt/);
			assert.deepStrictEqual((await store.list()).map(item => [item.id, item.unsupportedSchemaVersion]), [[changedSource.id, -1]]);
		}

		const tamperedAggregatePlan = { ...changedSource.plan, fingerprints: { ...changedSource.plan.fingerprints, plan: 'tampered' } };
		await writeRawOperation(fileService, store, {
			...changedSource,
			plan: tamperedAggregatePlan,
			integrity: await createEditorMigrationOperationIntegrity(tamperedAggregatePlan),
			authorization: { ...changedSource.authorization, planFingerprint: 'tampered' },
		});
		await assert.rejects(() => store.read(changedSource.id), /unsupported or corrupt/);
	});
});

class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {
	readFileError: Error | undefined;

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicRead | FileSystemProviderCapabilities.FileAtomicWrite;
	}

	override async readFile(resource: URI): Promise<Uint8Array> {
		if (this.readFileError && resource.path.endsWith('/operation.json')) {
			throw this.readFileError;
		}
		return await super.readFile(resource);
	}
}

async function operation(id: string): Promise<EditorMigrationOperation> {
	const source: EditorMigrationSourceSnapshot = {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:store-test' },
		adapter: { id: 'vscode' as const, productName: 'Visual Studio Code', channel: 'stable' as const, order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' as const },
		categories: [{ category: 'settings' as const, state: 'present' as const, value: {} }], diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256' as const, categories: ['settings' as const], entries: [], value: 'store-source' },
	};
	const target: EditorMigrationTargetSnapshot = {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'existing' as const, profileId: 'default' }, profile: { id: 'default', name: 'Default', kind: 'default' as const }, eligible: true,
		catalogFingerprint: 'catalog', requestedCategories: ['settings' as const],
		categories: [{ category: 'settings' as const, ownership: 'target' as const, ownerProfileId: 'default', state: 'absent' as const, contentHash: 'absent', value: {} }],
		environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.1', galleryIdentity: 'open-vsx', policyVersion: EDITOR_MIGRATION_POLICY_VERSION },
		builtIns: [], fingerprint: 'target',
	};
	const draft = createEditorMigrationPlanDraft(source, target, { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: '', gallery: [] });
	const reviewedPlan = await acceptEditorMigrationPlanDraft(draft, { selectedCategories: ['settings'], decisions: [] });
	const planFingerprint = reviewedPlan.fingerprints.plan;
	return {
		schemaVersion: EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
		id,
		revision: 0,
		createdAt: 10,
		updatedAt: 10,
		plan: reviewedPlan,
		integrity: await createEditorMigrationOperationIntegrity(reviewedPlan),
		authorization: { planningSchemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, planFingerprint, publishers: [], publisherSetFingerprint: await fingerprintEditorMigrationValue([]), issuedAt: 1, consumedAt: 2 },
		stage: 'admitted',
		cancellationRequested: false,
		target: { state: 'pending' },
		snapshots: [],
		extensionInstallIntents: [],
		retryItemIds: [],
		rollbackDriftSnapshots: [],
		results: [],
		acknowledged: false,
	};
}

async function writeRawOperation(fileService: FileService, store: EditorMigrationOperationStore, operation: EditorMigrationOperation): Promise<void> {
	await fileService.writeFile(joinPath(store.root, operation.id, 'operation.json'), VSBuffer.fromString(JSON.stringify(operation)));
}
