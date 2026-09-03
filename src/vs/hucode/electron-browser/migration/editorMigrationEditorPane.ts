/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode, Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IEditorOptions } from '../../../platform/editor/common/editor.js';
import { INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IEditorMigrationFlowService } from '../../browser/migration/editorMigrationFlow.js';
import { bindEditorMigrationCloseCancellation } from '../../browser/migration/editorMigrationSetupClose.js';
import { EditorMigrationSetupWebviewHost } from '../../browser/migration/editorMigrationSetupWebviewHost.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorMigrationEditorInput } from './editorMigrationEditorInput.js';

/** Directory name of the built-in extension that packages the renderer assets. */
export const SETUP_UI_EXTENSION_FOLDER = 'hucode-setup-ui';

/**
 * Media directory holding the built renderer assets.
 *
 * `builtinExtensionsPath` covers the development layout, the packaged layout, and an explicit
 * `--builtin-extensions-dir`. Extension registration and enablement never participate, so the
 * import UI still loads with extensions disabled.
 */
export function editorMigrationSetupMediaRoot(environmentService: INativeEnvironmentService): URI {
	return URI.joinPath(URI.file(environmentService.builtinExtensionsPath), SETUP_UI_EXTENSION_FOLDER, 'media');
}

/** Modal editor pane hosting the setup webview. */
export class EditorMigrationEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.hucodeEditorMigration';

	private container: HTMLElement | undefined;
	private host: EditorMigrationSetupWebviewHost | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorMigrationFlowService private readonly flowService: IEditorMigrationFlowService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super(EditorMigrationEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'hucode-editor-migration-editor';
		parent.appendChild(this.container);
	}

	override async setInput(input: EditorMigrationEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container) {
			return;
		}
		this.inputDisposables.clear();
		clearNode(this.container);
		const session = this.flowService.getStandaloneSession();
		// The webview element lives for exactly one `setInput` to `clearInput` cycle. Hiding the
		// singleton modal input disposes it; showing it again creates a fresh element whose state
		// is reconstructed from the session.
		this.host = this.inputDisposables.add(this.instantiationService.createInstance(
			EditorMigrationSetupWebviewHost,
			this.container,
			session,
			{
				mediaRoot: editorMigrationSetupMediaRoot(this.environmentService),
				onDone: () => void this.group.closeEditor(input),
			},
		));
		// Escape and outside-click close the modal at the editor-part level, so the cancel request
		// has to hang off the input's own disposal rather than anything the renderer sends.
		this.inputDisposables.add(bindEditorMigrationCloseCancellation(session, input.onWillDispose));
	}

	override focus(): void {
		super.focus();
		this.host?.focus();
	}

	override clearInput(): void {
		this.host = undefined;
		this.inputDisposables.clear();
		if (this.container) {
			clearNode(this.container);
		}
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
