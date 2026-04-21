/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/omniHost.css';
import {
	$,
	append,
} from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { localize, localize2 } from '../../nls.js';
import { MenuId } from '../../platform/actions/common/actions.js';
import {
	IConfigurationService,
} from '../../platform/configuration/common/configuration.js';
import { IContextKeyService } from
	'../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from
	'../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { IInstantiationService } from
	'../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from
	'../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from
	'../../platform/keybinding/common/keybinding.js';
import { INotificationService } from
	'../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { registerIcon } from
	'../../platform/theme/common/iconRegistry.js';
import { IThemeService } from
	'../../platform/theme/common/themeService.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { IsOmniWindowContext } from
	'../../workbench/common/contextkeys.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewDescriptorService,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
} from '../../workbench/common/views.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IViewsService } from
	'../../workbench/services/views/common/viewsService.js';
import { ViewPane, ViewPaneShowActions } from
	'../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from
	'../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewletViewOptions } from
	'../../workbench/browser/parts/views/viewsViewlet.js';
import { Codicon } from '../../base/common/codicons.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';
import {
	PROJECT_SWITCHER_VIEW_ID,
	getSelectedProjectSwitcherTarget,
} from '../../workbench/contrib/projectSwitcher/electron-browser/projectSwitcher.contribution.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../common/omniWindow.js';
import { IHucodeOmniWindowUIService } from './omniWindowUI.js';

const OMNI_HOST_CONTAINER_ID = 'workbench.hucode.omniHost';
const OMNI_HOST_VIEW_ID = 'workbench.hucode.omniHost.view';

const omniHostIcon = registerIcon(
	'hucode-omni-host-view-icon',
	Codicon.browser,
	localize('omniHostIcon', 'View icon for the Omni-window workspace host.')
);

const OMNI_HOST_CONTAINER: ViewContainer =
	Registry.as<IViewContainersRegistry>(
		ViewExtensions.ViewContainersRegistry
	).registerViewContainer({
		id: OMNI_HOST_CONTAINER_ID,
		title: localize2('omniHostContainerTitle', 'Workspace'),
		icon: omniHostIcon,
		ctorDescriptor: new SyncDescriptor(
			ViewPaneContainer,
			[
				OMNI_HOST_CONTAINER_ID,
				{ mergeViewWithContainerWhenSingleView: true },
			]
		),
		storageId: OMNI_HOST_CONTAINER_ID,
		hideIfEmpty: true,
		order: 1,
	}, ViewContainerLocation.ChatBar, {
		isDefault: true,
		doNotRegisterOpenCommand: true,
	});

async function openSelectedInOmniWindow(
	windowId: number,
	shellService: IHucodeShellService,
	notificationService: INotificationService
): Promise<IHucodeHostedWorkspaceState | undefined> {
	const selection = getSelectedProjectSwitcherTarget();
	if (!selection) {
		notificationService.info(localize(
			'omniSelectWorktreeFirst',
			'Select a project or worktree first.'
		));
		return undefined;
	}

	return shellService.openWorkspace(
		windowId,
		selection.worktreePath,
		selection.projectId
	);
}

async function openSelectedInStandaloneWindow(
	hostService: IHostService,
	notificationService: INotificationService
): Promise<void> {
	const selection = getSelectedProjectSwitcherTarget();
	if (!selection) {
		notificationService.info(localize(
			'omniSelectWorktreeFirstStandalone',
			'Select a project or worktree first.'
		));
		return;
	}

	await hostService.openWindow(
		[{ folderUri: URI.file(selection.worktreePath) }],
		{ forceNewWindow: true }
	);
}

class OmniHostViewPane extends ViewPane {
	private readonly windowId: number;

