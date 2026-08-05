/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { Part } from '../../../workbench/browser/part.js';
import { IConfigurationChangeEvent } from
	'../../../platform/configuration/common/configuration.js';
import { LayoutSettings, Parts } from
	'../../../workbench/services/layout/browser/layoutService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { Workbench } from '../../browser/workbench.js';

suite('Omni Workbench', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const setSideBarHidden = Reflect.get(
		Workbench.prototype,
		'setSideBarHidden'
	) as (this: IWorkbenchHost, hidden: boolean) => void;
	const setPanelHidden = Reflect.get(
		Workbench.prototype,
		'setPanelHidden'
	) as (this: IWorkbenchHost, hidden: boolean) => void;
	const getContainer = Workbench.prototype.getContainer as (
		this: IWorkbenchHost,
		targetWindow: Window,
		part?: Parts
	) => HTMLElement | undefined;
	const layout = Workbench.prototype.layout as
		(this: IWorkbenchHost) => void;
	const updateFloatingPanels = Reflect.get(
		Workbench.prototype,
		'updateFloatingPanels'
	) as (this: IWorkbenchHost) => void;
	const registerListeners = Reflect.get(
		Workbench.prototype,
		'registerListeners'
	) as (
		this: IWorkbenchHost,
		lifecycleService: unknown,
		storageService: unknown,
		configurationService: unknown,
		hostService: unknown,
		dialogService: unknown
	) => void;

	test('mirrors the Modern UI setting into Omni layout classes', () => {
		const enabled = createHost({ modernUI: true });
		const disabled = createHost({ modernUI: false });

		updateFloatingPanels.call(enabled);
		updateFloatingPanels.call(disabled);

		assert.deepStrictEqual({
			enabled: {
				floating: Workbench.prototype.isFloatingPanelsEnabled.call(enabled),
				classes: Workbench.prototype.getLayoutClasses.call(enabled),
				toggles: enabled.classToggles,
			},
			disabled: {
				floating: Workbench.prototype.isFloatingPanelsEnabled.call(disabled),
				classes: Workbench.prototype.getLayoutClasses.call(disabled),
				toggles: disabled.classToggles,
			},
		}, {
			enabled: {
				floating: true,
				classes: [
					'nomaineditorarea',
					'nopanel',
					'noauxiliarybar',
					'nostatusbar',
					'floating-panels',
					'style-override',
				],
				toggles: [
					{ name: 'floating-panels', force: true },
					{ name: 'style-override', force: true },
				],
			},
			disabled: {
				floating: false,
				classes: [
					'nomaineditorarea',
					'nopanel',
					'noauxiliarybar',
					'nostatusbar',
				],
				toggles: [
					{ name: 'floating-panels', force: false },
					{ name: 'style-override', force: false },
				],
			},
		});
	});

	test('relayouts the Omni shell when the Modern UI setting changes', () => {
		const configurationChanges = disposables.add(
			new Emitter<IConfigurationChangeEvent>()
		);
		let modernUI = false;
		let projectsRelayouts = 0;
		let workbenchRelayouts = 0;
		const configurationService = {
			getValue: <T>(key: string) => key === LayoutSettings.MODERN_UI
				? modernUI as T
				: undefined,
			onDidChangeConfiguration: configurationChanges.event,
		};
		const host = createHost({
			registerDisposable: disposable => disposables.add(disposable),
		});
		host.configurationService = configurationService;
		host.projectsPart.relayoutForModernUI = () => projectsRelayouts++;
		host.layout = () => workbenchRelayouts++;

		registerListeners.call(
			host,
			{
				onWillShutdown: Event.None,
				onDidShutdown: Event.None,
			},
			{
				onWillSaveState: Event.None,
				flush: () => undefined,
			},
			configurationService,
			{ onDidChangeFocus: Event.None },
			{
				onWillShowDialog: Event.None,
				onDidShowDialog: Event.None,
			}
		);

		modernUI = true;
		configurationChanges.fire({
			affectsConfiguration: (key: string) =>
				key === LayoutSettings.MODERN_UI,
		} as unknown as IConfigurationChangeEvent);

		assert.deepStrictEqual({
			classes: host.classToggles,
			projectsRelayouts,
			workbenchRelayouts,
		}, {
			classes: [
				{ name: 'floating-panels', force: true },
				{ name: 'style-override', force: true },
			],
			projectsRelayouts: 1,
			workbenchRelayouts: 1,
		});
	});

	test('sidebar visibility is idempotent and transfers focus to the host', () => {
		const host = createHost();
		host.focusedPart = Parts.SIDEBAR_PART;

		setSideBarHidden.call(host, true);
		setSideBarHidden.call(host, true);
		setSideBarHidden.call(host, false);

		assert.deepStrictEqual({
			visible: host.partVisibility.sidebar,
			gridVisibility: host.gridVisibility,
			focusedParts: host.focusedParts,
			classes: host.classToggles,
		}, {
			visible: true,
			gridVisibility: [false, true],
			focusedParts: [Parts.HUCODE_OMNI_HOST_PART],
			classes: [
				{ name: 'nosidebar', force: true },
				{ name: 'nosidebar', force: false },
			],
		});
	});

	test('panel cannot be shown by the shell', () => {
		const host = createHost({
			partVisibility: { panel: false },
		});

		setPanelHidden.call(host, false);

		assert.deepStrictEqual({
			visible: host.partVisibility.panel,
			gridVisibility: host.gridVisibility,
			focusedParts: host.focusedParts,
		}, {
			visible: false,
			gridVisibility: [],
			focusedParts: [],
		});
	});

	test('secondary side bar cannot be shown by the shell', () => {
		const host = createHost({
			partVisibility: { auxiliaryBar: false },
		});

		Workbench.prototype.toggleSecondarySideBar.call(host);

		assert.deepStrictEqual({
			visible: Workbench.prototype.isSecondarySideBarVisible.call(host),
			gridVisibility: host.gridVisibility,
		}, {
			visible: false,
			gridVisibility: [],
		});
	});

	test('hiding a focused panel returns focus to the hosted workbench', () => {
		const host = createHost({
			partVisibility: { panel: true },
			activePanel: true,
		});
		host.focusedPart = Parts.PANEL_PART;

		setPanelHidden.call(host, true);
		setPanelHidden.call(host, true);

		assert.deepStrictEqual({
			visible: host.partVisibility.panel,
			gridVisibility: host.gridVisibility,
			hideCompositeCount: host.hideCompositeCount,
			focusedParts: host.focusedParts,
		}, {
			visible: false,
			gridVisibility: [false],
			hideCompositeCount: 1,
			focusedParts: [Parts.HUCODE_OMNI_HOST_PART],
		});
	});

	test('focusPart delegates shell-owned surfaces to their parts', () => {
		const host = createHost();

		Workbench.prototype.focusPart.call(host, Parts.SIDEBAR_PART);
		Workbench.prototype.focusPart.call(host, Parts.HUCODE_OMNI_HOST_PART);

		assert.deepStrictEqual(host.delegatedFocus, ['projects', 'host']);
	});

	test('preserves the user sidebar width when the window width changes', () => {
		const parent = mainWindow.document.createElement('div');
		Object.defineProperties(parent, {
			clientWidth: { value: 1200 },
			clientHeight: { value: 700 },
		});
		const host = createHost({
			parent,
			mainContainerDimension: { width: 1000, height: 700 },
			sidebarSize: { width: 345, height: 700 },
		});

		layout.call(host);

		assert.deepStrictEqual({
			dimension: {
				width: host._mainContainerDimension.width,
				height: host._mainContainerDimension.height,
			},
			gridLayouts: host.gridLayouts,
			resizes: host.resizes,
			mainStyle: {
				width: host.mainContainer.style.width,
				height: host.mainContainer.style.height,
			},
			layoutEvents: host.layoutEvents.map(dimension => ({
				width: dimension.width,
				height: dimension.height,
			})),
		}, {
			dimension: { width: 1200, height: 700 },
			gridLayouts: [{ width: 1200, height: 700 }],
			resizes: [{
				view: 'sidebar',
				size: { width: 345, height: 700 },
			}],
			mainStyle: { width: '1200px', height: '700px' },
			layoutEvents: [{ width: 1200, height: 700 }],
		});
	});

	test('does not resize the sidebar when only height changes', () => {
		const parent = mainWindow.document.createElement('div');
		Object.defineProperties(parent, {
			clientWidth: { value: 1000 },
			clientHeight: { value: 800 },
		});
		const host = createHost({
			parent,
			mainContainerDimension: { width: 1000, height: 700 },
			sidebarSize: { width: 345, height: 700 },
		});

		layout.call(host);

		assert.deepStrictEqual(host.resizes, []);
	});

	test('resolves main and auxiliary editor containers without exposing other parts', () => {
		const host = createHost();
		const editorContainer = mainWindow.document.createElement('div');
		const editorPart = Object.create(Part.prototype) as Part;
		editorPart.getContainer = () => editorContainer;
		const auxiliaryDocument = mainWindow.document.implementation
			.createHTMLDocument('auxiliary');
		const auxiliaryWorkbench = auxiliaryDocument.createElement('div');
		auxiliaryWorkbench.className = 'monaco-workbench';
		auxiliaryDocument.body.appendChild(auxiliaryWorkbench);
		const auxiliaryWindow = { document: auxiliaryDocument } as Window;
		host.editorGroupService = {
			getPart: (container: HTMLElement) =>
				container === auxiliaryWorkbench ? editorPart : undefined,
		};

		assert.deepStrictEqual({
			main: getContainer.call(host, mainWindow) === host.mainContainer,
			mainSidebar: getContainer.call(
				host,
				mainWindow,
				Parts.SIDEBAR_PART
			) === host.sidebarContainer,
			auxiliary: getContainer.call(host, auxiliaryWindow) ===
				auxiliaryWorkbench,
			auxiliaryEditor: getContainer.call(
				host,
				auxiliaryWindow,
				Parts.EDITOR_PART
			) === editorContainer,
			auxiliarySidebar: getContainer.call(
				host,
				auxiliaryWindow,
				Parts.SIDEBAR_PART
			),
		}, {
			main: true,
			mainSidebar: true,
			auxiliary: true,
			auxiliaryEditor: true,
			auxiliarySidebar: undefined,
		});
	});

	test('registerPart removes only the registration it created', () => {
		const parts = new Map<string, Part>();
		const part = Object.create(Part.prototype) as Part;
		part.getId = () => Parts.SIDEBAR_PART;
		const host = prototypeHost(Workbench.prototype, { parts });

		const registration = Workbench.prototype.registerPart.call(host, part);
		const whileRegistered = parts.get(Parts.SIDEBAR_PART);
		registration.dispose();

		assert.deepStrictEqual({
			whileRegistered: whileRegistered === part,
			afterDispose: parts.has(Parts.SIDEBAR_PART),
		}, {
			whileRegistered: true,
			afterDispose: false,
		});
	});

	test('disposing an older registration preserves its replacement', () => {
		const parts = new Map<string, Part>();
		const first = Object.create(Part.prototype) as Part;
		const replacement = Object.create(Part.prototype) as Part;
		first.getId = replacement.getId = () => Parts.SIDEBAR_PART;
		const host = prototypeHost(Workbench.prototype, { parts });

		const firstRegistration = Workbench.prototype.registerPart.call(
			host,
			first
		);
		const replacementRegistration = Workbench.prototype.registerPart.call(
			host,
			replacement
		);
		firstRegistration.dispose();
		const afterOlderDisposal = parts.get(Parts.SIDEBAR_PART);
		replacementRegistration.dispose();

		assert.deepStrictEqual({
			afterOlderDisposal: afterOlderDisposal === replacement,
			afterReplacementDisposal: parts.has(Parts.SIDEBAR_PART),
		}, {
			afterOlderDisposal: true,
			afterReplacementDisposal: false,
		});
	});
});

