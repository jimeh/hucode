/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { Parts } from
	'../../../../workbench/services/layout/browser/layoutService.js';
import {
	TITLE_BAR_ACTIVE_BACKGROUND,
	TITLE_BAR_INACTIVE_BACKGROUND,
} from '../../../../workbench/common/theme.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { TestThemeService } from
	'../../../../platform/theme/test/common/testThemeService.js';
import { MockContextKeyService } from
	'../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { shouldApplyFloatingEditorLayout } from
	'../../../../workbench/browser/parts/editor/editorPart.js';
import { TestLayoutService } from
	'../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from
	'../../../../workbench/test/common/workbenchTestServices.js';
import { AuxiliaryBarPart } from
	'../../../browser/parts/auxiliaryBarPart.js';
import { OmniHostPart } from '../../../browser/parts/omniHostPart.js';
import {
	ADD_PROJECT_COMMAND_ID,
	ADD_WORKBENCH_COMMAND_ID,
} from '../../../browser/projectSwitcher/projectSwitcherCommon.js';
import { PanelPart } from '../../../browser/parts/panelPart.js';
import { ProjectsPart } from '../../../browser/parts/projectsPart.js';
import {
	resolveHucodeOmniTitleBackground,
	TitlebarPart,
} from '../../../browser/parts/titlebarPart.js';
import {
	hucodeOmniTitleBackground,
	hucodeOmniTitleForeground,
	sessionsSidebarBackground,
	sessionsSidebarHeaderBackground,
	sessionsSidebarHeaderForeground,
} from '../../../common/theme.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from '../../../common/omniWindow.js';
import { ProjectRecord } from
	'../../../../platform/projectManager/common/projectManager.js';

