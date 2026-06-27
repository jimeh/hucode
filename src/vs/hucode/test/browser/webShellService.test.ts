/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindowId } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { ICommandService } from
	'../../../platform/commands/common/commands.js';
import {
	HucodeOmniWebChildMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/browser/environmentService.js';
import {
	IHucodeWebOmniHostSurfaceService,
} from '../../browser/webOmniHostSurfaceService.js';
import { WebHucodeShellService } from '../../browser/webShellService.js';

suite('WebHucodeShellService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('recreates a crashed iframe when reopening the same worktree', async () => {
		const service = disposables.add(new WebHucodeShellService(
			{
				options: {
					hucodeOmniWorkbenchRoute: '/workbench',
					hucodeServerPathCaseSensitive: true,
				},
			} as unknown as IBrowserWorkbenchEnvironmentService,
			{
				async executeCommand() { },
			} as unknown as ICommandService,
			{
				onDidChangeSurface: Event.None,
				getSurface() {
					return undefined;
				},
				setSurface() { },
			} as unknown as IHucodeWebOmniHostSurfaceService
		));
		const windowId = getWindowId(mainWindow);

		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;

		mainWindow.dispatchEvent(new MessageEvent('message', {
			origin: mainWindow.location.origin,
			data: {
				type: HucodeOmniWebChildMessageType.CommandResult,
				instanceId: firstInstanceId,
				requestId: 'load',
				ok: false,
			},
		}));

		const crashedState = await service.getWindowState(windowId);
		assert.strictEqual(crashedState.instances[0].state, 'crashed');

		const secondState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);

		assert.strictEqual(secondState.instances.length, 1);
		assert.notStrictEqual(
			secondState.instances[0].instanceId,
			firstInstanceId
		);
		assert.strictEqual(secondState.instances[0].state, 'loading');
	});
});
