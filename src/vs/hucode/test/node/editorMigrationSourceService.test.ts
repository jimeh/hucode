/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { join } from '../../../base/common/path.js';
import { basename, dirname, joinPath } from '../../../base/common/resources.js';
import { newWriteableStream } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileType } from '../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { EditorMigrationCategorySnapshot } from '../../common/migration/editorMigrationSource.js';
import { getEditorMigrationSourceAdapter } from '../../node/migration/editorMigrationSourceAdapters.js';
import {
	EDITOR_MIGRATION_SETTINGS_MAX_BYTES,
	EditorMigrationPathEnvironment,
	EditorMigrationSourceService,
	resolveEditorMigrationCandidatePaths,
} from '../../node/migration/editorMigrationSourceService.js';
import {
	EditorMigrationSourceDirectoryEntry,
	EditorMigrationSourceFileError,
	EditorMigrationSourceFileStat,
	EditorMigrationSourceOperationScheduler,
	EditorMigrationSourceReadLimits,
	IEditorMigrationDiskProvider,
	IEditorMigrationSourceFileSystem,
	NativeEditorMigrationDiskProvider,
	NativeEditorMigrationSourceFileSystem,
} from '../../node/migration/editorMigrationSourceFileSystem.js';

suite('EditorMigrationSourceService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves conventional paths for every supported platform', () => {
		const adapters = [
			['vscode', 'Code', '.vscode'],
			['vscode-insiders', 'Code - Insiders', '.vscode-insiders'],
			['cursor', 'Cursor', '.cursor'],
		] as const;
		const cases = [
			{
				environment: { platform: 'darwin', homePath: '/Users/jim' } as const,
				expected: (product: string, extensions: string) => [`/Users/jim/Library/Application Support/${product}/User`, `/Users/jim/${extensions}/extensions`],
			},
			{
				environment: { platform: 'linux', homePath: '/home/jim' } as const,
				expected: (product: string, extensions: string) => [`/home/jim/.config/${product}/User`, `/home/jim/${extensions}/extensions`],
			},
			{
				environment: { platform: 'linux', homePath: '/home/jim', xdgConfigHome: '/xdg' } as const,
				expected: (product: string, extensions: string) => [`/xdg/${product}/User`, `/home/jim/${extensions}/extensions`],
			},
			{
				environment: { platform: 'win32', homePath: 'C:\\Users\\jim', appDataPath: 'D:\\Roaming' } as const,
				expected: (product: string, extensions: string) => [`d:\\Roaming\\${product}\\User`, `c:\\Users\\jim\\${extensions}\\extensions`],
			},
		];

		for (const [adapter, product, extensions] of adapters) {
			for (const testCase of cases) {
				assert.deepStrictEqual(paths(adapter, testCase.environment), testCase.expected(product, extensions));
			}
		}
	});

	test('discovers every supported adapter across every supported default layout', async () => {
		const environments: readonly EditorMigrationPathEnvironment[] = [
			{ platform: 'darwin', homePath: '/Users/jim' },
			{ platform: 'linux', homePath: '/home/jim' },
			{ platform: 'linux', homePath: '/home/jim', xdgConfigHome: '/xdg' },
			{ platform: 'win32', homePath: 'C:\\Users\\jim', appDataPath: 'D:\\Roaming' },
		];
		for (const environment of environments) {
			for (const adapter of ['vscode', 'vscode-insiders', 'cursor'] as const) {
				const fileSystem = new FixtureFileSystem();
				populateDefault(fileSystem, adapter, environment);
				const service = new EditorMigrationSourceService(fileSystem, environment);
				try {
					const result = await service.discoverSources({}, CancellationToken.None);
					assert.deepStrictEqual(result.sources.map(item => item.adapter.id), [adapter]);
				} finally {
					service.dispose();
				}
			}
		}
	});

	test('reads a temporary editor fixture through the native bounded filesystem', async () => {
		const root = await mkdtemp(join(tmpdir(), 'hucode-editor-migration-'));
		try {
			const environment: EditorMigrationPathEnvironment = {
				platform: 'linux',
				homePath: join(root, 'home'),
				xdgConfigHome: join(root, 'config'),
			};
			const source = resolveEditorMigrationCandidatePaths('vscode', environment);
			await mkdir(join(source.userData.fsPath, 'snippets'), { recursive: true });
			await mkdir(source.extensions.fsPath, { recursive: true });
			await writeFile(join(source.userData.fsPath, 'settings.json'), '{ /* fixture */ "native": true }');
			await writeFile(join(source.userData.fsPath, 'keybindings.json'), '[]');
			await writeFile(join(source.userData.fsPath, 'snippets', 'native.json'), '{"Native":{}}');
			await writeFile(join(source.extensions.fsPath, 'extensions.json'), extensionManifest('native.extension'));

			const provider = disposables.add(new DiskFileSystemProvider(new NullLogService()));
			const service = disposables.add(new EditorMigrationSourceService(new NativeEditorMigrationSourceFileSystem(new NativeEditorMigrationDiskProvider(provider)), environment));
			const result = await service.discoverSources({}, CancellationToken.None);

			assert.deepStrictEqual(result.sources.map(item => [item.adapter.id, item.ranking.completeness]), [['vscode', 4]]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('discovers VS Code, Insiders, and Cursor defaults with deterministic order', async () => {
		const fileSystem = new FixtureFileSystem();
		for (const adapter of ['cursor', 'vscode-insiders', 'vscode'] as const) {
			populateDefault(fileSystem, adapter, linuxEnvironment, { settings: `{"editor":"${adapter}"}` });
		}
		fileSystem.setAllModificationTimes(10);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(source => [source.adapter.id, source.profile.id]), [
			['vscode', 'default'],
			['cursor', 'default'],
			['vscode-insiders', 'default'],
		]);
		assert.deepStrictEqual(result.sources.map(source => source.ranking.completeness), [4, 4, 4]);
	});

	test('ranks from exact snippet file modification evidence', async () => {
		const fileSystem = new FixtureFileSystem();
		populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const cursor = populateDefault(fileSystem, 'cursor', linuxEnvironment);
		fileSystem.setAllModificationTimes(10);
		const newerSnippet = joinPath(cursor.userData, 'snippets', 'language.json');
		fileSystem.addFile(newerSnippet, '{"Newer":{}}');
		fileSystem.setModificationTime(newerSnippet, 20);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => [item.adapter.id, item.ranking.newestModificationTime]), [
			['cursor', 20],
			['vscode', 10],
		]);
	});

	test('keeps Default and valid named profiles when catalog entries are invalid or builtin', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		fileSystem.addFile(joinPath(source.userData, 'globalStorage', 'storage.json'), JSON.stringify({
			userDataProfiles: [
				{ name: 'Work', location: 'work', icon: 'briefcase', useDefaultFlags: { settings: true } },
				{ name: 'Legacy URI', location: joinPath(source.userData, 'profiles', 'legacy-uri').toJSON(), extra: 'ignored' },
				{ name: 'Invalid', location: 'invalid', useDefaultFlags: { mystery: true } },
				{ name: 'Builtin', location: 'builtin' },
				{ name: 'Builtin URI', location: joinPath(source.userData, 'profiles', 'builtin', 'template').toJSON() },
				{ name: 'Foreign authority', location: { ...joinPath(source.userData, 'profiles', 'foreign').toJSON(), authority: 'attacker' } },
				{ name: 'Queried', location: { ...joinPath(source.userData, 'profiles', 'queried').toJSON(), query: 'outside=true' } },
				{ name: 'Fragmented', location: { ...joinPath(source.userData, 'profiles', 'fragmented').toJSON(), fragment: 'outside' } },
			],
		}));
		fileSystem.addFile(joinPath(source.userData, 'profiles', 'work', 'keybindings.json'), '[]');
		fileSystem.addFile(joinPath(source.userData, 'profiles', 'legacy-uri', 'settings.json'), '{"legacy":true}');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => [item.profile.id, item.profile.name]), [
			['default', 'Default'],
			['work', 'Work'],
			['legacy-uri', 'Legacy URI'],
		]);
		assert.deepStrictEqual(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details?.entry]), [
			['unsupportedNamedProfileCatalogSchema', '2'],
			['unsupportedNamedProfileCatalogSchema', '5'],
			['unsupportedNamedProfileCatalogSchema', '6'],
			['unsupportedNamedProfileCatalogSchema', '7'],
		]);
	});

	test('discovers a separately declared Cursor named-profile fixture', async () => {
		const fileSystem = new FixtureFileSystem();
		const fixture = populateCursorNamedFixture(fileSystem, linuxEnvironment);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => [item.adapter.id, item.profile.id]), [
			['cursor', 'default'],
			['cursor', fixture.profileId],
		]);
	});

	test('keeps catalog definitions and fingerprints coherent across catalog races', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const catalogResource = joinPath(source.userData, 'globalStorage', 'storage.json');
		const catalogA = JSON.stringify({ userDataProfiles: [{ name: 'Work A', location: 'work' }] });
		const catalogB = JSON.stringify({ userDataProfiles: [{ name: 'Work B', location: 'work', useDefaultFlags: { settings: true } }] });
		fileSystem.sequenceFile(catalogResource, [catalogA, catalogB]);
		fileSystem.addFile(joinPath(source.userData, 'settings.json'), '{"catalog":"b"}');
		fileSystem.addFile(joinPath(source.userData, 'profiles', 'work', 'settings.json'), '{"catalog":"a"}');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const discovery = await service.discoverSources({}, CancellationToken.None);
		const named = discovery.sources.find(item => item.profile.id === 'work')!;
		assert.strictEqual(fileSystem.fileReadCount(catalogResource), 1);
		assert.strictEqual(named.profile.name, 'Work A');
		assert.strictEqual(named.localPaths.userData.endsWith('/work'), true);
		assert.strictEqual(named.discoveryFingerprint.entries.find(entry => entry.category === 'profileCatalog')?.contentHash, sha256(catalogA));

		const current = await service.readSourceProfile(named.ref, ['settings'], CancellationToken.None);
		assert.strictEqual(fileSystem.fileReadCount(catalogResource), 2);
		assert.strictEqual(current.profile.name, 'Work B');
		assert.deepStrictEqual(categoryValue(current.categories[0]), ['settings', 'present', { catalog: 'b' }]);
		assert.strictEqual(current.fingerprint.entries.find(entry => entry.category === 'profileCatalog')?.contentHash, sha256(catalogB));
		assert.notStrictEqual(current.fingerprint.value, named.discoveryFingerprint.value);
		assert.strictEqual((await service.verifySourceSnapshot(named.ref, named.discoveryFingerprint, CancellationToken.None)).status, 'changed');

		fileSystem.sequenceFile(catalogResource, [JSON.stringify({ userDataProfiles: [] })]);
		const unavailable = await service.verifySourceSnapshot(named.ref, current.fingerprint, CancellationToken.None);
		assert.strictEqual(unavailable.status, 'unavailable');
		assert.deepStrictEqual(unavailable.diagnostics.map(item => item.code), ['unsupportedNamedProfileCatalogSchema']);
	});

	test('falls back to Default resources for every supported inheritance flag', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment, {
			settings: '{ /* comment */ "from": "default" }',
			keybindings: '[ // comment\n { "key": "ctrl+x", "command": "cut" }, ]',
		});
		fileSystem.addFile(joinPath(source.userData, 'globalStorage', 'storage.json'), JSON.stringify({
			userDataProfiles: [{ name: 'Inherited', location: 'inherited', useDefaultFlags: { settings: true, keybindings: true, snippets: true, extensions: true } }],
		}));
		const profileRoot = joinPath(source.userData, 'profiles', 'inherited');
		fileSystem.addFile(joinPath(profileRoot, 'settings.json'), '{"from":"named"}');
		fileSystem.addFile(joinPath(profileRoot, 'keybindings.json'), 'invalid');
		fileSystem.addFile(joinPath(profileRoot, 'snippets', 'named.json'), '{"Named":{}}');
		fileSystem.addFile(joinPath(profileRoot, 'extensions.json'), 'invalid');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		const discovery = await service.discoverSources({}, CancellationToken.None);
		const named = discovery.sources.find(item => item.profile.id === 'inherited')!;

		const snapshot = await service.readSourceProfile(named.ref, ['settings', 'keybindings', 'snippets', 'extensions'], CancellationToken.None);

		assert.deepStrictEqual(snapshot.categories.map(categoryValue), [
			['settings', 'present', { from: 'default' }],
			['keybindings', 'present', [{ key: 'ctrl+x', command: 'cut' }]],
			['snippets', 'present', ['language.json']],
			['extensions', 'present', ['publisher.extension']],
		]);
	});

	test('keeps Default available when the catalog container is malformed', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'cursor', linuxEnvironment);
		fileSystem.addFile(joinPath(source.userData, 'globalStorage', 'storage.json'), '{"other":[]}');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => item.profile.id), ['default']);
		assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['unsupportedNamedProfileCatalogSchema']);
	});

	test('uses the legacy extension manifest only when the primary is absent', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		fileSystem.remove(joinPath(source.extensions, 'extensions.json'));
		fileSystem.addFile(joinPath(source.userData, 'extensions.json'), extensionManifest('legacy.extension'));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		let discovery = await service.discoverSources({}, CancellationToken.None);
		let snapshot = await service.readSourceProfile(discovery.sources[0].ref, ['extensions'], CancellationToken.None);
		assert.deepStrictEqual(categoryValue(snapshot.categories[0]), ['extensions', 'present', ['legacy.extension']]);

		fileSystem.addFile(joinPath(source.extensions, 'extensions.json'), '{ malformed');
		discovery = await service.discoverSources({}, CancellationToken.None);
		snapshot = await service.readSourceProfile(discovery.sources[0].ref, ['extensions'], CancellationToken.None);
		assert.deepStrictEqual(categoryValue(snapshot.categories[0]), ['extensions', 'unreadable', undefined]);
	});

	test('reads only direct snippet files and never traverses extension directories', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'cursor', linuxEnvironment);
		fileSystem.addFile(joinPath(source.userData, 'snippets', 'global.code-snippets'), '{"Global":{}}');
		fileSystem.addFile(joinPath(source.userData, 'snippets', 'ignored.txt'), 'not json');
		fileSystem.addFile(joinPath(source.userData, 'snippets', 'nested', 'secret.json'), '{"Nested":{}}');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		const discovery = await service.discoverSources({}, CancellationToken.None);

		const snapshot = await service.readSourceProfile(discovery.sources[0].ref, ['snippets', 'extensions'], CancellationToken.None);

		assert.deepStrictEqual(categoryValue(snapshot.categories[0]), ['snippets', 'present', ['global.code-snippets', 'language.json']]);
		assert.strictEqual(fileSystem.directoryReads.some(resource => resource.toString() === source.extensions.toString()), false);
	});

	test('uses code-point ordering for normalized resources and fingerprint entries', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		fileSystem.addFile(joinPath(source.userData, 'snippets', '\uE000.json'), '{"Private":{}}');
		fileSystem.addFile(joinPath(source.userData, 'snippets', '\u{1F600}.json'), '{"Supplementary":{}}');
		fileSystem.addFile(joinPath(source.extensions, 'extensions.json'), JSON.stringify([
			{ identifier: { id: 'publisher.\u{1F600}' }, version: '1.0.0' },
			{ identifier: { id: 'publisher.\uE000' }, version: '1.0.0' },
		]));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		const discovery = await service.discoverSources({}, CancellationToken.None);

		const snapshot = await service.readSourceProfile(discovery.sources[0].ref, ['settings', 'keybindings', 'snippets', 'extensions'], CancellationToken.None);

		assert.deepStrictEqual(categoryValue(snapshot.categories[2]), ['snippets', 'present', ['language.json', '\uE000.json', '\u{1F600}.json']]);
		assert.deepStrictEqual(categoryValue(snapshot.categories[3]), ['extensions', 'present', ['publisher.\uE000', 'publisher.\u{1F600}']]);
		assert.deepStrictEqual(snapshot.fingerprint.entries.map(entry => entry.category), ['extensions', 'keybindings', 'settings', 'snippets']);
	});

	test('returns partial sources with malformed, locked, oversized, and changing diagnostics', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		fileSystem.addFile(joinPath(source.userData, 'keybindings.json'), '{ malformed');
		fileSystem.lock(joinPath(source.userData, 'snippets', 'language.json'));
		fileSystem.addFile(joinPath(source.userData, 'snippets', 'usable.json'), '{"Usable":{}}');
		fileSystem.addFile(joinPath(source.extensions, 'extensions.json'), 'x'.repeat(EDITOR_MIGRATION_SETTINGS_MAX_BYTES * 5));
		fileSystem.changeDuringRead(joinPath(source.userData, 'settings.json'));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.strictEqual(result.sources.length, 1);
		assert.deepStrictEqual(result.sources[0].diagnostics.map(item => item.code).sort(), [
			'malformedKnownResource',
			'oversizedResource',
			'permissionDeniedOrLocked',
			'sourceChangedDuringRead',
		].sort());
	});

	test('fingerprints exact parsed bytes and detects later changes', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment, { settings: '{"value":1}' });
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		const discovery = await service.discoverSources({}, CancellationToken.None);
		const ref = discovery.sources[0].ref;
		const snapshot = await service.readSourceProfile(ref, ['settings'], CancellationToken.None);

		assert.strictEqual((await service.verifySourceSnapshot(ref, snapshot.fingerprint, CancellationToken.None)).status, 'unchanged');
		fileSystem.addFile(joinPath(source.userData, 'settings.json'), '{"value":2}');
		assert.strictEqual((await service.verifySourceSnapshot(ref, snapshot.fingerprint, CancellationToken.None)).status, 'changed');
	});

	test('deduplicates canonical aliases with platform case semantics', async () => {
		const fileSystem = new FixtureFileSystem();
		const vscode = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const cursor = populateDefault(fileSystem, 'cursor', linuxEnvironment);
		fileSystem.alias(vscode.userData, URI.file('/canonical/editor'));
		fileSystem.alias(cursor.userData, URI.file('/canonical/editor'));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => item.adapter.id), ['vscode']);
		assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['duplicateAlias']);
	});

	test('deduplicates case-folded canonical roots on Windows', async () => {
		const environment: EditorMigrationPathEnvironment = { platform: 'win32', homePath: 'C:\\Users\\jim', appDataPath: 'D:\\Roaming' };
		const fileSystem = new FixtureFileSystem();
		const vscode = populateDefault(fileSystem, 'vscode', environment);
		const cursor = populateDefault(fileSystem, 'cursor', environment);
		fileSystem.alias(vscode.userData, URI.file('C:\\Canonical\\Editor'));
		fileSystem.alias(cursor.userData, URI.file('c:\\canonical\\editor'));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, environment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => item.adapter.id), ['vscode']);
		assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['duplicateAlias']);
	});

	test('deduplicates named profile IDs that resolve to the same canonical root', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const firstRoot = joinPath(source.userData, 'profiles', 'first');
		const secondRoot = joinPath(source.userData, 'profiles', 'second');
		fileSystem.addFile(joinPath(source.userData, 'globalStorage', 'storage.json'), JSON.stringify({
			userDataProfiles: [{ name: 'First', location: 'first' }, { name: 'Second', location: 'second' }],
		}));
		fileSystem.addFile(joinPath(firstRoot, 'settings.json'), '{"first":true}');
		fileSystem.addFile(joinPath(secondRoot, 'settings.json'), '{"second":true}');
		fileSystem.alias(firstRoot, URI.file('/canonical/profile'));
		fileSystem.alias(secondRoot, URI.file('/canonical/profile'));
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => item.profile.id), ['default', 'first']);
		assert.deepStrictEqual(result.diagnostics.map(item => [item.code, item.profileId]), [['duplicateAlias', 'second']]);
	});

	test('ignores fresh malformed resource mtimes when ranking usable sources', async () => {
		const fileSystem = new FixtureFileSystem();
		const vscode = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const cursor = populateDefault(fileSystem, 'cursor', linuxEnvironment);
		for (const source of [vscode, cursor]) {
			fileSystem.remove(joinPath(source.userData, 'snippets', 'language.json'));
			fileSystem.remove(joinPath(source.extensions, 'extensions.json'));
		}
		fileSystem.remove(joinPath(vscode.userData, 'keybindings.json'));
		fileSystem.remove(joinPath(cursor.userData, 'settings.json'));
		fileSystem.setAllModificationTimes(5);
		fileSystem.setModificationTime(joinPath(vscode.userData, 'settings.json'), 10);
		fileSystem.addFile(joinPath(cursor.userData, 'settings.json'), '{ malformed');
		fileSystem.setModificationTime(joinPath(cursor.userData, 'settings.json'), 100);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources.map(item => [item.adapter.id, item.ranking.newestModificationTime]), [
			['vscode', 10],
			['cursor', 5],
		]);
	});

	test('reports absent candidates without treating empty roots as usable', async () => {
		const fileSystem = new FixtureFileSystem();
		const vscode = resolveEditorMigrationCandidatePaths('vscode', linuxEnvironment);
		fileSystem.addDirectory(vscode.userData);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({ includeAbsentCandidateDiagnostics: true }, CancellationToken.None);

		assert.deepStrictEqual(result.sources, []);
		assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['candidateAbsent', 'candidateAbsent']);
	});

	test('preserves diagnostics when an existing profile has no usable categories', async () => {
		const fileSystem = new FixtureFileSystem();
		const vscode = resolveEditorMigrationCandidatePaths('vscode', linuxEnvironment);
		fileSystem.addDirectory(vscode.userData);
		fileSystem.addFile(joinPath(vscode.userData, 'settings.json'), '{ malformed');
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));

		const result = await service.discoverSources({}, CancellationToken.None);

		assert.deepStrictEqual(result.sources, []);
		assert.deepStrictEqual(result.diagnostics.map(item => [item.code, item.adapterId, item.category]), [
			['malformedKnownResource', 'vscode', 'settings'],
		]);
	});

	test('rejects a canceled profile read while its final provider stat remains blocked', async () => {
		const fileSystem = new FixtureFileSystem();
		const source = populateDefault(fileSystem, 'vscode', linuxEnvironment);
		const service = disposables.add(new EditorMigrationSourceService(fileSystem, linuxEnvironment));
		const discovery = await service.discoverSources({}, CancellationToken.None);
		const block = fileSystem.blockStat(joinPath(source.extensions, 'extensions.json'));
		const cancellation = new CancellationTokenSource();
		const pending = service.readSourceProfile(discovery.sources[0].ref, ['extensions'], cancellation.token);
		await block.started.p;

		cancellation.cancel();
		await assert.rejects(pending, error => error instanceof CancellationError);
		block.release.complete();
		await block.finished.p;
		cancellation.dispose();
	});

	test('keeps canceled active work admitted until the underlying operation settles', async () => {
		const scheduler = disposables.add(new EditorMigrationSourceOperationScheduler(1));
		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const cancellation = new CancellationTokenSource();
		const active = scheduler.run(async () => {
			started.complete();
			await release.p;
			return 'late';
		}, cancellation.token);
		await started.p;
		cancellation.cancel();
		await assert.rejects(active, error => error instanceof CancellationError);

		let queuedStarted = false;
		const queued = scheduler.run(async () => {
			queuedStarted = true;
			return 'queued';
		}, CancellationToken.None);
		await Promise.resolve();
		assert.strictEqual(queuedStarted, false);
		release.complete();
		assert.strictEqual(await queued, 'queued');
		cancellation.dispose();
	});

	test('stops native directory enumeration at limit plus one and closes the handle', async () => {
		let reads = 0;
		let closed = false;
		const provider = createNativeProvider({
			openDirectory: async () => ({
				read: async () => [`entry-${++reads}.json`, FileType.File],
				close: async () => { closed = true; },
			}),
		});
		const fileSystem = new NativeEditorMigrationSourceFileSystem(provider);

		const resource = URI.file('/oversized');
		let readError: unknown;
		try {
			await fileSystem.readDirectory(resource, CancellationToken.None);
		} catch (error) {
			readError = error;
		}
		assert.ok(readError instanceof EditorMigrationSourceFileError && readError.kind === 'oversized');
		assert.strictEqual(getEditorMigrationSourceAdapter('vscode').diagnosticFromError(readError, 'resource', resource, 'default', 'snippets').code, 'oversizedResource');
		assert.strictEqual(reads, 4097);
		assert.strictEqual(closed, true);
	});

	test('normalizes named native cancellation errors during an active stream read', async () => {
		const streamStarted = new DeferredPromise<void>();
		const provider = createNativeProvider({
			readFileStream: (_resource, _options, token) => {
				const stream = newWriteableStream<Uint8Array>(chunks => chunks[0]);
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					const error = new Error('Canceled');
					error.name = 'Canceled';
					stream.error(error);
				});
				streamStarted.complete();
				return stream;
			},
		});
		const fileSystem = new NativeEditorMigrationSourceFileSystem(provider);
		const cancellation = new CancellationTokenSource();
		const pending = fileSystem.readFile(URI.file('/blocked.json'), { maxBytes: 16 }, cancellation.token);
		await streamStarted.p;

		cancellation.cancel();
		await assert.rejects(pending, error => error instanceof CancellationError);
		cancellation.dispose();
	});

	test('settles cancellation before admission, while queued, and during active work', async () => {
		const scheduler = disposables.add(new EditorMigrationSourceOperationScheduler(1));
		const active = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const first = scheduler.run(async token => {
			active.complete();
			await release.p;
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			return 'first';
		}, CancellationToken.None);
		await active.p;
		const queuedSource = new CancellationTokenSource();
		const queued = scheduler.run(async () => 'queued', queuedSource.token);
		queuedSource.cancel();
		await assert.rejects(queued, error => error instanceof CancellationError);
		const cancelledSource = new CancellationTokenSource();
		cancelledSource.cancel();
		await assert.rejects(scheduler.run(async () => 'never', cancelledSource.token), error => error instanceof CancellationError);
		void release.complete();
		assert.strictEqual(await first, 'first');
		const activeSource = new CancellationTokenSource();
		const activeCancellation = scheduler.run(async token => {
			await new Promise<void>(resolve => {
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					resolve();
				});
			});
			throw new CancellationError();
		}, activeSource.token);
		activeSource.cancel();
		await assert.rejects(activeCancellation, error => error instanceof CancellationError);
		queuedSource.dispose();
		cancelledSource.dispose();
		activeSource.dispose();
	});
});

