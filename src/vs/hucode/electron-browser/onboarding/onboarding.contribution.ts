/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../browser/migration/media/editorMigrationSetupHost.css';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { OPEN_ONBOARDING_COMMAND_ID } from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../workbench/common/editor.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { openSetupModalEditor } from '../setupModalEditors.js';
import { OnboardingEditorInput } from './onboardingEditorInput.js';
import { OnboardingEditorPane } from './onboardingEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(OnboardingEditorPane, OnboardingEditorPane.ID, localize('onboarding.editor', "Hucode Onboarding")),
	[new SyncDescriptor(OnboardingEditorInput)],
);

class OnboardingEditorInputSerializer implements IEditorSerializer {
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
	.registerEditorSerializer(OnboardingEditorInput.ID, OnboardingEditorInputSerializer);

class OpenOnboardingAction extends Action2 {
	constructor() {
		super({
			id: OPEN_ONBOARDING_COMMAND_ID,
			title: localize2('onboarding.command', "Hucode: Open Onboarding"),
			// Hidden from the Command Palette until the flow has its route content; the command
			// itself is complete so the host can be exercised end to end.
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openSetupModalEditor(accessor.get(IEditorService), () => new OnboardingEditorInput());
	}
}

registerAction2(OpenOnboardingAction);