suite('Omni Parts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('modal editor ignores Modern UI floating-card insets', () => {
		assert.deepStrictEqual({
			mainEditor: shouldApplyFloatingEditorLayout(1, 1, true, false),
			modalEditor: shouldApplyFloatingEditorLayout(1, 1, true, true),
			classicEditor: shouldApplyFloatingEditorLayout(1, 1, false, false),
			auxiliaryEditor: shouldApplyFloatingEditorLayout(2, 1, true, false),
		}, {
			mainEditor: true,
			modalEditor: false,
			classicEditor: false,
			auxiliaryEditor: false,
		});
	});

	test('ProjectsPart delegates focus to the project switcher widget', () => {
		let focusCount = 0;
		const host = prototypeHost(ProjectsPart.prototype, {
			widget: { focus: () => focusCount++ },
		});

		ProjectsPart.prototype.focus.call(host);

		assert.strictEqual(focusCount, 1);
	});

	test('ProjectsPart matches the Modern UI perimeter gutter in both densities', () => {
		const element = mainWindow.document.createElement('div');
		const layouts: Array<{ width: number; height: number }> = [];
		const widgetLayouts: Array<{ width: number; height: number }> = [];
		let floating = true;
		let compact = false;
		const host = prototypeHost(ProjectsPart.prototype, {
			element,
			layoutService: {
				isFloatingPanelsEnabled: () => floating,
				isModernUICompact: () => compact,
			},
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
		compact = true;
		ProjectsPart.prototype.relayoutForModernUI.call(host);
		floating = false;
		ProjectsPart.prototype.relayoutForModernUI.call(host);

		assert.deepStrictEqual({
			layouts,
			widgetLayouts,
		}, {
			layouts: [
				{ width: 300, height: 900 },
				{ width: 300, height: 900 },
				{ width: 300, height: 900 },
			],
			widgetLayouts: [
				{ width: 294, height: 893 },
				{ width: 294, height: 893 },
				{ width: 300, height: 900 },
			],
		});
	});

	test('ProjectsPart consumes the Modern UI shell background without changing classic colors', () => {
		const container = mainWindow.document.createElement('div');
		const titleAreaElement = mainWindow.document.createElement('div');
		let floating = true;
		const colors = new Map<string, string>([
			[sessionsSidebarBackground, '#101112'],
			[sessionsSidebarHeaderBackground, '#121314'],
			[sessionsSidebarHeaderForeground, '#f0f1f2'],
		]);
		const host = prototypeHost(ProjectsPart.prototype, {
			titleAreaElement,
			layoutService: { isFloatingPanelsEnabled: () => floating },
			getContainer: () => container,
			getColor: (id: string) => colors.get(id) ?? null,
		});

		ProjectsPart.prototype.updateStyles.call(host);
		const modern = {
			containerBackground: container.style.backgroundColor,
			titleBackground: titleAreaElement.style.backgroundColor,
			titleForeground: titleAreaElement.style.color,
		};

		floating = false;
		ProjectsPart.prototype.updateStyles.call(host);

		assert.deepStrictEqual({
			modern,
			classic: {
				containerBackground: container.style.backgroundColor,
				titleBackground: titleAreaElement.style.backgroundColor,
				titleForeground: titleAreaElement.style.color,
			},
		}, {
			modern: {
				containerBackground: 'rgb(16, 17, 18)',
				titleBackground: 'var(--modern-ui-shell-background)',
				titleForeground: 'rgb(240, 241, 242)',
			},
			classic: {
				containerBackground: 'rgb(16, 17, 18)',
				titleBackground: 'rgb(18, 19, 20)',
				titleForeground: 'rgb(240, 241, 242)',
			},
		});
	});

	test('TitlebarPart publishes active and inactive Modern UI shell backgrounds', () => {
		const element = mainWindow.document.createElement('div');
		const container = mainWindow.document.createElement('div');
		let floating = true;
		const colors = new Map<string, string>([
			[TITLE_BAR_ACTIVE_BACKGROUND, '#191A1B'],
			[TITLE_BAR_INACTIVE_BACKGROUND, '#202122'],
			[hucodeOmniTitleBackground, '#121314'],
			[hucodeOmniTitleForeground, '#f0f1f2'],
		]);
		const host = prototypeHost(TitlebarPart.prototype, {
			element,
			isInactive: false,
			layoutService: {
				isFloatingPanelsEnabled: () => floating,
				getContainer: () => container,
			},
			getColor: (id: string) => colors.get(id) ?? null,
			themeService: {
				getColorTheme: () => ({ type: ColorScheme.DARK }),
			},
		});

		TitlebarPart.prototype.updateStyles.call(host);
		const active = {
			background: element.style.backgroundColor,
			shellBackground: container.style.getPropertyValue(
				'--modern-ui-shell-background'
			),
		};

		Reflect.set(host, 'isInactive', true);
		TitlebarPart.prototype.updateStyles.call(host);
		const inactive = {
			background: element.style.backgroundColor,
			shellBackground: container.style.getPropertyValue(
				'--modern-ui-shell-background'
			),
		};

		floating = false;
		TitlebarPart.prototype.updateStyles.call(host);

		assert.deepStrictEqual({
			active,
			inactive,
			classic: {
				background: element.style.backgroundColor,
				shellBackground: container.style.getPropertyValue(
					'--modern-ui-shell-background'
				),
			},
		}, {
			active: {
				background: 'rgb(25, 26, 27)',
				shellBackground: '#191A1B',
			},
			inactive: {
				background: 'rgb(32, 33, 34)',
				shellBackground: '#202122',
			},
			classic: {
				background: 'rgb(18, 19, 20)',
				shellBackground: '',
			},
		});
	});

	test('TitlebarPart falls back to the active Modern UI shell background when the inactive color is absent', () => {
		const element = mainWindow.document.createElement('div');
		const container = mainWindow.document.createElement('div');
		const colors = new Map<string, string>([
			[TITLE_BAR_ACTIVE_BACKGROUND, '#191A1B'],
			[hucodeOmniTitleForeground, '#f0f1f2'],
		]);
		const host = prototypeHost(TitlebarPart.prototype, {
			element,
			isInactive: true,
			layoutService: {
				isFloatingPanelsEnabled: () => true,
				getContainer: () => container,
			},
			getColor: (id: string) => colors.get(id) ?? null,
			themeService: {
				getColorTheme: () => ({ type: ColorScheme.DARK }),
			},
		});

		TitlebarPart.prototype.updateStyles.call(host);

		assert.deepStrictEqual({
			background: element.style.backgroundColor,
			shellBackground: container.style.getPropertyValue(
				'--modern-ui-shell-background'
			),
		}, {
			background: 'rgb(25, 26, 27)',
			shellBackground: '#191A1B',
		});
	});

	test('TitlebarPart makes projected alpha colors opaque against the workbench', () => {
		assert.strictEqual(
			resolveHucodeOmniTitleBackground(
				'rgba(255, 0, 0, 0.5)',
				'#000000',
				{ type: ColorScheme.DARK } as never
			),
			'#921213'
		);
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

	test('OmniHostPart renders a semantic first-workbench landing view and dispatches its actions', async () => {
		const harness = createOmniHostLandingHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, []);

		renderOmniHostState(harness.host);
		const heading = harness.emptyState.querySelector('h2');
		const description = harness.emptyState.querySelector('p');
		const buttons = Array.from(
			harness.emptyState.querySelectorAll('button')
		) as HTMLButtonElement[];
		buttons[0].click();
		buttons[1].click();
		await Promise.resolve();

		assert.deepStrictEqual({
			regionRole: harness.emptyState.getAttribute('role'),
			regionTabIndex: harness.emptyState.tabIndex,
			labelledBy: harness.emptyState.getAttribute('aria-labelledby'),
			describedBy: harness.emptyState.getAttribute('aria-describedby'),
			headingId: heading?.id,
			descriptionId: description?.id,
			heading: heading?.textContent,
			description: description?.textContent,
			buttonLabels: buttons.map(button => button.textContent),
			buttonTypes: buttons.map(button => button.type),
			buttonTabIndexes: buttons.map(button => button.tabIndex),
			commands: harness.commands,
		}, {
			regionRole: 'region',
			regionTabIndex: -1,
			labelledBy: 'hucode-omni-host-empty-heading',
			describedBy: 'hucode-omni-host-empty-description',
			headingId: 'hucode-omni-host-empty-heading',
			descriptionId: 'hucode-omni-host-empty-description',
			heading: 'Open your first workbench',
			description: 'A project is a saved Git repository. A workbench can be any folder.',
			buttonLabels: ['Add Project', 'Open Folder as Workbench'],
			buttonTypes: ['button', 'button'],
			buttonTabIndexes: [0, 0],
			commands: [
				ADD_PROJECT_COMMAND_ID,
				ADD_WORKBENCH_COMMAND_ID,
			],
		});
	});

	test('OmniHostPart keeps catalog copy until shell and project hydration are authoritative', async () => {
		const projectsReady = new DeferredPromise<readonly ProjectRecord[]>();
		const shellStateReady =
			new DeferredPromise<IHucodeHostedWorkspaceState>();
		const harness = createOmniHostLandingHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, undefined, {
			getProjects: () => projectsReady.p,
		});
		Object.assign(harness.host, {
			didHydrateShellState: false,
			didReceiveStateChange: false,
			configurationService: { getValue: () => 'active' },
			shellService: {
				supportsWorkspaceScreenshotOverlay: false,
				setHostedWorkbenchRestorePolicy: async () => undefined,
				getState: () => shellStateReady.p,
				setWorkspaceOverlayOcclusion: async () => undefined,
			},
		});
		const initialize = Reflect.get(
			OmniHostPart.prototype,
			'initialize'
		) as (this: object) => Promise<void>;
		const initializeProjects = Reflect.get(
			OmniHostPart.prototype,
			'initializeProjects'
		) as (this: object) => Promise<void>;
		renderOmniHostState(harness.host);
		const headings = [readOmniHostLanding(harness.emptyState).heading];

		const shellInitialization = initialize.call(harness.host);
		const projectInitialization = initializeProjects.call(harness.host);
		projectsReady.complete([]);
		await projectInitialization;
		headings.push(readOmniHostLanding(harness.emptyState).heading);
		shellStateReady.complete({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
			retainedWorkbenches: [{
				id: 'scratch',
				folderUri: URI.file('/scratch').toJSON(),
				desiredState: 'unloaded',
				order: 0,
			}],
		});
		await shellInitialization;
		headings.push(readOmniHostLanding(harness.emptyState).heading);

		assert.deepStrictEqual(headings, [
			'Choose a project or workbench',
			'Choose a project or workbench',
			'Choose a project or workbench',
		]);
	});

	test('OmniHostPart leads with Projects for project and retained catalogs', () => {
		const projectHarness = createOmniHostLandingHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, [projectRecord()]);
		renderOmniHostState(projectHarness.host);

		const retainedHarness = createOmniHostLandingHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
			retainedWorkbenches: [{
				id: 'scratch',
				folderUri: URI.file('/scratch').toJSON(),
				desiredState: 'unloaded',
				order: 0,
			}],
		}, []);
		renderOmniHostState(retainedHarness.host);

		assert.deepStrictEqual({
			project: readOmniHostLanding(projectHarness.emptyState),
			retained: readOmniHostLanding(retainedHarness.emptyState),
		}, {
			project: {
				heading: 'Choose a project or workbench',
				description: 'Select an item from Projects to open it here.',
				actionsHidden: false,
			},
			retained: {
				heading: 'Choose a project or workbench',
				description: 'Select an item from Projects to open it here.',
				actionsHidden: false,
			},
		});
	});

	test('OmniHostPart waits for authoritative project hydration before showing first-workbench copy', async () => {
		const projectsReady = new DeferredPromise<readonly ProjectRecord[]>();
		const harness = createOmniHostLandingHarness({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, undefined, {
			getProjects: () => projectsReady.p,
		});
		renderOmniHostState(harness.host);
		const initializeProjects = Reflect.get(
			OmniHostPart.prototype,
			'initializeProjects'
		) as (this: object) => Promise<void>;

		const initialization = initializeProjects.call(harness.host);
		assert.strictEqual(
			readOmniHostLanding(harness.emptyState).heading,
			'Choose a project or workbench'
		);
		projectsReady.complete([]);
		await initialization;

		assert.strictEqual(
			readOmniHostLanding(harness.emptyState).heading,
			'Open your first workbench'
		);
	});

	test('OmniHostPart keeps a live project event over a late initial snapshot', async () => {
		const stateEmitter = new Emitter<IHucodeHostedWorkspaceState>();
		const projectsEmitter = new Emitter<readonly ProjectRecord[]>();
		const projectsReady = new DeferredPromise<readonly ProjectRecord[]>();
		const shellStateReady =
			new DeferredPromise<IHucodeHostedWorkspaceState>();
		const liveProjects = [projectRecord({ label: 'Live' })];
		const emptyState: IHucodeHostedWorkspaceState = {
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		};
		const workbenchContainer = mainWindow.document.createElement('div');
		const parent = mainWindow.document.createElement('div');
		const layoutService = new TestLayoutService();
		layoutService.getContainer = () => workbenchContainer;
		const storageService = new TestStorageService();
		const contextKeyService = new MockContextKeyService();
		let surface: HTMLElement | undefined;
		const part = new OmniHostPart(
			new TestThemeService(),
			storageService,
			layoutService,
			contextKeyService,
			{ getValue: () => 'active' } as never,
			{
				supportsWorkspaceScreenshotOverlay: false,
				onDidChangeState: stateEmitter.event,
				setHostedWorkbenchRestorePolicy: async () => undefined,
				getState: () => shellStateReady.p,
				setWorkspaceOverlayOcclusion: async () => undefined,
			} as never,
			{
				getSurface: () => surface,
				setSurface: (value: HTMLElement | undefined) => surface = value,
			} as never,
			{
				onDidChangeProjects: projectsEmitter.event,
				getProjects: () => projectsReady.p,
			} as never,
			{ executeCommand: async () => undefined } as never
		);

		try {
			part.create(parent);
			stateEmitter.fire(emptyState);
			projectsEmitter.fire(liveProjects);
			assert.strictEqual(
				readOmniHostLanding(
					parent.querySelector('.hucode-omni-host-empty')!
				).heading,
				'Choose a project or workbench'
			);

			projectsReady.complete([]);
			shellStateReady.complete(emptyState);
			await Promise.resolve();
			await Promise.resolve();

			assert.strictEqual(Reflect.get(part, 'projects'), liveProjects);
		} finally {
			part.dispose();
			storageService.dispose();
			contextKeyService.dispose();
			stateEmitter.dispose();
			projectsEmitter.dispose();
		}
	});

	test('OmniHostPart focuses the active available workbench', () => {
		assert.deepStrictEqual(runOmniHostFocus({
			activeInstanceId: 'active',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('active', 'active')],
		}, false, true), ['workbench']);
	});

	test('OmniHostPart focuses Add Project on an empty clean landing', () => {
		assert.deepStrictEqual(runOmniHostFocus({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, true, false), ['add-project']);
	});

	test('OmniHostPart focuses Add Project when a loaded workbench is inactive', () => {
		assert.deepStrictEqual(runOmniHostFocus({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('loaded', 'loaded')],
		}, true, false), ['add-project']);
	});

	test('OmniHostPart focuses the accessible crash landing region', () => {
		assert.deepStrictEqual(runOmniHostFocus({
			activeInstanceId: 'crashed',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('crashed', 'crashed')],
		}, true, false), ['landing']);
	});

	test('OmniHostPart rejects crashed active state and re-shows an empty sidebar', () => {
		const harness = createOmniHostLandingHarness({
			activeInstanceId: 'active',
			projectsSidebarVisible: false,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('active', 'crashed')],
		}, undefined, undefined, false);
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
			landing: readOmniHostLanding(harness.emptyState),
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
			landing: {
				heading: 'Workbench crashed',
				description: 'Select the crashed workbench in Projects to reopen it.',
				actionsHidden: true,
			},
		});
	});

	test('OmniHostPart shows catalog guidance and reveals Projects after the last unload', () => {
		const harness = createOmniHostLandingHarness({
			activeInstanceId: 'active',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('active', 'active')],
		}, [projectRecord()]);
		renderOmniHostState(harness.host);
		harness.setSidebarVisible(false);
		Reflect.set(harness.host, 'state', {
			projectsSidebarVisible: false,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		} satisfies IHucodeHostedWorkspaceState);

		renderOmniHostState(harness.host);

		assert.deepStrictEqual({
			landing: readOmniHostLanding(harness.emptyState),
			sidebarRequests: harness.sidebarRequests,
			hostEmpty: harness.mainContainer.classList.contains(
				'hucode-omni-host-empty'
			),
		}, {
			landing: {
				heading: 'Choose a project or workbench',
				description: 'Select an item from Projects to open it here.',
				actionsHidden: false,
			},
			sidebarRequests: [{ hidden: false, part: Parts.SIDEBAR_PART }],
			hostEmpty: true,
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

	test('OmniHostPart keeps live state over a late initial snapshot', async () => {
		const snapshotReady = new DeferredPromise<IHucodeHostedWorkspaceState>();
		const liveState: IHucodeHostedWorkspaceState = {
			activeInstanceId: 'live',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [hostedInstance('live', 'active')],
		};
		const snapshotState: IHucodeHostedWorkspaceState = {
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		};
		const host = prototypeHost(OmniHostPart.prototype, {
			state: snapshotState,
			didReceiveStateChange: false,
			configurationService: { getValue: () => 'active' },
			shellService: {
				setHostedWorkbenchRestorePolicy: async () => undefined,
				getState: () => snapshotReady.p,
			},
			renderState: () => assert.fail('late snapshot rendered'),
			scheduleHostedWorkspaceLayout: () =>
				assert.fail('late snapshot scheduled layout'),
		});
		const initialize = Reflect.get(
			OmniHostPart.prototype,
			'initialize'
		) as (this: object) => Promise<void>;

		const initialization = initialize.call(host);
		await Promise.resolve();
		Reflect.set(host, 'didReceiveStateChange', true);
		Reflect.set(host, 'didHydrateShellState', true);
		Reflect.set(host, 'state', liveState);
		snapshotReady.complete(snapshotState);
		await initialization;

		assert.strictEqual(Reflect.get(host, 'state'), liveState);
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
					bounds: { x: number; y: number; width: number; height: number }
				) => layouts.push({ windowId: 7, bounds }),
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
	let currentSidebarVisible = sidebarVisible;
	const host = prototypeHost(OmniHostPart.prototype, {
		emptyState,
		surface,
		mainOverlayOccluded: false,
		overlayOccluded: false,
		overlayOcclusionToken: 0,
		hasScreenshot: false,
		activeInstanceId: 'old',
		state,
		didHydrateShellState: true,
		hasLoadedWorkbenchContext: {
			set: (loaded: boolean) => loadedContexts.push(loaded),
		},
		layoutService: {
			isVisible: (part: Parts) =>
				part === Parts.SIDEBAR_PART ? currentSidebarVisible : true,
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
		setSidebarVisible: (visible: boolean) =>
			currentSidebarVisible = visible,
	};
}

function runOmniHostFocus(
	state: IHucodeHostedWorkspaceState,
	emptyVisible: boolean,
	surfaceVisible: boolean
): string[] {
	const transitions: string[] = [];
	const emptyState = mainWindow.document.createElement('div');
	const surface = mainWindow.document.createElement('div');
	emptyState.classList.toggle('hidden', !emptyVisible);
	surface.classList.toggle('hidden', !surfaceVisible);
	emptyState.focus = () => transitions.push('landing');
	const host = prototypeHost(OmniHostPart.prototype, {
		state,
		emptyState,
		surface,
		addProjectButton: { focus: () => transitions.push('add-project') },
		shellService: {
			focusWorkspace: async () => {
				transitions.push('workbench');
			},
		},
		getContainer: () => ({ focus: () => transitions.push('container') }),
	});

	OmniHostPart.prototype.focus.call(host);
	return transitions;
}

function createOmniHostLandingHarness(
	state: IHucodeHostedWorkspaceState,
	projects: readonly ProjectRecord[] | undefined,
	projectManagerService?: { getProjects(): Promise<readonly ProjectRecord[]> },
	sidebarVisible = true
) {
	const harness = createOmniHostRenderHarness(state, sidebarVisible);
	const commands: string[] = [];
	const root = mainWindow.document.createElement('div');
	Object.assign(harness.host, {
		projects,
		didReceiveProjectsChange: false,
		projectManagerService: projectManagerService ?? {
			getProjects: async () => projects ?? [],
		},
		commandService: {
			executeCommand: async (commandId: string) => {
				commands.push(commandId);
			},
		},
		_register: <T>(disposable: T): T => disposable,
	});
	const createLandingView = Reflect.get(
		OmniHostPart.prototype,
		'createLandingView'
	) as (this: object, root: HTMLElement) => void;
	createLandingView.call(harness.host, root);
	return {
		...harness,
		commands,
		emptyState: Reflect.get(harness.host, 'emptyState') as HTMLElement,
	};
}

function renderOmniHostState(host: object): void {
	const renderState = Reflect.get(
		OmniHostPart.prototype,
		'renderState'
	) as (this: object) => void;
	renderState.call(host);
}

function readOmniHostLanding(emptyState: HTMLElement) {
	return {
		heading: emptyState.querySelector('h2')?.textContent,
		description: emptyState.querySelector('p')?.textContent,
		actionsHidden: emptyState.querySelector(
			'.hucode-omni-host-empty-actions'
		)?.classList.contains('hidden'),
	};
}

function projectRecord(
	overrides: Partial<ProjectRecord> = {}
): ProjectRecord {
	return {
		id: 'project',
		label: 'Project',
		rootUri: URI.file('/project'),
		pinned: false,
		order: 0,
		worktreeState: 'current',
		worktrees: [],
		...overrides,
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
