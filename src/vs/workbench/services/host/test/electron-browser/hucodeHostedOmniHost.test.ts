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
import {
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../../../../platform/window/common/hucodeHostedShellService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { getHucodeHostedOmniScreenshot, HucodeHostedOmniFocusTracker } from '../../electron-browser/hucodeHostedOmniHost.js';

suite('HucodeHostedOmniHost', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hostedState = (
		active: boolean,
		visible: boolean
	): IHucodeHostedShellState => ({
		...HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
		available: true,
		active,
		visible,
		lifecycleState: 'active',
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
		state: IHucodeHostedShellState = hostedState(false, false)
	) => {
		const stateEmitter = disposables.add(
			new Emitter<IHucodeHostedShellState>()
		);
		const screenshots: { rect?: IRectangle }[] = [];
		const unavailable = async () =>
			HucodeHostedShellOperationOutcome.Unavailable;

		const service = {
			_serviceBrand: undefined,
			onDidChangeState: stateEmitter.event,
			async getState(): Promise<IHucodeHostedShellState> {
				return state;
			},
			notifyReady: async () => ({
				outcome: HucodeHostedShellOperationOutcome.Unavailable,
			}),
			closeSelf: unavailable,
			reopenSelfInNormalWindow: unavailable,
			reloadSelf: unavailable,
			focusSelf: unavailable,
			focusShell: unavailable,
			requestShellAction: unavailable,
			navigateToFolder: unavailable,
			triggerPasteInSelf: unavailable,
			async captureSelfScreenshot(
				rect?: IRectangle
			): Promise<VSBuffer | undefined> {
				screenshots.push({ rect });
				return VSBuffer.fromString('screenshot');
			}
		} satisfies IHucodeHostedShellService;

		return {
			service,
			stateEmitter,
			screenshots,
			setState(nextState: IHucodeHostedShellState): void {
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
		const shell = createShellService(hostedState(false, false));
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

		shell.stateEmitter.fire(hostedState(true, true));
		assert.strictEqual(tracker.hasFocus, true);
		assert.strictEqual(focusEvents, 1);

		shell.stateEmitter.fire(hostedState(false, true));
		assert.strictEqual(tracker.hasFocus, false);
		assert.strictEqual(focusEvents, 2);
	});

	test('refreshes hosted state when checking last focus', async () => {
		const nativeHost = createNativeHostService(1);
		const shell = createShellService(hostedState(true, true));
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

	test('routes hosted screenshots through the bound capability', async () => {
		const shell = createShellService();
		const rect = { x: 1, y: 2, width: 3, height: 4 };

		const screenshot = await getHucodeHostedOmniScreenshot(
			environment({ isHostedOmniWorkspace: true }),
			shell.service,
			rect
		);

		assert.strictEqual(screenshot?.toString(), 'screenshot');
		assert.deepStrictEqual(shell.screenshots, [{ rect }]);
		assert.strictEqual(
			getHucodeHostedOmniScreenshot(
				environment({}),
				shell.service,
				rect
			),
			undefined
		);
	});
});
