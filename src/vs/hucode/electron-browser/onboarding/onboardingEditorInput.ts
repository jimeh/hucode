/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IModalEditorOptions, IModalEditorOptionsProvider } from '../../../platform/editor/common/editor.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../workbench/common/editor.js';
import { OnboardingSession, bindOnboardingDismissal } from '../../browser/onboarding/onboardingSession.js';

const onboardingIcon = registerIcon('hucode-onboarding-icon', Codicon.rocket, localize('onboarding.icon', "Icon for Hucode onboarding"));

/**
 * Non-serializable singleton input for the onboarding flow.
 *
 * The input owns the session for exactly one open: the pane attaches it on first show, hiding
 * and reshowing the modal reuse it, and closing the modal records the dismissal and disposes it.
 */
export class OnboardingEditorInput extends EditorInput implements IModalEditorOptionsProvider {
	static readonly ID = 'workbench.input.hucodeOnboarding';

	private readonly sessionLifetime = this._register(new DisposableStore());
	private _session: OnboardingSession | undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}

	get typeId(): string {
		return OnboardingEditorInput.ID;
	}

	get resource(): URI | undefined {
		return undefined;
	}

	/** The session bound to this open, or `undefined` until the pane attaches one. */
	get session(): OnboardingSession | undefined {
		return this._session;
	}

	/**
	 * Binds one session to this input's lifetime.
	 *
	 * Escape, outside-click, and the close button dispose the input at the editor-part level, so
	 * the dismissal record hangs off `onWillDispose` rather than anything the renderer sends. The
	 * session is disposed afterwards, with the rest of the input.
	 */
	attachSession(session: OnboardingSession): void {
		if (this._session) {
			throw new Error('OnboardingEditorInput already owns a session.');
		}
		this._session = session;
		this.sessionLifetime.add(bindOnboardingDismissal(session, this.onWillDispose));
		this.sessionLifetime.add(session);
	}

	getModalEditorOptions(): IModalEditorOptions | undefined {
		// The renderer draws its own title and step header.
		return { compactHeader: true };
	}

	override getName(): string {
		return localize('onboarding.editorName', "Hucode Onboarding");
	}

	override getIcon(): ThemeIcon {
		return onboardingIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof OnboardingEditorInput;
	}
}
