/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/omniHost.css';
import {
	$,
	addDisposableListener,
	append,
} from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Part } from '../../../workbench/browser/part.js';
import { localize } from '../../../nls.js';
import { BrowserOverlayManager } from
	'../../../workbench/contrib/browserView/browser/overlayManager.js';
import { Parts, IWorkbenchLayoutService } from
	'../../../workbench/services/layout/browser/layoutService.js';
import { IThemeService } from
	'../../../platform/theme/common/themeService.js';
import { IStorageService } from
	'../../../platform/storage/common/storage.js';
import { IContextKey, IContextKeyService } from
	'../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';
import {
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HucodeHostedWorkbenchRestorePolicy,
} from '../../common/retainedWorkbench.js';
import {
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from '../../common/omniWindow.js';
import { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';
import { isHostedWorkspaceAvailable } from
	'../../common/hostedWorkspaceState.js';
import { HasLoadedWorkbenchContext } from '../omniProjectsSidebarActions.js';
import { IHucodeWebOmniHostSurfaceService } from
	'../webOmniHostSurfaceService.js';
import { ICommandService } from
	'../../../platform/commands/common/commands.js';
import {
	IProjectManagerService,
	ProjectRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import {
	ADD_PROJECT_COMMAND_ID,
	ADD_WORKBENCH_COMMAND_ID,
} from '../projectSwitcher/projectSwitcherCommon.js';

/**
 * Dedicated Omni shell host surface.
 *
 * Unlike a generic pane-composite part, this host has no view-container
 * menus or chat-window chrome.
 */
export class OmniHostPart extends Part {

	readonly minimumWidth = 300;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;


	private surface: HTMLElement | undefined;
	private emptyState: HTMLElement | undefined;
	private emptyHeading: HTMLHeadingElement | undefined;
	private emptyDescription: HTMLParagraphElement | undefined;
	private emptyActions: HTMLElement | undefined;
	private addProjectButton: HTMLButtonElement | undefined;
	private screenshot: HTMLElement | undefined;
	private screenshotImage: HTMLImageElement | undefined;
	private state: IHucodeHostedWorkspaceState = {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
	private didReceiveStateChange = false;
	private didHydrateShellState = false;
	private projects: readonly ProjectRecord[] | undefined;
	private didReceiveProjectsChange = false;
	private bodyHeight = 0;
	private bodyWidth = 0;
	private layoutScheduled = false;
	private screenshotRefreshHandle: ReturnType<typeof setTimeout> | undefined;
	private screenshotCaptureInFlight: Promise<boolean> | undefined;
	private hasScreenshot = false;
	private overlayOccluded = false;
	private mainOverlayOccluded = false;
	private overlayOcclusionToken = 0;
	private activeInstanceId: string | undefined;
	private readonly hasLoadedWorkbenchContext: IContextKey<boolean>;
	private readonly overlayManager =
		this._register(new BrowserOverlayManager(mainWindow));

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IHucodeShellControllerService
		private readonly shellService: IHucodeShellControllerService,
		@IHucodeWebOmniHostSurfaceService
		private readonly hostSurfaceService: IHucodeWebOmniHostSurfaceService,
		@IProjectManagerService
		private readonly projectManagerService: IProjectManagerService,
		@ICommandService
		private readonly commandService: ICommandService,
	) {
		super(
			Parts.HUCODE_OMNI_HOST_PART,
			{ hasTitle: false },
			themeService,
			storageService,
			layoutService
		);

		this.hasLoadedWorkbenchContext =
			HasLoadedWorkbenchContext.bindTo(contextKeyService);

		this._register(this.shellService.onDidChangeState(state => {
			this.didReceiveStateChange = true;
			this.didHydrateShellState = true;
			this.state = state;
			this.renderState();
			this.scheduleHostedWorkspaceLayout();
		}));
		this._register(this.projectManagerService.onDidChangeProjects(projects => {
			this.didReceiveProjectsChange = true;
			this.projects = projects;
			this.renderState();
		}));

		this._register(this.overlayManager.onDidChangeOverlayState(() => {
			void this.updateOverlayOcclusion();
		}));

		this._register(this.onDidVisibilityChange(visible => {
			if (visible) {
				this.scheduleHostedWorkspaceLayout();
				this.updateScreenshotRefresh();
				void this.updateOverlayOcclusion();
			} else {
				this.stopScreenshotRefresh();
				this.clearOverlayOcclusion();
			}
		}));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		const content = append(parent, $('.content.hucode-omni-host-view'));
		const root = append(content, $('.hucode-omni-host-root'));
		this.screenshot = append(root, $('.hucode-omni-host-screenshot'));
		this.screenshotImage = append(
			this.screenshot,
			$<HTMLImageElement>('img.hucode-omni-host-screenshot-image')
		);
		this.screenshotImage.alt = '';
		this.screenshotImage.setAttribute('aria-hidden', 'true');
		this.surface = append(root, $('.hucode-omni-host-surface'));
		this.hostSurfaceService.setSurface(this.surface);
		this.createLandingView(root);

		void this.initialize();
		void this.initializeProjects().catch(onUnexpectedError);
		return content;
	}

	private createLandingView(root: HTMLElement): void {
		this.emptyState = append(root, $('.hucode-omni-host-empty'));
		this.emptyState.tabIndex = -1;
		this.emptyState.setAttribute('role', 'region');
		const content = append(
			this.emptyState,
			$('.hucode-omni-host-empty-content')
		);
		this.emptyHeading = append(
			content,
			$<HTMLHeadingElement>('h2.hucode-omni-host-empty-heading')
		);
		this.emptyHeading.id = 'hucode-omni-host-empty-heading';
		this.emptyDescription = append(
			content,
			$<HTMLParagraphElement>('p.hucode-omni-host-empty-description')
		);
		this.emptyDescription.id = 'hucode-omni-host-empty-description';
		this.emptyState.setAttribute(
			'aria-labelledby',
			this.emptyHeading.id
		);
		this.emptyState.setAttribute(
			'aria-describedby',
			this.emptyDescription.id
		);
		this.emptyActions = append(
			content,
			$('.hucode-omni-host-empty-actions')
		);
		this.addProjectButton = append(
			this.emptyActions,
			$<HTMLButtonElement>(
				'button.hucode-omni-host-empty-action.primary'
			)
		);
		this.addProjectButton.type = 'button';
		this.addProjectButton.textContent = localize(
			'omniEmptyAddProject',
			'Add Project'
		);
		this._register(addDisposableListener(this.addProjectButton, 'click', () => {
			void this.commandService.executeCommand(ADD_PROJECT_COMMAND_ID)
				.catch(onUnexpectedError);
		}));

		const addWorkbenchButton = append(
			this.emptyActions,
			$<HTMLButtonElement>(
				'button.hucode-omni-host-empty-action.secondary'
			)
		);
		addWorkbenchButton.type = 'button';
		addWorkbenchButton.textContent = localize(
			'omniEmptyAddWorkbench',
			'Open Folder as Workbench'
		);
		this._register(addDisposableListener(addWorkbenchButton, 'click', () => {
			void this.commandService.executeCommand(ADD_WORKBENCH_COMMAND_ID)
				.catch(onUnexpectedError);
		}));
	}

	override dispose(): void {
		this.stopScreenshotRefresh();
		this.clearOverlayOcclusion();
		this.clearScreenshot();
		this.activeInstanceId = undefined;
		if (this.hostSurfaceService.getSurface() === this.surface) {
			this.hostSurfaceService.setSurface(undefined);
		}
		super.dispose();
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		const layout = this.layoutContents(width, height);
		this.bodyHeight = layout.contentSize.height;
		this.bodyWidth = layout.contentSize.width;
		this.scheduleHostedWorkspaceLayout();
	}

	focus(): void {
		const activeInstance = this.getAvailableActiveInstance();
		if (
			activeInstance
			&& this.surface
			&& !this.surface.classList.contains('hidden')
		) {
			void this.shellService.focusWorkspace().catch(onUnexpectedError);
			return;
		}

		if (this.emptyState && !this.emptyState.classList.contains('hidden')) {
			if (this.getActiveInstance()?.state === 'crashed') {
				this.emptyState.focus();
			} else {
				this.addProjectButton?.focus();
			}
			return;
		}

		this.getContainer()?.focus();
	}

	override toJSON(): object {
		return { type: Parts.HUCODE_OMNI_HOST_PART };
	}

	private async initialize(): Promise<void> {
		await this.shellService.setHostedWorkbenchRestorePolicy(
			this.configurationService.getValue<
				HucodeHostedWorkbenchRestorePolicy
			>(HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING) ?? 'active'
		);
		const initialState = await this.shellService.getState();
		if (this.didReceiveStateChange) {
			return;
		}
		this.didHydrateShellState = true;
		this.state = initialState;
		this.renderState();
		this.scheduleHostedWorkspaceLayout();
	}

	private async initializeProjects(): Promise<void> {
		const initialProjects = await this.projectManagerService.getProjects();
		if (this.didReceiveProjectsChange) {
			return;
		}
		this.projects = initialProjects;
		this.renderState();
	}

	private renderState(): void {
		if (!this.emptyState || !this.surface) {
			return;
		}

		const hasLoadedWorkbench = this.hasLoadedWorkbench();
		this.hasLoadedWorkbenchContext.set(hasLoadedWorkbench);

		if (
			!hasLoadedWorkbench
			&& !this.layoutService.isVisible(Parts.SIDEBAR_PART)
		) {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		}

		const activeInstance = this.getAvailableActiveInstance();
		const activeInstanceId = activeInstance?.instanceId;
		const activeInstanceChanged = this.activeInstanceId !== activeInstanceId;
		this.activeInstanceId = activeInstanceId;
		if (activeInstanceChanged) {
			this.clearScreenshot();
			this.handleActiveInstanceChanged();
		}

		if (activeInstance) {
			this.setHostEmpty(!hasLoadedWorkbench);
			this.emptyState.classList.add('hidden');
			this.surface.classList.remove('hidden');
			this.updateScreenshotRefresh();
			return;
		}

		this.setHostEmpty(!hasLoadedWorkbench);
		this.renderLandingState();
		this.emptyState.classList.remove('hidden');
		this.surface.classList.add('hidden');
		this.stopScreenshotRefresh();
		this.clearOverlayOcclusion();
		this.clearScreenshot();
	}

	private renderLandingState(): void {
		if (!this.emptyHeading || !this.emptyDescription || !this.emptyActions) {
			return;
		}

		const activeInstance = this.getActiveInstance();
		if (activeInstance?.state === 'crashed') {
			this.emptyHeading.textContent = localize(
				'omniCrashedHeading',
				'Workbench crashed'
			);
			this.emptyDescription.textContent = localize(
				'omniCrashedDescription',
				'Select the crashed workbench in Projects to reopen it.'
			);
			this.emptyActions.classList.add('hidden');
			return;
		}

		const retainedWorkbenches = this.state.retainedWorkbenches ?? [];
		const catalogIsAuthoritativelyEmpty = this.didHydrateShellState
			&& this.projects?.length === 0
			&& retainedWorkbenches.length === 0;
		if (catalogIsAuthoritativelyEmpty) {
			this.emptyHeading.textContent = localize(
				'omniFirstWorkbenchHeading',
				'Open your first workbench'
			);
			this.emptyDescription.textContent = localize(
				'omniFirstWorkbenchDescription',
				'A project is a saved Git repository. A workbench can be any folder.'
			);
		} else {
			this.emptyHeading.textContent = localize(
				'omniSelectWorkbenchHeading',
				'Choose a project or workbench'
			);
			this.emptyDescription.textContent = localize(
				'omniSelectWorkbenchDescription',
				'Select an item from Projects to open it here.'
			);
		}
		this.emptyActions.classList.remove('hidden');
	}

	private scheduleHostedWorkspaceLayout(): void {
		if (
			!this.surface
			|| this.layoutScheduled
			|| !this.layoutService.isVisible(Parts.HUCODE_OMNI_HOST_PART)
			|| this.bodyHeight <= 0
			|| this.bodyWidth <= 0
		) {
			return;
		}

		this.layoutScheduled = true;
		mainWindow.requestAnimationFrame(() => {
			this.layoutScheduled = false;
			void this.layoutHostedWorkspace();
		});
	}

	private async layoutHostedWorkspace(): Promise<void> {
		if (
			!this.surface
			|| !this.layoutService.isVisible(Parts.HUCODE_OMNI_HOST_PART)
		) {
			return;
		}

		const rect = this.surface.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return;
		}

		const width = Math.max(0, mainWindow.innerWidth - rect.left);
		const height = Math.max(0, mainWindow.innerHeight);
		this.layoutScreenshot(rect.left, width, height);

		await this.shellService.layoutWorkspace({
			x: rect.left,
			y: 0,
			width,
			height,
		});
		void this.updateOverlayOcclusion();
		this.updateScreenshotRefresh();
	}

	private layoutScreenshot(
		left: number,
		width: number,
		height: number
	): void {
		if (!this.screenshot) {
			return;
		}

		this.screenshot.style.left = `${left}px`;
		this.screenshot.style.top = '0';
		this.screenshot.style.width = `${width}px`;
		this.screenshot.style.height = `${height}px`;
	}

	private setHostEmpty(empty: boolean): void {
		this.layoutService.getContainer(mainWindow)
			?.classList.toggle('hucode-omni-host-empty', empty);
	}

	private hasLoadedWorkbench(): boolean {
		return this.state.instances.some(instance =>
			this.isLoadedWorkbench(instance)
		);
	}

	private isLoadedWorkbench(
		instance: IHucodeHostedWorkbenchInstance
	): boolean {
		return isHostedWorkspaceAvailable(instance);
	}

	private getActiveInstance(): IHucodeHostedWorkbenchInstance | undefined {
		return this.state.activeInstanceId
			? this.state.instances.find(instance =>
				instance.instanceId === this.state.activeInstanceId
			)
			: undefined;
	}

	private getAvailableActiveInstance():
		IHucodeHostedWorkbenchInstance | undefined {
		const activeInstance = this.getActiveInstance();
		return activeInstance && this.isLoadedWorkbench(activeInstance)
			? activeInstance
			: undefined;
	}

	private hasVisibleHostedWorkspace(): boolean {
		const activeInstance = this.getActiveInstance();
		return !!activeInstance
			&& activeInstance.visible
			&& activeInstance.state !== 'crashed'
			&& activeInstance.state !== 'unloaded'
			&& this.layoutService.isVisible(Parts.HUCODE_OMNI_HOST_PART);
	}

	private updateScreenshotRefresh(): void {
		if (
			!this.shellService.supportsWorkspaceScreenshotOverlay
			|| !this.hasVisibleHostedWorkspace()
		) {
			this.stopScreenshotRefresh();
			return;
		}

		if (!this.screenshotRefreshHandle) {
			this.screenshotRefreshHandle = setTimeout(() => {
				this.screenshotRefreshHandle = undefined;
				void this.refreshScreenshot().finally(() =>
					this.updateScreenshotRefresh()
				);
			}, 1000);
		}
	}

	private stopScreenshotRefresh(): void {
		if (this.screenshotRefreshHandle) {
			clearTimeout(this.screenshotRefreshHandle);
			this.screenshotRefreshHandle = undefined;
		}
	}

	private async refreshScreenshot(): Promise<boolean> {
		if (!this.hasVisibleHostedWorkspace()) {
			return this.hasScreenshot;
		}

		if (this.screenshotCaptureInFlight) {
			return this.screenshotCaptureInFlight;
		}

		this.screenshotCaptureInFlight = this.doRefreshScreenshot();
		try {
			return await this.screenshotCaptureInFlight;
		} finally {
			this.screenshotCaptureInFlight = undefined;
		}
	}

	private async doRefreshScreenshot(): Promise<boolean> {
		let screenshot: VSBuffer | undefined;
		try {
			screenshot = await this.shellService.captureWorkspaceScreenshot(
				undefined,
				80
			);
		} catch {
			screenshot = undefined;
		}
		if (!screenshot) {
			return this.hasScreenshot;
		}

		this.setScreenshot(screenshot);
		return true;
	}

	private setScreenshot(buffer: VSBuffer): void {
		if (!this.screenshotImage) {
			return;
		}

		const dataUrl = `data:image/jpeg;base64,${encodeBase64(buffer)}`;
		this.screenshotImage.src = dataUrl;
		this.hasScreenshot = true;
		this.updateScreenshotVisibility();
	}

	private clearScreenshot(): void {
		if (this.screenshotImage) {
			this.screenshotImage.removeAttribute('src');
		}
		this.hasScreenshot = false;
		this.updateScreenshotVisibility();
	}

	private updateScreenshotVisibility(): void {
		this.screenshot?.classList.toggle(
			'visible',
			this.overlayOccluded && this.hasScreenshot
		);
	}

	private clearOverlayOcclusion(): void {
		this.overlayOcclusionToken++;
		if (!this.overlayOccluded && !this.mainOverlayOccluded) {
			this.updateScreenshotVisibility();
			return;
		}

		this.overlayOccluded = false;
		this.updateScreenshotVisibility();
		this.setMainOverlayOcclusion(false);
	}

	private handleActiveInstanceChanged(): void {
		const keepMainOccluded =
			(this.overlayOccluded || this.mainOverlayOccluded) &&
			this.hasOverlappingShellOverlay();
		this.overlayOcclusionToken++;
		if (!this.overlayOccluded && !this.mainOverlayOccluded) {
			this.updateScreenshotVisibility();
			return;
		}

		this.overlayOccluded = false;
		this.updateScreenshotVisibility();
		if (keepMainOccluded) {
			void this.updateOverlayOcclusion();
			return;
		}

		this.setMainOverlayOcclusion(false);
	}

	private setMainOverlayOcclusion(occluded: boolean): void {
		this.mainOverlayOccluded = occluded;
		void this.shellService.setWorkspaceOverlayOcclusion(
			occluded
		);
	}

	private hasOverlappingShellOverlay(): boolean {
		if (
			!this.shellService.supportsWorkspaceScreenshotOverlay
			|| !this.screenshot
			|| !this.hasVisibleHostedWorkspace()
		) {
			return false;
		}

		return this.overlayManager
			.getOverlappingOverlays(this.screenshot).length > 0;
	}

	private async updateOverlayOcclusion(): Promise<void> {
		const occluded = this.hasOverlappingShellOverlay();
		const token = ++this.overlayOcclusionToken;
		const activeInstanceId = this.activeInstanceId;

		if (!occluded) {
			this.clearOverlayOcclusion();
			return;
		}

		if (this.overlayOccluded) {
			return;
		}

		const hasScreenshot = await this.refreshScreenshot();
		if (
			token !== this.overlayOcclusionToken
			|| activeInstanceId !== this.activeInstanceId
			|| !hasScreenshot
			|| !this.hasOverlappingShellOverlay()
		) {
			return;
		}

		this.overlayOccluded = true;
		this.updateScreenshotVisibility();
		mainWindow.requestAnimationFrame(() => {
			if (
				!this.overlayOccluded
				|| token !== this.overlayOcclusionToken
				|| activeInstanceId !== this.activeInstanceId
			) {
				return;
			}

			this.setMainOverlayOcclusion(true);
		});
	}
}
