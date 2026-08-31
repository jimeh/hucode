/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../workbench/common/editor.js';

const editorMigrationIcon = registerIcon('hucode-editor-migration-icon', Codicon.cloudDownload, localize('editorMigration.icon', "Icon for importing editor setup"));

/** Non-serializable singleton input for the standalone migration flow. */
export class EditorMigrationEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.hucodeEditorMigration';

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}

	get typeId(): string {
		return EditorMigrationEditorInput.ID;
	}

	get resource(): URI | undefined {
		return undefined;
	}

	override getName(): string {
		return localize('editorMigration.editorName', "Import Editor Setup");
	}

	override getIcon(): ThemeIcon {
		return editorMigrationIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof EditorMigrationEditorInput;
	}
}
