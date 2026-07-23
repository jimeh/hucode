/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IResourceEditorInput } from
	'../../../platform/editor/common/editor.js';
import { FileType } from
	'../../../platform/files/common/files.js';
import { ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLogService } from '../../../platform/log/common/log.js';
import { INativeOpenFileRequest } from
	'../../../platform/window/common/window.js';
import {
	IResourceDiffEditorInput,
	IResourceMergeEditorInput,
	IUntypedEditorInput,
} from '../../common/editor.js';
import { IEditorService } from
	'../../services/editor/common/editorService.js';
import { TestFileService } from
	'../common/workbenchTestServices.js';
import {
	createHucodeOpenFileEditors,
	openHucodeFilesRequest,
} from '../../browser/hucodeOpenFilesRequest.js';

suite('HucodeOpenFilesRequest', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates diff editor inputs for two-file diff requests', () => {
		const [original, modified] = resources('original.ts', 'modified.ts');

		const editors = createHucodeOpenFileEditors(
			[original, modified],
			true,
			false
		);
		const diffEditor = editors[0] as IResourceDiffEditorInput;

		assert.strictEqual(editors.length, 1);
		assert.strictEqual(diffEditor.original.resource, original.resource);
		assert.strictEqual(diffEditor.modified.resource, modified.resource);
		assert.deepStrictEqual(diffEditor.options, { pinned: true });
	});

	test('creates merge editor inputs for four-file merge requests', () => {
		const [input1, input2, base, result] = resources(
			'input1.ts',
			'input2.ts',
			'base.ts',
			'result.ts'
		);

		const editors = createHucodeOpenFileEditors(
			[input1, input2, base, result],
			false,
			true
		);
		const mergeEditor = editors[0] as IResourceMergeEditorInput;

		assert.strictEqual(editors.length, 1);
		assert.strictEqual(mergeEditor.input1.resource, input1.resource);
		assert.strictEqual(mergeEditor.input2.resource, input2.resource);
		assert.strictEqual(mergeEditor.base.resource, base.resource);
		assert.strictEqual(mergeEditor.result.resource, result.resource);
		assert.deepStrictEqual(mergeEditor.options, { pinned: true });
	});

	test('opens normal file requests through editor service', async () => {
		const editorService = new FakeEditorService();
		const request: INativeOpenFileRequest = {
			filesToOpenOrCreate: [{
				fileUri: URI.file('/tmp/hucode-open-file.ts'),
				exists: true,
				type: FileType.File,
			}],
		};

		const ok = await openHucodeFilesRequest(request, {
			editorService,
			fileService: new TestFileService(),
			instantiationService: new FakeInstantiationService(),
			logService: new NullLogService(),
		});

		assert.strictEqual(ok, true);
		assert.strictEqual(editorService.opened.length, 1);
		assert.strictEqual(
			(editorService.opened[0][0] as IResourceEditorInput).resource.fsPath,
			'/tmp/hucode-open-file.ts'
		);
	});

	test('logs detached wait-marker cleanup failures', async () => {
		const logService = new RecordingLogService();
		const request: INativeOpenFileRequest = {
			filesToOpenOrCreate: [{
				fileUri: URI.file('/tmp/hucode-open-file.ts'),
				exists: true,
				type: FileType.File,
			}],
			filesToWait: {
				waitMarkerFileUri: URI.file('/tmp/wait-marker'),
				paths: [{ fileUri: URI.file('/tmp/hucode-open-file.ts') }],
			},
		};

		const ok = await openHucodeFilesRequest(request, {
			editorService: new FakeEditorService(),
			fileService: new TestFileService(),
			instantiationService: new FakeInstantiationService(
				new Error('wait failed')
			),
			logService,
		});
		await timeout(0);

		assert.strictEqual(ok, true);
		assert.strictEqual(logService.errors.length, 1);
		assert.match(String(logService.errors[0]), /wait failed/);
	});
});

function resources(...names: string[]): IResourceEditorInput[] {
	return names.map(name => ({
		resource: URI.file(`/tmp/${name}`),
	}));
}

class FakeEditorService implements Pick<IEditorService, 'openEditors'> {
	readonly opened: IUntypedEditorInput[][] = [];

	async openEditors(editors: IUntypedEditorInput[]): Promise<readonly never[]> {
		this.opened.push(editors);
		return [{} as never];
	}
}

class FakeInstantiationService {
	constructor(private readonly error?: Error) { }

	invokeFunction<R, TS extends any[] = []>(
		_fn: (accessor: ServicesAccessor, ...args: TS) => R,
		..._args: TS
	): R {
		if (this.error) {
			throw this.error;
		}

		return undefined as R;
	}
}

class RecordingLogService extends NullLogService implements ILogService {
	readonly errors: unknown[] = [];

	override error(error: unknown): void {
		this.errors.push(error);
	}
}
