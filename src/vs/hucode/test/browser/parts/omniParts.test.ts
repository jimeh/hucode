/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { Parts } from
	'../../../../workbench/services/layout/browser/layoutService.js';
import { AuxiliaryBarPart } from
	'../../../browser/parts/auxiliaryBarPart.js';
import { OmniHostPart } from '../../../browser/parts/omniHostPart.js';
import { PanelPart } from '../../../browser/parts/panelPart.js';
import { ProjectsPart } from '../../../browser/parts/projectsPart.js';
import { TitlebarPart } from '../../../browser/parts/titlebarPart.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from '../../../common/omniWindow.js';

suite('Omni Parts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ProjectsPart delegates focus to the project switcher widget', () => {
		let focusCount = 0;
		const host = prototypeHost(ProjectsPart.prototype, {
			widget: { focus: () => focusCount++ },
		});

		ProjectsPart.prototype.focus.call(host);

		assert.strictEqual(focusCount, 1);
	});

	test('ProjectsPart keeps navigation outside the floating body card', () => {
		const element = mainWindow.document.createElement('div');
		const layouts: Array<{ width: number; height: number }> = [];
		const widgetLayouts: Array<{ width: number; height: number }> = [];
		let floating = true;
		const host = prototypeHost(ProjectsPart.prototype, {
			element,
			layoutService: { isFloatingPanelsEnabled: () => floating },
			layoutContents: (width: number, height: number) => {
				layouts.push({ width, height });
				return { contentSize: { width, height } };
			},
			widget: {
				layout: (width: number, height: number) =>
					widgetLayouts.push({ width, height }),
			},
		});

		ProjectsPart.prototype.layout.call(host, 300, 900, 0, 0);
		floating = false;
		ProjectsPart.prototype.relayoutForModernUI.call(host);

		assert.deepStrictEqual({
			layouts,
			widgetLayouts,
		}, {
			layouts: [
				{ width: 300, height: 900 },
				{ width: 300, height: 900 },
			],
			widgetLayouts: [
				{ width: 290, height: 887 },
				{ width: 300, height: 900 },
			],
		});
	});

	test('OmniHostPart exposes a loaded active workbench', () => {
		const harness = createOmniHostRenderHarness({
			activeInstanceId: 'active',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('active', 'active')],
		});
		const renderState = Reflect.get(
			OmniHostPart.prototype,
			'renderState'
		) as (this: object) => void;

		renderState.call(harness.host);

		assert.deepStrictEqual({
			activeInstanceId: Reflect.get(
				harness.host,
				'activeInstanceId'
			),
			emptyHidden: harness.emptyState.classList.contains('hidden'),
			surfaceHidden: harness.surface.classList.contains('hidden'),
			hostEmpty: harness.mainContainer.classList.contains(
				'hucode-omni-host-empty'
			),
			loadedContexts: harness.loadedContexts,
			sidebarRequests: harness.sidebarRequests,
		}, {
			activeInstanceId: 'active',
			emptyHidden: true,
			surfaceHidden: false,
			hostEmpty: false,
			loadedContexts: [true],
			sidebarRequests: [],
		});
	});

	test('OmniHostPart rejects crashed active state and re-shows an empty sidebar', () => {
		const harness = createOmniHostRenderHarness({
			activeInstanceId: 'active',
			projectsSidebarVisible: false,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('active', 'crashed')],
		}, false);
		const renderState = Reflect.get(
			OmniHostPart.prototype,
			'renderState'
		) as (this: object) => void;

		renderState.call(harness.host);

		assert.deepStrictEqual({
			activeInstanceId: Reflect.get(
				harness.host,
				'activeInstanceId'
			),
			emptyHidden: harness.emptyState.classList.contains('hidden'),
			surfaceHidden: harness.surface.classList.contains('hidden'),
			hostEmpty: harness.mainContainer.classList.contains(
				'hucode-omni-host-empty'
			),
			loadedContexts: harness.loadedContexts,
			sidebarRequests: harness.sidebarRequests,
		}, {
			activeInstanceId: undefined,
			emptyHidden: false,
			surfaceHidden: true,
			hostEmpty: true,
			loadedContexts: [false],
			sidebarRequests: [{
				hidden: false,
				part: Parts.SIDEBAR_PART,
			}],
		});
	});

	test('OmniHostPart keeps the empty surface when no instance is active', () => {
		const harness = createOmniHostRenderHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('loaded', 'loaded')],
		});
		const renderState = Reflect.get(
			OmniHostPart.prototype,
			'renderState'
		) as (this: object) => void;

		renderState.call(harness.host);

		assert.deepStrictEqual({
			activeInstanceId: Reflect.get(
				harness.host,
				'activeInstanceId'
			),
			emptyHidden: harness.emptyState.classList.contains('hidden'),
			surfaceHidden: harness.surface.classList.contains('hidden'),
			hostEmpty: harness.mainContainer.classList.contains(
				'hucode-omni-host-empty'
			),
			loadedContexts: harness.loadedContexts,
		}, {
			activeInstanceId: undefined,
			emptyHidden: false,
			surfaceHidden: true,
			hostEmpty: false,
			loadedContexts: [true],
		});
	});

	test('OmniHostPart rejects a token-stale screenshot result', async () => {
		const screenshotReady = new DeferredPromise<boolean>();
		const transitions: string[] = [];
		const host = createOcclusionHost(screenshotReady, transitions);
		const updateOcclusion = Reflect.get(
			OmniHostPart.prototype,
			'updateOverlayOcclusion'
		) as (this: object) => Promise<void>;

		const update = updateOcclusion.call(host);
		Reflect.set(host, 'overlayOcclusionToken', 2);
		screenshotReady.complete(true);
		await update;

		assert.deepStrictEqual({
			overlayOccluded: Reflect.get(host, 'overlayOccluded'),
			transitions,
		}, {
			overlayOccluded: false,
			transitions: [],
		});
	});

	test('OmniHostPart rejects a result for a replaced active instance', async () => {
		const screenshotReady = new DeferredPromise<boolean>();
		const transitions: string[] = [];
		const host = createOcclusionHost(screenshotReady, transitions);
		const updateOcclusion = Reflect.get(
			OmniHostPart.prototype,
			'updateOverlayOcclusion'
		) as (this: object) => Promise<void>;

		const update = updateOcclusion.call(host);
		Reflect.set(host, 'activeInstanceId', 'replacement');
		screenshotReady.complete(true);
		await update;

		assert.deepStrictEqual({
			overlayOccluded: Reflect.get(host, 'overlayOccluded'),
			transitions,
		}, {
			overlayOccluded: false,
			transitions: [],
		});
	});

	test('OmniHostPart rechecks occlusion before the animation-frame handoff', async () => {
		const screenshotReady = new DeferredPromise<boolean>();
		const transitions: string[] = [];
		const host = createOcclusionHost(screenshotReady, transitions);
		const updateOcclusion = Reflect.get(
			OmniHostPart.prototype,
			'updateOverlayOcclusion'
		) as (this: object) => Promise<void>;

		const update = updateOcclusion.call(host);
		screenshotReady.complete(true);
		await update;
		Reflect.set(host, 'overlayOcclusionToken', 2);
		await new Promise<void>(resolve =>
			mainWindow.requestAnimationFrame(() => resolve())
		);

		assert.deepStrictEqual({
			overlayOccluded: Reflect.get(host, 'overlayOccluded'),
			transitions,
		}, {
			overlayOccluded: true,
			transitions: ['show-screenshot'],
		});
	});

	test('OmniHostPart shares an in-flight screenshot capture', async () => {
		const capture = new DeferredPromise<boolean>();
		let captureCount = 0;
		const host = prototypeHost(OmniHostPart.prototype, {
			screenshotCaptureInFlight: undefined,
			hasScreenshot: false,
			hasVisibleHostedWorkspace: () => true,
			doRefreshScreenshot: () => {
				captureCount++;
				return capture.p;
			},
		});
		const refreshScreenshot = Reflect.get(
			OmniHostPart.prototype,
			'refreshScreenshot'
		) as (this: object) => Promise<boolean>;

		const first = refreshScreenshot.call(host);
		const second = refreshScreenshot.call(host);
		capture.complete(true);

		assert.deepStrictEqual({
			results: await Promise.all([first, second]),
			captureCount,
			inFlight: Reflect.get(host, 'screenshotCaptureInFlight'),
		}, {
			results: [true, true],
			captureCount: 1,
			inFlight: undefined,
		});
	});

	test('OmniHostPart preserves the previous screenshot after capture failure', async () => {
		let setCount = 0;
		const host = prototypeHost(OmniHostPart.prototype, {
			windowId: 7,
			hasScreenshot: true,
			shellService: {
				captureWorkspaceScreenshot: async () => {
					throw new Error('capture failed');
				},
			},
			setScreenshot: () => setCount++,
		});
		const refresh = Reflect.get(
			OmniHostPart.prototype,
			'doRefreshScreenshot'
		) as (this: object) => Promise<boolean>;

		assert.deepStrictEqual({
			result: await refresh.call(host),
			setCount,
		}, {
			result: true,
			setCount: 0,
		});
	});

	test('OmniHostPart lays out the hosted workspace in window coordinates', async () => {
		const layouts: Array<{
			windowId: number;
			bounds: { x: number; y: number; width: number; height: number };
		}> = [];
		const screenshots: Array<{
			left: number;
			width: number;
			height: number;
		}> = [];
		const surface = mainWindow.document.createElement('div');
		surface.getBoundingClientRect = () => ({
			x: 250,
			y: 30,
			left: 250,
			top: 30,
			right: 900,
			bottom: 700,
			width: 650,
			height: 670,
			toJSON: () => undefined,
		});
		const host = prototypeHost(OmniHostPart.prototype, {
			surface,
			windowId: 7,
			layoutService: {
				isVisible: (part: Parts) =>
					part === Parts.HUCODE_OMNI_HOST_PART,
			},
			shellService: {
				layoutWorkspace: async (
					windowId: number,
					bounds: { x: number; y: number; width: number; height: number }
				) => layouts.push({ windowId, bounds }),
			},
			layoutScreenshot: (left: number, width: number, height: number) =>
				screenshots.push({ left, width, height }),
			updateOverlayOcclusion: () => Promise.resolve(),
			updateScreenshotRefresh: () => undefined,
		});
		const layoutHostedWorkspace = Reflect.get(
			OmniHostPart.prototype,
			'layoutHostedWorkspace'
		) as (this: object) => Promise<void>;

		await layoutHostedWorkspace.call(host);

		assert.deepStrictEqual({
			layouts,
			screenshots,
		}, {
			layouts: [{
				windowId: 7,
				bounds: {
					x: 250,
					y: 0,
					width: Math.max(0, mainWindow.innerWidth - 250),
					height: Math.max(0, mainWindow.innerHeight),
				},
			}],
			screenshots: [{
				left: 250,
				width: Math.max(0, mainWindow.innerWidth - 250),
				height: Math.max(0, mainWindow.innerHeight),
			}],
		});
	});

	test('OmniHostPart clamps hosted layout width beyond the window edge', async () => {
		const layouts: Array<{
			x: number;
			y: number;
			width: number;
			height: number;
		}> = [];
		const surface = mainWindow.document.createElement('div');
		surface.getBoundingClientRect = () => ({
			x: mainWindow.innerWidth + 50,
			y: 0,
			left: mainWindow.innerWidth + 50,
			top: 0,
			right: mainWindow.innerWidth + 100,
			bottom: 100,
			width: 50,
			height: 100,
			toJSON: () => undefined,
		});
		const host = prototypeHost(OmniHostPart.prototype, {
			surface,
			windowId: 7,
			layoutService: { isVisible: () => true },
			shellService: {
				layoutWorkspace: async (
					_windowId: number,
					bounds: {
						x: number;
						y: number;
						width: number;
						height: number;
					}
				) => layouts.push(bounds),
			},
			layoutScreenshot: () => undefined,
			updateOverlayOcclusion: () => Promise.resolve(),
			updateScreenshotRefresh: () => undefined,
		});
		const layoutHostedWorkspace = Reflect.get(
			OmniHostPart.prototype,
			'layoutHostedWorkspace'
		) as (this: object) => Promise<void>;

		await layoutHostedWorkspace.call(host);

		assert.deepStrictEqual(layouts, [{
			x: mainWindow.innerWidth + 50,
			y: 0,
			width: 0,
			height: mainWindow.innerHeight,
		}]);
	});

	test('shell parts retain their bounded sizing and serialization contracts', () => {
		const panel = prototypeHost(PanelPart.prototype, {
			layoutService: {
				mainContainerDimension: { width: 1200, height: 800 },
			},
			getActivePaneComposite: () => ({
				getOptimalWidth: () => 240,
			}),
		});
		const auxiliary = prototypeHost(AuxiliaryBarPart.prototype, {
			layoutService: {
				mainContainerDimension: { width: 1200, height: 800 },
			},
			getActivePaneComposite: () => ({
				getOptimalWidth: () => 320,
			}),
		});

		assert.deepStrictEqual({
			projects: {
				snap: Reflect.get(ProjectsPart.prototype, 'snap', {
					snap: false,
				}),
				json: ProjectsPart.prototype.toJSON(),
			},
			panel: {
				preferredHeight: Reflect.get(
					PanelPart.prototype,
					'preferredHeight',
					panel
				),
				preferredWidth: Reflect.get(
					PanelPart.prototype,
					'preferredWidth',
					panel
				),
				json: PanelPart.prototype.toJSON(),
			},
			auxiliary: {
				preferredHeight: Reflect.get(
					AuxiliaryBarPart.prototype,
					'preferredHeight',
					auxiliary
				),
				preferredWidth: Reflect.get(
					AuxiliaryBarPart.prototype,
					'preferredWidth',
					auxiliary
				),
				json: AuxiliaryBarPart.prototype.toJSON(),
			},
			titlebar: TitlebarPart.prototype.toJSON(),
		}, {
			projects: {
				snap: false,
				json: { type: Parts.SIDEBAR_PART },
			},
			panel: {
				preferredHeight: 320,
				preferredWidth: 300,
				json: { type: Parts.PANEL_PART },
			},
			auxiliary: {
				preferredHeight: 320,
				preferredWidth: 380,
				json: { type: Parts.AUXILIARYBAR_PART },
			},
			titlebar: { type: Parts.TITLEBAR_PART },
		});
	});

	test('TitlebarPart focuses the first reachable toolbar control', () => {
		const toolbar = mainWindow.document.createElement('div');
		const disabled = mainWindow.document.createElement('button');
		disabled.tabIndex = -1;
		const first = mainWindow.document.createElement('button');
		first.tabIndex = 0;
		const second = mainWindow.document.createElement('button');
		second.tabIndex = 0;
		toolbar.append(disabled, first, second);
		mainWindow.document.body.appendChild(toolbar);
		const host = prototypeHost(TitlebarPart.prototype, {
			leftToolbarContainer: toolbar,
		});

		TitlebarPart.prototype.focus.call(host);

		assert.strictEqual(mainWindow.document.activeElement, first);
		toolbar.remove();
	});
});

