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

	test('OmniHostPart renders only a loaded active workbench as active', () => {
		const emptyState = mainWindow.document.createElement('div');
		const surface = mainWindow.document.createElement('div');
		const transitions: string[] = [];
		const host = prototypeHost(OmniHostPart.prototype, {
			emptyState,
			surface,
			activeInstanceId: 'old',
			state: {
				activeInstanceId: 'active',
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				instances: [{
					instanceId: 'active',
					worktreePath: '/repo',
					state: 'active',
					visible: true,
				}],
			},
			hasLoadedWorkbenchContext: {
				set: (loaded: boolean) => transitions.push(`loaded:${loaded}`),
			},
			layoutService: {
				isVisible: () => true,
				setPartHidden: () => transitions.push('show-sidebar'),
			},
			setHostEmpty: (empty: boolean) =>
				transitions.push(`empty:${empty}`),
			clearScreenshot: () => transitions.push('clear-screenshot'),
			handleActiveInstanceChanged: () =>
				transitions.push('active-changed'),
			updateScreenshotRefresh: () => transitions.push('refresh'),
			stopScreenshotRefresh: () => transitions.push('stop-refresh'),
			clearOverlayOcclusion: () => transitions.push('clear-occlusion'),
		});
		const renderState = Reflect.get(
			OmniHostPart.prototype,
			'renderState'
		) as (this: object) => void;

		renderState.call(host);

		assert.deepStrictEqual({
			activeInstanceId: Reflect.get(host, 'activeInstanceId'),
			emptyHidden: emptyState.classList.contains('hidden'),
			surfaceHidden: surface.classList.contains('hidden'),
			transitions,
		}, {
			activeInstanceId: 'active',
			emptyHidden: true,
			surfaceHidden: false,
			transitions: [
				'loaded:true',
				'clear-screenshot',
				'active-changed',
				'empty:false',
				'refresh',
			],
		});
	});

	test('OmniHostPart rejects a stale screenshot occlusion result', async () => {
		const screenshotReady = new DeferredPromise<boolean>();
		const transitions: string[] = [];
		const host = prototypeHost(OmniHostPart.prototype, {
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
		const updateOcclusion = Reflect.get(
			OmniHostPart.prototype,
			'updateOverlayOcclusion'
		) as (this: object) => Promise<void>;

		const update = updateOcclusion.call(host);
		Reflect.set(host, 'activeInstanceId', 'replacement');
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
