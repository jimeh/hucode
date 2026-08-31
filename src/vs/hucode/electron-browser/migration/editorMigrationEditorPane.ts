/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode, Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorMigrationFlowView } from '../../browser/migration/editorMigrationFlowView.js';
import { IEditorMigrationFlowService } from '../../browser/migration/editorMigrationFlow.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorMigrationEditorInput } from './editorMigrationEditorInput.js';

/** Modal editor pane that frames the reusable migration flow. */
export class EditorMigrationEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.hucodeEditorMigration';

	private container: HTMLElement | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorMigrationFlowService private readonly flowService: IEditorMigrationFlowService,
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
		this.inputDisposables.add(new EditorMigrationFlowView(this.container, session, () => void this.group.closeEditor(input)));
	}

	override clearInput(): void {
		const session = this.flowService.getStandaloneSession();
		if (session.state.phase === 'apply') {
			session.requestCancellation();
		}
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
