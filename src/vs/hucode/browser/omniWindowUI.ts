/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { localize2 } from '../../nls.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IsOmniWindowContext } from '../../workbench/common/contextkeys.js';

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
	constructor(id: string, title: string) {
		super({
			id,
			title: localize2(id, title),
			f1: true,
			precondition: IsOmniWindowContext
		});
	}
}

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.focusProjectPane',
			'Omni-Window: Focus Project Pane'
		);
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IHucodeOmniWindowUIService).focusProjectPane();
	}
});

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.openSelectedInOmniWindow',
			'Omni-Window: Open Selected Worktree'
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).openSelectedInOmni();
	}
});

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.openSelectedInNewWindow',
			'Omni-Window: Open Selected Worktree In New Window'
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).openSelectedInStandalone();
	}
});

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.focusWorkspace',
			'Omni-Window: Focus Workspace'
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).focusWorkspace();
	}
});

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.reloadWorkspace',
			'Omni-Window: Reload Workspace'
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).reloadWorkspace();
	}
});

registerAction2(class extends BaseOmniWindowAction {
	constructor() {
		super(
			'workbench.action.omniWindow.closeWorkspace',
			'Omni-Window: Close Workspace'
		);
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeOmniWindowUIService).closeWorkspace();
	}
});
