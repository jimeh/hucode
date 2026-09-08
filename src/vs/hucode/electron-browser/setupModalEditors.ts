/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../workbench/common/editor/editorInput.js';
import { IEditorService, MODAL_GROUP } from '../../workbench/services/editor/common/editorService.js';
import { EditorMigrationEditorInput } from './migration/editorMigrationEditorInput.js';
import { OnboardingEditorInput } from './onboarding/onboardingEditorInput.js';

/** True for either modal input that drives setup state. */
export function isHucodeSetupEditorInput(editor: EditorInput): boolean {
	return editor instanceof EditorMigrationEditorInput || editor instanceof OnboardingEditorInput;
}

/** The open in flight per editor service, so a second command waits for it rather than racing it. */
const opening = new WeakMap<IEditorService, Promise<void>>();

/**
 * Opens a setup modal input, or reveals whichever setup input is already open.
 *
 * The import and onboarding surfaces may not be open at the same time: onboarding embeds a
 * migration session of its own, and two sessions must never mutate the same target. Revealing
 * the open one keeps the user on the flow they started instead of stacking a second. An input
 * only appears among the open editors once its open has settled, so a command that arrives
 * while another open is in flight waits for it and then looks again.
 */
export async function openSetupModalEditor(editorService: IEditorService, create: () => EditorInput): Promise<void> {
	let pending = opening.get(editorService);
	while (pending) {
		await pending;
		pending = opening.get(editorService);
	}
	const open = editorService.editors.find(isHucodeSetupEditorInput);
	const own = editorService.openEditor(open ?? create(), { pinned: true, revealIfOpened: true }, MODAL_GROUP).then(() => undefined);
	opening.set(editorService, own);
	try {
		await own;
	} finally {
		if (opening.get(editorService) === own) {
			opening.delete(editorService);
		}
	}
}
