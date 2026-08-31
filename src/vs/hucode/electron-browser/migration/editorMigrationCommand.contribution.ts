/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../browser/migration/media/editorMigrationFlow.css';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IMPORT_EDITOR_SETUP_COMMAND_ID } from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../workbench/common/editor.js';
import { IEditorService, MODAL_GROUP } from '../../../workbench/services/editor/common/editorService.js';
import { EditorMigrationEditorInput } from './editorMigrationEditorInput.js';
import { EditorMigrationEditorPane } from './editorMigrationEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(EditorMigrationEditorPane, EditorMigrationEditorPane.ID, localize('editorMigration.editor', "Import Editor Setup")),
	[new SyncDescriptor(EditorMigrationEditorInput)],
);

class EditorMigrationEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}

	serialize(): undefined {
		return undefined;
	}

	deserialize(): undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(EditorMigrationEditorInput.ID, EditorMigrationEditorInputSerializer);

class ImportEditorSetupAction extends Action2 {
	constructor() {
		super({
			id: IMPORT_EDITOR_SETUP_COMMAND_ID,
			title: localize2('editorMigration.command', "Hucode: Import Setup from Another Editor..."),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new EditorMigrationEditorInput(), { pinned: true, revealIfOpened: true }, MODAL_GROUP);
	}
}

registerAction2(ImportEditorSetupAction);