const linuxEnvironment: EditorMigrationPathEnvironment = {
	platform: 'linux',
	homePath: '/home/test',
	xdgConfigHome: '/config',
};

function paths(adapter: 'vscode' | 'vscode-insiders' | 'cursor', environment: EditorMigrationPathEnvironment): readonly string[] {
	const resolved = resolveEditorMigrationCandidatePaths(adapter, environment);
	return [resolved.userData.fsPath, resolved.extensions.fsPath];
}

function populateDefault(fileSystem: FixtureFileSystem, adapter: 'vscode' | 'vscode-insiders' | 'cursor', environment: EditorMigrationPathEnvironment, overrides: { readonly settings?: string; readonly keybindings?: string } = {}) {
	const paths = resolveEditorMigrationCandidatePaths(adapter, environment);
	fileSystem.addDirectory(paths.userData);
	fileSystem.addFile(joinPath(paths.userData, 'settings.json'), overrides.settings ?? '{"editor.fontSize":14}');
	fileSystem.addFile(joinPath(paths.userData, 'keybindings.json'), overrides.keybindings ?? '[]');
	fileSystem.addFile(joinPath(paths.userData, 'snippets', 'language.json'), '{"Log":{"prefix":"log","body":"console.log()"}}');
	fileSystem.addFile(joinPath(paths.extensions, 'extensions.json'), extensionManifest('publisher.extension'));
	return paths;
}

