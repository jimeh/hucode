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
import { FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { EditorMigrationOperationStore } from '../../browser/migration/editorMigrationOperationStore.js';
import { EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EDITOR_MIGRATION_POLICY_VERSION, EditorMigrationTargetSnapshot } from '../../common/migration/editorMigrationPlanning.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft } from '../../common/migration/editorMigrationPlanner.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';

const ROOT = URI.from({ scheme: 'hucode-migration-store-test', path: '/User' });

suite('EditorMigrationOperationStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: FileService;
	let store: EditorMigrationOperationStore;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new AtomicInMemoryFileSystemProvider());
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
		await fileService.createFolder(joinPath(store.root, 'future'));
		await fileService.writeFile(joinPath(store.root, 'future', 'operation.json'), VSBuffer.fromString('{"schemaVersion":99,"id":"future"}'));

		const listed = await store.list();
		assert.deepStrictEqual(listed.map(item => [item.id, item.unsupportedSchemaVersion]), [['future', 99], ['supported', undefined]]);
		assert.strictEqual((await fileService.readFile(joinPath(store.root, 'future', 'operation.json'))).value.toString(), '{"schemaVersion":99,"id":"future"}');

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
});

class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicRead | FileSystemProviderCapabilities.FileAtomicWrite;
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
		schemaVersion: 1,
		id,
		revision: 0,
		createdAt: 10,
		updatedAt: 10,
		plan: reviewedPlan,
		authorization: { planningSchemaVersion: 2, planFingerprint, publishers: [], publisherSetFingerprint: 'publishers', issuedAt: 1, consumedAt: 2 },
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
