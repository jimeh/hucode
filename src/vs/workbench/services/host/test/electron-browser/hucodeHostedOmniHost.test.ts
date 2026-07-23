/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IRectangle } from '../../../../../platform/window/common/window.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { getHucodeHostedOmniScreenshot, HucodeHostedOmniFocusTracker, IHucodeHostedWorkspaceState, IHucodeShellService } from '../../electron-browser/hucodeHostedOmniHost.js';

suite('HucodeHostedOmniHost', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hostedState = (
		activeInstanceId: string | undefined,
		visible: boolean
	): IHucodeHostedWorkspaceState => ({
		activeInstanceId,
		instances: [{
			instanceId: 'instance',
			state: 'active',
			visible
		}]
	});

	const createNativeHostService = (windowId: number) => {
		const focusEmitter = disposables.add(new Emitter<number>());
		const blurEmitter = disposables.add(new Emitter<number>());
		let activeWindowId: number | undefined;

		const service = {
			windowId,
			onDidFocusMainOrAuxiliaryWindow: focusEmitter.event,
			onDidBlurMainOrAuxiliaryWindow: blurEmitter.event,
			async getActiveWindowId(): Promise<number | undefined> {
				return activeWindowId;
			}
		} as Partial<INativeHostService> as INativeHostService;

		return {
			service,
			focusEmitter,
			blurEmitter,
			setActiveWindowId(id: number | undefined): void {
				activeWindowId = id;
			}
		};
	};

	const createShellService = (
		state: IHucodeHostedWorkspaceState = hostedState(undefined, false)
	) => {
		const stateEmitter = disposables.add(new Emitter<{
			windowId: number;
			state: IHucodeHostedWorkspaceState;
		}>());
		const screenshots: {
			windowId: number;
			rect?: IRectangle;
		}[] = [];

		const service = {
			onDidChangeWindowState: stateEmitter.event,
			async getWindowState(): Promise<IHucodeHostedWorkspaceState> {
				return state;
			},
			async captureWorkspaceScreenshot(
				windowId: number,
				rect?: IRectangle
			): Promise<VSBuffer | undefined> {
				screenshots.push({ windowId, rect });
				return VSBuffer.fromString('screenshot');
			}
		} as Partial<IHucodeShellService> as IHucodeShellService;

		return {
			service,
			stateEmitter,
			screenshots,
			setState(nextState: IHucodeHostedWorkspaceState): void {
				state = nextState;
			}
		};
	};

	const environment = (
		options: {
			isHostedOmniWorkspace?: boolean;
			hostedInstanceId?: string;
		}
	): IWorkbenchEnvironmentService =>
		options as Partial<IWorkbenchEnvironmentService> as IWorkbenchEnvironmentService;

	test('does not override normal workbench focus state', async () => {
		const nativeHost = createNativeHostService(1);
		const shell = createShellService();
		const tracker = disposables.add(new HucodeHostedOmniFocusTracker(
			nativeHost.service,
			environment({}),
			shell.service,
			() => false
		));

		assert.strictEqual(tracker.hasFocus, undefined);
		assert.strictEqual(await tracker.hadLastFocus(), undefined);
	});

	test('tracks hosted workspace focus from shell and window state', async () => {
		const nativeHost = createNativeHostService(1);
		const shell = createShellService(hostedState(undefined, false));
		let focusEvents = 0;
		const tracker = disposables.add(new HucodeHostedOmniFocusTracker(
			nativeHost.service,
			environment({
				isHostedOmniWorkspace: true,
				hostedInstanceId: 'instance'
			}),
			shell.service,
			() => false
		));
		disposables.add(tracker.onDidChangeFocus(() => focusEvents++));

		await timeout(0);
		assert.strictEqual(tracker.hasFocus, false);

		nativeHost.focusEmitter.fire(1);
		assert.strictEqual(tracker.hasFocus, false);
		assert.strictEqual(focusEvents, 0);

		shell.stateEmitter.fire({
			windowId: 1,
			state: hostedState('instance', true)
		});
		assert.strictEqual(tracker.hasFocus, true);
		assert.strictEqual(focusEvents, 1);

		shell.stateEmitter.fire({
			windowId: 1,
			state: hostedState(undefined, true)
		});
		assert.strictEqual(tracker.hasFocus, false);
		assert.strictEqual(focusEvents, 2);
	});

	test('refreshes hosted state when checking last focus', async () => {
		const nativeHost = createNativeHostService(1);
		const shell = createShellService(hostedState('instance', true));
		const tracker = disposables.add(new HucodeHostedOmniFocusTracker(
			nativeHost.service,
			environment({
				isHostedOmniWorkspace: true,
				hostedInstanceId: 'instance'
			}),
			shell.service,
			() => false
		));

		nativeHost.setActiveWindowId(2);
		assert.strictEqual(await tracker.hadLastFocus(), false);

		nativeHost.setActiveWindowId(1);
		assert.strictEqual(await tracker.hadLastFocus(), true);
	});

	test('routes hosted screenshots through the Omni shell service', async () => {
		const shell = createShellService();
		const rect = { x: 1, y: 2, width: 3, height: 4 };

		const screenshot = await getHucodeHostedOmniScreenshot(
			environment({ isHostedOmniWorkspace: true }),
			shell.service,
			1,
			rect
		);

		assert.strictEqual(screenshot?.toString(), 'screenshot');
		assert.deepStrictEqual(shell.screenshots, [{ windowId: 1, rect }]);
		assert.strictEqual(
			getHucodeHostedOmniScreenshot(
				environment({}),
				shell.service,
				1,
				rect
			),
			undefined
		);
	});
});