function populateCursorNamedFixture(fileSystem: FixtureFileSystem, environment: EditorMigrationPathEnvironment): { readonly profileId: string } {
	const source = populateDefault(fileSystem, 'cursor', environment, { settings: '{"cursor.default":true}' });
	const profileId = 'cursor-work';
	fileSystem.addFile(joinPath(source.userData, 'globalStorage', 'storage.json'), JSON.stringify({
		userDataProfiles: [{ name: 'Cursor Work', location: profileId, useDefaultFlags: { extensions: true } }],
	}));
	fileSystem.addFile(joinPath(source.userData, 'profiles', profileId, 'settings.json'), '{"cursor.named":true}');
	return { profileId };
}

function extensionManifest(id: string): string {
	return JSON.stringify([{ identifier: { id, uuid: 'uuid' }, version: '1.2.3', location: { path: '/ignored' }, metadata: { preRelease: false, hasPreReleaseVersion: true } }]);
}

function sha256(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createNativeProvider(overrides: Partial<IEditorMigrationDiskProvider>): IEditorMigrationDiskProvider {
	return {
		realpath: async resource => resource.fsPath,
		stat: async () => ({ type: FileType.File, ctime: 1, mtime: 1, size: 1 }),
		openDirectory: async () => ({ read: async () => undefined, close: async () => undefined }),
		readFileStream: () => { throw new Error('Unexpected file stream read'); },
		...overrides,
	};
}

function categoryValue(category: EditorMigrationCategorySnapshot): readonly unknown[] {
	switch (category.category) {
		case 'settings': return [category.category, category.state, category.value];
		case 'keybindings': return [category.category, category.state, category.value];
		case 'snippets': return [category.category, category.state, category.value?.map(item => item.name)];
		case 'extensions': return [category.category, category.state, category.value?.map(item => item.id)];
	}
}

class FixtureFileSystem implements IEditorMigrationSourceFileSystem {
	private readonly files = new Map<string, { contents: VSBuffer; mtime: number }>();
	private readonly fileSequences = new Map<string, VSBuffer[]>();
	private readonly fileReadCounts = new Map<string, number>();
	private readonly directories = new Map<string, Map<string, EditorMigrationSourceDirectoryEntry>>();
	private readonly aliases = new Map<string, URI>();
	private readonly locked = new Set<string>();
	private readonly changing = new Set<string>();
	private readonly blockedStats = new Map<string, { readonly started: DeferredPromise<void>; readonly release: DeferredPromise<void>; readonly finished: DeferredPromise<void> }>();
	private clock = 1;
	readonly directoryReads: URI[] = [];

	addDirectory(resource: URI): void {
		const key = resource.toString();
		if (this.directories.has(key)) {
			return;
		}
		this.directories.set(key, new Map());
		const parent = dirname(resource);
		if (parent.toString() !== key) {
			this.addDirectory(parent);
			this.directories.get(parent.toString())!.set(basename(resource), { name: basename(resource), type: 'directory' });
		}
	}

	addFile(resource: URI, contents: string): void {
		const parent = dirname(resource);
		this.addDirectory(parent);
		this.files.set(resource.toString(), { contents: VSBuffer.fromString(contents), mtime: ++this.clock });
		this.directories.get(parent.toString())!.set(basename(resource), { name: basename(resource), type: 'file' });
	}

	sequenceFile(resource: URI, contents: readonly string[]): void {
		if (contents.length === 0) {
			throw new Error('A file sequence requires at least one value');
		}
		this.addFile(resource, contents[0]);
		this.fileSequences.set(resource.toString(), contents.map(value => VSBuffer.fromString(value)));
		this.fileReadCounts.set(resource.toString(), 0);
	}

	fileReadCount(resource: URI): number {
		return this.fileReadCounts.get(resource.toString()) ?? 0;
	}

	remove(resource: URI): void {
		this.files.delete(resource.toString());
		this.directories.delete(resource.toString());
		this.directories.get(dirname(resource).toString())?.delete(basename(resource));
	}

	alias(resource: URI, canonical: URI): void {
		this.aliases.set(resource.toString(), canonical);
	}

	lock(resource: URI): void {
		this.locked.add(resource.toString());
	}

	changeDuringRead(resource: URI): void {
		this.changing.add(resource.toString());
	}

	blockStat(resource: URI): { readonly started: DeferredPromise<void>; readonly release: DeferredPromise<void>; readonly finished: DeferredPromise<void> } {
		const block = { started: new DeferredPromise<void>(), release: new DeferredPromise<void>(), finished: new DeferredPromise<void>() };
		this.blockedStats.set(resource.toString(), block);
		return block;
	}

	setAllModificationTimes(mtime: number): void {
		for (const file of this.files.values()) {
			file.mtime = mtime;
		}
	}

	setModificationTime(resource: URI, mtime: number): void {
		this.files.get(resource.toString())!.mtime = mtime;
	}

	async realpath(resource: URI, token: CancellationToken): Promise<URI> {
		this.check(resource, token);
		return this.aliases.get(resource.toString()) ?? resource;
	}

	async stat(resource: URI, token: CancellationToken): Promise<EditorMigrationSourceFileStat> {
		this.check(resource, token);
		const block = this.blockedStats.get(resource.toString());
		if (block) {
			block.started.complete();
			await block.release.p;
			block.finished.complete();
		}
		const file = this.files.get(resource.toString());
		if (file) {
			return { type: 'file', size: file.contents.byteLength, mtime: file.mtime };
		}
		if (this.directories.has(resource.toString())) {
			return { type: 'directory', size: 0, mtime: 1 };
		}
		throw new EditorMigrationSourceFileError('notFound', resource);
	}

	async readDirectory(resource: URI, token: CancellationToken): Promise<readonly EditorMigrationSourceDirectoryEntry[]> {
		this.check(resource, token);
		this.directoryReads.push(resource);
		const entries = this.directories.get(resource.toString());
		if (!entries) {
			throw new EditorMigrationSourceFileError('notFound', resource);
		}
		return [...entries.values()].reverse();
	}

	async readFile(resource: URI, limits: EditorMigrationSourceReadLimits, token: CancellationToken): Promise<VSBuffer> {
		this.check(resource, token);
		const key = resource.toString();
		const file = this.files.get(key);
		if (!file) {
			throw new EditorMigrationSourceFileError('notFound', resource);
		}
		if (file.contents.byteLength > limits.maxBytes) {
			throw new EditorMigrationSourceFileError('oversized', resource, limits.maxBytes);
		}
		if (this.changing.has(resource.toString())) {
			throw new EditorMigrationSourceFileError('changed', resource);
		}
		const sequence = this.fileSequences.get(key);
		if (sequence) {
			const count = this.fileReadCounts.get(key) ?? 0;
			this.fileReadCounts.set(key, count + 1);
			return sequence[Math.min(count, sequence.length - 1)];
		}
		return file.contents;
	}

	private check(resource: URI, token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (this.locked.has(resource.toString())) {
			throw new EditorMigrationSourceFileError('permission', resource);
		}
	}
}