	private surface: HTMLElement | undefined;
	private emptyState: HTMLElement | undefined;
	private state: IHucodeHostedWorkspaceState = {
		instances: [],
	};
	private bodyHeight = 0;
	private bodyWidth = 0;
	private layoutScheduled = false;

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
		@IViewDescriptorService
		viewDescriptorService: IViewDescriptorService,
	) {
		super(
			{
				...options,
				titleMenuId: MenuId.ViewTitle,
				showActions: ViewPaneShowActions.Always,
			},
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);

		this.windowId = this.environmentService.window.id;

		this._register(this.shellService.onDidChangeWindowState(change => {
			if (change.windowId !== this.windowId) {
				return;
			}

			this.state = change.state;
			this.renderState();
			this.scheduleHostedWorkspaceLayout();
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.scheduleHostedWorkspaceLayout();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('hucode-omni-host-view');
		const root = append(container, $('.hucode-omni-host-root'));
		this.surface = append(root, $('.hucode-omni-host-surface'));
		this.emptyState = append(
			root,
			$('.hucode-omni-host-empty', undefined,
				localize(
					'omniEmptyState',
					'Select a worktree in Projects to load it into this window.'
				))
		);

		void this.initialize();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodyHeight = height;
		this.bodyWidth = width;
		this.scheduleHostedWorkspaceLayout();
	}

	override focus(): void {
		super.focus();
		void this.shellService.focusWorkspace(this.windowId);
	}

	private async initialize(): Promise<void> {
		this.state = await this.shellService.getWindowState(this.windowId);
		this.renderState();
		this.scheduleHostedWorkspaceLayout();
	}

	private renderState(): void {
		if (!this.emptyState || !this.surface) {
			return;
		}

		const activeInstance = this.state.activeInstanceId
			? this.state.instances.find(instance =>
				instance.instanceId === this.state.activeInstanceId
			)
			: undefined;

		if (activeInstance) {
			this.emptyState.classList.add('hidden');
			this.surface.classList.remove('hidden');
			return;
		}

		this.emptyState.classList.remove('hidden');
		this.surface.classList.add('hidden');
	}

	private scheduleHostedWorkspaceLayout(): void {
		if (
			!this.surface
			|| this.layoutScheduled
			|| !this.isBodyVisible()
			|| this.bodyHeight <= 0
			|| this.bodyWidth <= 0
		) {
			return;
		}

		this.layoutScheduled = true;
		requestAnimationFrame(() => {
			this.layoutScheduled = false;
			void this.layoutHostedWorkspace();
		});
	}

	private async layoutHostedWorkspace(): Promise<void> {
		if (!this.surface || !this.isBodyVisible()) {
			return;
		}

		const rect = this.surface.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return;
		}

		const width = Math.max(0, window.innerWidth - rect.left);
		const height = Math.max(0, window.innerHeight);

		await this.shellService.layoutWorkspace(this.windowId, {
			x: rect.left,
			y: 0,
			width,
			height,
		});
	}
}

const omniHostView: IViewDescriptor = {
	id: OMNI_HOST_VIEW_ID,
	containerIcon: OMNI_HOST_CONTAINER.icon,
	containerTitle: OMNI_HOST_CONTAINER.title.value,
	singleViewPaneContainerTitle: OMNI_HOST_CONTAINER.title.value,
	name: localize2('omniHostViewTitle', 'Workspace'),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(OmniHostViewPane),
	when: IsOmniWindowContext,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[omniHostView],
	OMNI_HOST_CONTAINER
);

class OmniWindowShellContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.omniWindowShell';

	constructor(
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeOmniWindowUIService
		private readonly omniWindowUIService: IHucodeOmniWindowUIService,
		@IViewsService
		private readonly viewsService: IViewsService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
		@IHostService
		private readonly hostService: IHostService,
		@INotificationService
		private readonly notificationService: INotificationService,
	) {
		super();

		if (!this.environmentService.isOmniWindow) {
			return;
		}

		this._register(this.omniWindowUIService.registerDelegate({
			focusProjectPane: () => {
				void this.viewsService.openView(PROJECT_SWITCHER_VIEW_ID, true);
			},
			openSelectedInOmni: async () => {
				const nextState = await openSelectedInOmniWindow(
					this.environmentService.window.id,
					this.shellService,
					this.notificationService
				);
				if (nextState) {
					await this.shellService.focusWorkspace(
						this.environmentService.window.id
					);
				}
			},
			openSelectedInStandalone: () => openSelectedInStandaloneWindow(
				this.hostService,
				this.notificationService
			),
			focusWorkspace: () =>
				this.shellService.focusWorkspace(
					this.environmentService.window.id
				),
			reloadWorkspace: () =>
				this.shellService.reloadWorkspace(
					this.environmentService.window.id
				),
			closeWorkspace: () =>
				this.shellService.closeWorkspace(
					this.environmentService.window.id
				).then(() => undefined),
		}));

	}
}

registerWorkbenchContribution2(
	OmniWindowShellContribution.ID,
	OmniWindowShellContribution,
	WorkbenchPhase.AfterRestored
);
