/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IResourceEditorInput } from
	'../../../platform/editor/common/editor.js';
import { FileType, IFileService } from
	'../../../platform/files/common/files.js';
import { IInstantiationService } from
	'../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLogService } from '../../../platform/log/common/log.js';
import { INativeOpenFileRequest } from
	'../../../platform/window/common/window.js';
import {
	IResourceDiffEditorInput,
	IResourceMergeEditorInput,
	IUntypedEditorInput,
} from '../../../workbench/common/editor.js';
import { IEditorService } from
	'../../../workbench/services/editor/common/editorService.js';
import {
	createHostedOmniOpenEditors,
	openHostedOmniFiles,
} from '../../browser/hostedOmniOpenFiles.js';

suite('HostedOmniOpenFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates diff editor inputs for two-file diff requests', () => {
		const [original, modified] = resources('original.ts', 'modified.ts');

		const editors = createHostedOmniOpenEditors(
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

		const editors = createHostedOmniOpenEditors(
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
		const opened: IUntypedEditorInput[][] = [];
		const request: INativeOpenFileRequest = {
			filesToOpenOrCreate: [{
				fileUri: URI.file('/tmp/hucode-open-file.ts'),
				exists: true,
				type: FileType.File,
			}],
		};

		const ok = await openHostedOmniFiles(request, {
			editorService: {
				async openEditors(editors: IUntypedEditorInput[]) {
					opened.push(editors);
					return [{}];
				},
			} as unknown as IEditorService,
			fileService: {
				async canHandleResource() {
					return true;
				},
			} as unknown as IFileService,
			instantiationService: {} as IInstantiationService,
			logService: new NullLogService(),
		});

		assert.strictEqual(ok, true);
		assert.strictEqual(opened.length, 1);
		assert.strictEqual(
			(opened[0][0] as IResourceEditorInput).resource.fsPath,
			'/tmp/hucode-open-file.ts'
		);
	});

	test('logs detached wait-marker cleanup failures', async () => {
		const errors: unknown[] = [];
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

		const ok = await openHostedOmniFiles(request, {
			editorService: {
				async openEditors() {
					return [{}];
				},
			} as unknown as IEditorService,
			fileService: {
				async canHandleResource() {
					return true;
				},
			} as unknown as IFileService,
			instantiationService: {
				async invokeFunction() {
					throw new Error('wait failed');
				},
			} as unknown as IInstantiationService,
			logService: {
				error(error: unknown) {
					errors.push(error);
				},
			} as unknown as ILogService,
		});
		await timeout(0);

		assert.strictEqual(ok, true);
		assert.strictEqual(errors.length, 1);
		assert.match(String(errors[0]), /wait failed/);
	});
});

function resources(...names: string[]): IResourceEditorInput[] {
	return names.map(name => ({
		resource: URI.file(`/tmp/${name}`),
	}));
}
