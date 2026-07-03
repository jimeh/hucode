/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { localize2 } from '../../nls.js';
import {
	Action2,
	type IAction2Options,
} from '../../platform/actions/common/actions.js';
import type { ILocalizedString } from
	'../../platform/action/common/action.js';
import { registerOmniShellAction2 } from './omniShellCommandRegistration.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IsOmniWindowContext } from '../../workbench/common/contextkeys.js';
import { IsDevelopmentContext } from '../../platform/contextkey/common/contextkeys.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import { HasLoadedWorkbenchContext } from './omniProjectsSidebarActions.js';

interface IHucodeOmniWindowUIDelegate {
	focusProjectPane(): void;
	openSelectedInOmni(): Promise<void>;
	openSelectedInStandalone(): Promise<void>;
	focusWorkspace(): Promise<void>;
	reloadWorkspace(): Promise<void>;
	closeWorkspace(): Promise<void>;
}

/**
 * Browser-side command surface for the Omni-window shell UI.
 */
export const IHucodeOmniWindowUIService =
	createDecorator<IHucodeOmniWindowUIService>('hucodeOmniWindowUIService');

/**
 * Exposes shell actions that operate on the active Omni-window renderer UI.
 */
export interface IHucodeOmniWindowUIService {
	readonly _serviceBrand: undefined;

	registerDelegate(delegate: IHucodeOmniWindowUIDelegate): IDisposable;
	focusProjectPane(): void;
	openSelectedInOmni(): Promise<void>;
	openSelectedInStandalone(): Promise<void>;
	focusWorkspace(): Promise<void>;
	reloadWorkspace(): Promise<void>;
	closeWorkspace(): Promise<void>;
}

class HucodeOmniWindowUIService implements IHucodeOmniWindowUIService {
	declare readonly _serviceBrand: undefined;

	private delegate: IHucodeOmniWindowUIDelegate | undefined;

	registerDelegate(delegate: IHucodeOmniWindowUIDelegate): IDisposable {
		this.delegate = delegate;
		return toDisposable(() => {
			if (this.delegate === delegate) {
				this.delegate = undefined;
			}
		});
	}

	focusProjectPane(): void {
		this.delegate?.focusProjectPane();
	}

	openSelectedInOmni(): Promise<void> {
		return this.delegate?.openSelectedInOmni() ?? Promise.resolve();
	}

	openSelectedInStandalone(): Promise<void> {
		return this.delegate?.openSelectedInStandalone() ?? Promise.resolve();
	}

	focusWorkspace(): Promise<void> {
		return this.delegate?.focusWorkspace() ?? Promise.resolve();
	}

	reloadWorkspace(): Promise<void> {
		return this.delegate?.reloadWorkspace() ?? Promise.resolve();
	}

	closeWorkspace(): Promise<void> {
		return this.delegate?.closeWorkspace() ?? Promise.resolve();
	}
}

registerSingleton(
	IHucodeOmniWindowUIService,
	HucodeOmniWindowUIService,
	InstantiationType.Delayed
);

abstract class BaseOmniWindowAction extends Action2 {
	constructor(
		id: string,
		title: ILocalizedString,
		keybinding?: IAction2Options['keybinding']
	) {
		super({
			id,
			title,
			f1: true,
			precondition: IsOmniWindowContext,
			keybinding
		});
	}
}

registerOmniShellAction2(FOCUS_PROJECT_PANE_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			FOCUS_PROJECT_PANE_COMMAND_ID,
			localize2(
				'omniWindowFocusProjectPane',
				'Omni-Window: Focus Project Pane'
			)
		);
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IHucodeOmniWindowUIService).focusProjectPane();
	}
});

registerOmniShellAction2(OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
			localize2(
				'omniWindowOpenSelectedInOmniWindow',
				'Omni-Window: Open Selected Worktree'
			)
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).openSelectedInOmni();
	}
});

registerOmniShellAction2(OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
			localize2(
				'omniWindowOpenSelectedInNewWindow',
				'Omni-Window: Open Selected Worktree In New Window'
			)
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(
			IHucodeOmniWindowUIService
		).openSelectedInStandalone();
	}
});

registerOmniShellAction2(FOCUS_WORKSPACE_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			FOCUS_WORKSPACE_COMMAND_ID,
			localize2(
				'omniWindowFocusWorkspace',
				'Omni-Window: Focus Workspace'
			)
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).focusWorkspace();
	}
});

registerOmniShellAction2(RELOAD_WORKSPACE_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			RELOAD_WORKSPACE_COMMAND_ID,
			localize2(
				'omniWindowReloadWorkspace',
				'Omni-Window: Reload Workspace'
			),
			{
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: ContextKeyExpr.and(
					IsDevelopmentContext,
					IsOmniWindowContext
				),
				primary: KeyMod.CtrlCmd | KeyCode.KeyR
			}
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).reloadWorkspace();
	}
});

registerOmniShellAction2(CLOSE_WORKSPACE_COMMAND_ID, class extends BaseOmniWindowAction {
	constructor() {
		super(
			CLOSE_WORKSPACE_COMMAND_ID,
			localize2(
				'omniWindowCloseWorkspace',
				'Omni-Window: Close Workspace'
			)
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).closeWorkspace();
	}
});

registerOmniShellAction2(UNLOAD_CURRENT_WORKTREE_COMMAND_ID, class extends Action2 {
	constructor() {
		super({
			id: UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			title: localize2(
				'omniWindowUnloadCurrentWorktree',
				'Omni-Window: Unload Current Worktree'
			),
			f1: true,
			precondition: ContextKeyExpr.and(
				IsOmniWindowContext,
				HasLoadedWorkbenchContext
			),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).closeWorkspace();
	}
});