interface IWorkbenchHost {
	parent: HTMLElement;
	mainContainer: HTMLElement;
	_mainContainerDimension: { width: number; height: number };
	mainWindowFullscreen: boolean;
	partVisibility: {
		sidebar: boolean;
		auxiliaryBar: boolean;
		editor: boolean;
		panel: boolean;
		omniHost: boolean;
	};
	workbenchGrid: {
		layout(width: number, height: number): void;
		getViewSize(view: object): { width: number; height: number };
		resizeView(
			view: object,
			size: { width: number; height: number }
		): void;
		setViewVisible(view: object, visible: boolean): void;
		hasMaximizedView(): boolean;
		exitMaximizedView(): void;
	};
	sideBarPartView: object;
	panelPartView: object;
	sidebarContainer: HTMLElement;
	parts: Map<string, { getContainer(): HTMLElement }>;
	paneCompositeService: {
		getActivePaneComposite(): object | undefined;
		hideActivePaneComposite(): void;
	};
	projectsPart: {
		focus(): void;
		relayoutForModernUI(): void;
	};
	omniHostPart: { focus(): void };
	editorGroupService: {
		getPart(container: HTMLElement): Part | undefined;
	};
	focusedPart?: Parts;
	readonly gridVisibility: boolean[];
	readonly focusedParts: Parts[];
	readonly delegatedFocus: string[];
	readonly classToggles: Array<{ name: string; force: boolean }>;
	readonly gridLayouts: Array<{ width: number; height: number }>;
	readonly resizes: Array<{
		view: string;
		size: { width: number; height: number };
	}>;
	readonly layoutEvents: Array<{ width: number; height: number }>;
	configurationService: {
		getValue<T>(key: string): T | undefined;
	};
	layout(): void;
	hideCompositeCount: number;
	hasFocus(part: Parts): boolean;
	focusPart(part: Parts): void;
}

