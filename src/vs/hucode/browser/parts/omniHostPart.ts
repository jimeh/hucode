/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/omniHost.css';
import {
	$,
	append,
} from '../../../base/browser/dom.js';
import { Part } from '../../../workbench/browser/part.js';
import { localize } from '../../../nls.js';
import { Parts, IWorkbenchLayoutService } from
	'../../../workbench/services/layout/browser/layoutService.js';
import { IThemeService } from
	'../../../platform/theme/common/themeService.js';
import { IStorageService } from
	'../../../platform/storage/common/storage.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';

/**
 * Dedicated Omni shell host surface.
 *
 * Unlike the generic pane-composite chatbar, this part has no view-container
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
	private state: IHucodeHostedWorkspaceState = {
		instances: [],
	};
	private bodyHeight = 0;
	private bodyWidth = 0;
	private layoutScheduled = false;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
	) {
		super(
			Parts.CHATBAR_PART,
			{ hasTitle: false },
			themeService,
			storageService,
			layoutService
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

		this._register(this.onDidVisibilityChange(visible => {
			if (visible) {
				this.scheduleHostedWorkspaceLayout();
			}
		}));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		const content = append(parent, $('.content.hucode-omni-host-view'));
		const root = append(content, $('.hucode-omni-host-root'));
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
		return content;
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
		void this.shellService.focusWorkspace(this.windowId);
	}

	override toJSON(): object {
		return { type: Parts.CHATBAR_PART };
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
			|| !this.layoutService.isVisible(Parts.CHATBAR_PART)
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
		if (
			!this.surface
			|| !this.layoutService.isVisible(Parts.CHATBAR_PART)
		) {
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