function prototypeHost<T extends object>(
	prototype: object,
	fields: T
): T {
	return Object.assign(Object.create(prototype) as object, fields) as T;
}

function hostedInstance(
	instanceId: string,
	state: HucodeHostedWorkbenchLifecycleState
): IHucodeHostedWorkbenchInstance {
	return {
		instanceId,
		worktreePath: `/${instanceId}`,
		state,
		visible: true,
		focused: state === 'active',
	};
}

function createOmniHostRenderHarness(
	state: IHucodeHostedWorkspaceState,
	sidebarVisible = true
) {
	const emptyState = mainWindow.document.createElement('div');
	const surface = mainWindow.document.createElement('div');
	const mainContainer = mainWindow.document.createElement('div');
	const loadedContexts: boolean[] = [];
	const sidebarRequests: Array<{ hidden: boolean; part: Parts }> = [];
	const host = prototypeHost(OmniHostPart.prototype, {
		emptyState,
		surface,
		mainOverlayOccluded: false,
		overlayOccluded: false,
		overlayOcclusionToken: 0,
		hasScreenshot: false,
		activeInstanceId: 'old',
		state,
		hasLoadedWorkbenchContext: {
			set: (loaded: boolean) => loadedContexts.push(loaded),
		},
		layoutService: {
			isVisible: (part: Parts) =>
				part === Parts.SIDEBAR_PART ? sidebarVisible : true,
			setPartHidden: (hidden: boolean, part: Parts) =>
				sidebarRequests.push({ hidden, part }),
			getContainer: () => mainContainer,
		},
		shellService: {
			supportsWorkspaceScreenshotOverlay: false,
			setWorkspaceOverlayOcclusion: async () => undefined,
		},
	});
	return {
		host,
		emptyState,
		surface,
		mainContainer,
		loadedContexts,
		sidebarRequests,
	};
}

function createOcclusionHost(
	screenshotReady: DeferredPromise<boolean>,
	transitions: string[]
) {
	return prototypeHost(OmniHostPart.prototype, {
		overlayOcclusionToken: 0,
		activeInstanceId: 'active',
		overlayOccluded: false,
		mainOverlayOccluded: false,
		hasOverlappingShellOverlay: () => true,
		refreshScreenshot: () => screenshotReady.p,
		updateScreenshotVisibility: () =>
			transitions.push('show-screenshot'),
		setMainOverlayOcclusion: () =>
			transitions.push('occlude-workspace'),
	});
}
