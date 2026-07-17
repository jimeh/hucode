/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/omniHost.css';
import {
	$,
	append,
} from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
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
import { focusWorkspaceBestEffort } from
	'../../common/omniWindowFocus.js';
import {
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';
import { HasLoadedWorkbenchContext } from '../omniProjectsSidebarActions.js';
import { IHucodeWebOmniHostSurfaceService } from
	'../webOmniHostSurfaceService.js';

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

	private readonly windowId: number;

	private surface: HTMLElement | undefined;
	private emptyState: HTMLElement | undefined;
	private screenshot: HTMLElement | undefined;
	private screenshotImage: HTMLImageElement | undefined;
	private state: IHucodeHostedWorkspaceState = {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
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
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
		@IHucodeWebOmniHostSurfaceService
		private readonly hostSurfaceService: IHucodeWebOmniHostSurfaceService,
	) {
		super(
			Parts.HUCODE_OMNI_HOST_PART,
			{ hasTitle: false },
			themeService,
			storageService,
			layoutService
		);

		this.windowId = mainWindow.vscodeWindowId;
		this.hasLoadedWorkbenchContext =
			HasLoadedWorkbenchContext.bindTo(contextKeyService);

		this._register(this.shellService.onDidChangeWindowState(change => {
			if (change.windowId !== this.windowId) {
				return;
			}

			this.state = change.state;
			this.renderState();
			this.scheduleHostedWorkspaceLayout();
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
		this.emptyState = append(
			root,
			$('.hucode-omni-host-empty', undefined,
				localize(
					'omniEmptyState',
					'Select a workbench or project worktree from the sidebar to load it into this window'
				))
		);

		void this.initialize();
		return content;
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
		this.getContainer()?.focus();
		void focusWorkspaceBestEffort(this.shellService, this.windowId);
	}

	override toJSON(): object {
		return { type: Parts.HUCODE_OMNI_HOST_PART };
	}

	private async initialize(): Promise<void> {
		await this.shellService.setHostedWorkbenchRestorePolicy(
			this.windowId,
			this.configurationService.getValue<
				HucodeHostedWorkbenchRestorePolicy
			>(HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING) ?? 'active'
		);
		this.state = await this.shellService.getWindowState(this.windowId);
		this.renderState();
		this.scheduleHostedWorkspaceLayout();
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

		const activeInstance = this.state.activeInstanceId
			? this.state.instances.find(instance =>
				instance.instanceId === this.state.activeInstanceId
				&& this.isLoadedWorkbench(instance)
			)
			: undefined;
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
		this.emptyState.classList.remove('hidden');
		this.surface.classList.add('hidden');
		this.stopScreenshotRefresh();
		this.clearOverlayOcclusion();
		this.clearScreenshot();
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

		await this.shellService.layoutWorkspace(this.windowId, {
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
		return instance.state !== 'crashed' && instance.state !== 'unloaded';
	}

	private getActiveInstance(): IHucodeHostedWorkbenchInstance | undefined {
		return this.state.activeInstanceId
			? this.state.instances.find(instance =>
				instance.instanceId === this.state.activeInstanceId
			)
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
				this.windowId,
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
			this.windowId,
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