function createHost(options: {
	readonly parent?: HTMLElement;
	readonly partVisibility?: Partial<IWorkbenchHost['partVisibility']>;
	readonly mainContainerDimension?: { width: number; height: number };
	readonly sidebarSize?: { width: number; height: number };
	readonly activePanel?: boolean;
	readonly modernUI?: boolean;
	readonly registerDisposable?: <T extends IDisposable>(disposable: T) => T;
} = {}): IWorkbenchHost {
	const parent = options.parent ?? mainWindow.document.createElement('div');
	const mainContainer = mainWindow.document.createElement('div');
	const sidebarContainer = mainWindow.document.createElement('div');
	const sideBarPartView = {};
	const panelPartView = {};
	const gridVisibility: boolean[] = [];
	const focusedParts: Parts[] = [];
	const delegatedFocus: string[] = [];
	const classToggles: Array<{ name: string; force: boolean }> = [];
	const gridLayouts: Array<{ width: number; height: number }> = [];
	const resizes: Array<{
		view: string;
		size: { width: number; height: number };
	}> = [];
	const layoutEvents: Array<{ width: number; height: number }> = [];
	const host = prototypeHost(Workbench.prototype, {
		_register: <T extends IDisposable>(disposable: T) =>
			options.registerDisposable?.(disposable) ?? disposable,
		parent,
		mainContainer,
		_mainContainerDimension:
			options.mainContainerDimension ?? { width: 1000, height: 700 },
		mainWindowFullscreen: false,
		partVisibility: {
			sidebar: true,
			auxiliaryBar: false,
			editor: false,
			panel: false,
			omniHost: true,
			...options.partVisibility,
		},
		sideBarPartView,
		panelPartView,
		auxiliaryBarPartView: {},
		omniHostPartView: {},
		titleBarPartView: {},
		sidebarContainer,
		parts: new Map([
			[Parts.SIDEBAR_PART, { getContainer: () => sidebarContainer }],
		]),
		workbenchGrid: {
			layout: (width: number, height: number) =>
				gridLayouts.push({ width, height }),
			getViewSize: (view: object) => view === sideBarPartView
				? options.sidebarSize ?? { width: 300, height: 700 }
				: { width: 400, height: 700 },
			resizeView: (view: object, size: { width: number; height: number }) =>
				resizes.push({
					view: view === sideBarPartView ? 'sidebar' : 'other',
					size,
				}),
			setViewVisible: (_view: object, visible: boolean) =>
				gridVisibility.push(visible),
			hasMaximizedView: () => false,
			exitMaximizedView: () => undefined,
		},
		paneCompositeService: {
			getActivePaneComposite: () => options.activePanel ? {} : undefined,
			hideActivePaneComposite: () => {
				host.hideCompositeCount++;
			},
		},
		projectsPart: {
			focus: () => delegatedFocus.push('projects'),
			relayoutForModernUI: () => undefined,
		},
		omniHostPart: {
			focus: () => delegatedFocus.push('host'),
		},
		editorGroupService: {
			getPart: () => undefined,
			activeGroup: { focus: () => delegatedFocus.push('editor') },
		},
		logService: { trace: () => undefined },
		configurationService: {
			getValue: <T>(key: string) => key === LayoutSettings.MODERN_UI
				? options.modernUI as T
				: undefined,
		},
		_onDidLayoutContainer: { fire: () => undefined },
		_onDidLayoutMainContainer: {
			fire: (dimension: { width: number; height: number }) =>
				layoutEvents.push(dimension),
		},
		_onDidLayoutActiveContainer: { fire: () => undefined },
		gridVisibility,
		focusedParts,
		delegatedFocus,
		classToggles,
		gridLayouts,
		resizes,
		layoutEvents,
		hideCompositeCount: 0,
		focusedPart: undefined as Parts | undefined,
		hasFocus(part: Parts) {
			return host.focusedPart === part;
		},
		focusPart(part: Parts) {
			focusedParts.push(part);
		},
	});
	const originalToggle = mainContainer.classList.toggle.bind(
		mainContainer.classList
	);
	mainContainer.classList.toggle = (name: string, force?: boolean) => {
		classToggles.push({ name, force: !!force });
		return originalToggle(name, force);
	};
	return host as unknown as IWorkbenchHost;
}

function prototypeHost<T extends object>(
	prototype: object,
	fields: T
): T {
	return Object.assign(Object.create(prototype) as object, fields) as T;
}
