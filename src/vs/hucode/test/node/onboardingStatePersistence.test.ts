/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { FileStorage, SaveStrategy } from '../../../platform/state/node/stateService.js';

class FailingFileService extends FileService {
	fail = false;
	override async writeFile(...args: Parameters<FileService['writeFile']>): ReturnType<FileService['writeFile']> {
		if (this.fail) { throw new Error('test disk failure'); }
		return super.writeFile(...args);
	}
}

suite('Hucode onboarding acknowledged profile state', () => {
	let root: string;
	let fixture: DisposableStore;
	let files: FailingFileService;
	let storage: FileStorage;
	let resource: URI;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'hucode-onboarding-state-'));
		fixture = new DisposableStore();
		const log = new NullLogService();
		files = fixture.add(new FailingFileService(log));
		fixture.add(files.registerProvider(Schemas.file, fixture.add(new DiskFileSystemProvider(log))));
		resource = URI.file(join(root, 'storage.json'));
		storage = fixture.add(new FileStorage(resource, SaveStrategy.DELAYED, log, files));
		await storage.init();
	});

	teardown(async () => {
		files.fail = false;
		await storage.close();
		fixture.dispose();
		await fs.rm(root, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('acknowledged state survives a new reader using the persisted file', async () => {
		storage.setItem('profileAssociations', { workspaces: { 'file:///repo': 'imported' } });
		await storage.flushWithAcknowledgement('profileAssociations');
		const reopened = fixture.add(new FileStorage(resource, SaveStrategy.DELAYED, new NullLogService(), files));
		await reopened.init();
		assert.deepStrictEqual(reopened.getItem('profileAssociations'), { workspaces: { 'file:///repo': 'imported' } });
		await reopened.close();
	});

	test('swallowed buffered write failure rejects only the explicit acknowledgement and retries unchanged cache', async () => {
		storage.setItem('profileAssociations', { workspaces: { 'file:///repo': 'prior' } });
		await storage.flushWithAcknowledgement('profileAssociations');
		files.fail = true;
		storage.setItem('profileAssociations', { workspaces: { 'file:///repo': 'imported' } });
		await assert.rejects(storage.flushWithAcknowledgement('profileAssociations'), /did not persist/);
		assert.strictEqual(JSON.parse(await fs.readFile(resource.fsPath, 'utf8')).profileAssociations.workspaces['file:///repo'], 'prior');
		files.fail = false;
		await storage.flushWithAcknowledgement('profileAssociations');
		assert.strictEqual(JSON.parse(await fs.readFile(resource.fsPath, 'utf8')).profileAssociations.workspaces['file:///repo'], 'imported');
	});

	test('a selected-folder predicate permits unrelated profile association updates', async () => {
		storage.setItem('profileAssociations', { workspaces: { 'file:///repo': 'imported', 'file:///other': 'changed' } });
		await storage.flushWithAcknowledgement('profileAssociations', value => {
			return (value as { workspaces: Record<string, string> }).workspaces['file:///repo'] === 'imported';
		});
		assert.strictEqual(JSON.parse(await fs.readFile(resource.fsPath, 'utf8')).profileAssociations.workspaces['file:///other'], 'changed');
	});
});
