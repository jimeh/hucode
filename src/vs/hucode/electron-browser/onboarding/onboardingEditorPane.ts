/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode, Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../platform/editor/common/editor.js';
import { INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorMigrationSetupWebviewHost } from '../../browser/migration/editorMigrationSetupWebviewHost.js';
import { IOnboardingService, OnboardingSession } from '../../browser/onboarding/onboardingSession.js';
import { OnboardingSetupPresenter } from '../../browser/onboarding/onboardingSetupPresenter.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { editorMigrationSetupMediaRoot } from '../migration/editorMigrationEditorPane.js';
import { OnboardingEditorInput } from './onboardingEditorInput.js';

/** Modal editor pane hosting the onboarding route of the setup webview. */
export class OnboardingEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.hucodeOnboarding';

	private container: HTMLElement | undefined;
	private host: EditorMigrationSetupWebviewHost | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IOnboardingService private readonly onboardingService: IOnboardingService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super(OnboardingEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'hucode-editor-migration-editor';
		parent.appendChild(this.container);
	}

	override async setInput(input: OnboardingEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container) {
			return;
		}
		this.inputDisposables.clear();
		clearNode(this.container);
		const session = this.sessionFor(input);
		// The webview element lives for exactly one `setInput` to `clearInput` cycle. Hiding the
		// singleton modal input disposes it; showing it again creates a fresh element whose state
		// is reconstructed from the session the input still owns.
		this.host = this.inputDisposables.add(this.instantiationService.createInstance(
			EditorMigrationSetupWebviewHost,
			this.container,
			new OnboardingSetupPresenter(session),
			{
				mediaRoot: editorMigrationSetupMediaRoot(this.environmentService),
				onDone: () => void this.group.closeEditor(input),
			},
		));
	}

	/**
	 * The session belongs to the input, not to this pane.
	 *
	 * Hide-then-reshow reaches `setInput` again with the same input and must present the same
	 * session; closing the input disposes it and records the dismissal on the way.
	 */
	private sessionFor(input: OnboardingEditorInput): OnboardingSession {
		if (input.session) {
			return input.session;
		}
		const session = this.onboardingService.createSession();
		session.initialize();
		input.attachSession(session);
		return session;
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
