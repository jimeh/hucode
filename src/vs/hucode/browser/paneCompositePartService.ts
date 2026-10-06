/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { assertNever } from '../../base/common/assert.js';
import { IInstantiationService } from
	'../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from
	'../../platform/progress/common/progress.js';
import { IPaneComposite } from '../../workbench/common/panecomposite.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { IPaneCompositePartService } from
	'../../workbench/services/panecomposite/browser/panecomposite.js';
import { Disposable } from '../../base/common/lifecycle.js';
import {
	Extensions as PaneCompositeExtensions,
	PaneCompositeDescriptor,
} from
	'../../workbench/browser/panecomposite.js';
import { IPaneCompositePart } from
	'../../workbench/browser/parts/paneCompositePart.js';
import { Parts, SINGLE_WINDOW_PARTS } from
	'../../workbench/services/layout/browser/layoutService.js';
import { PanelPart } from './parts/panelPart.js';
import { AuxiliaryBarPart } from
	'./parts/auxiliaryBarPart.js';
import {
	InstantiationType,
	registerSingleton,
} from '../../platform/instantiation/common/extensions.js';

export class OmniPaneCompositePartService extends Disposable
	implements IPaneCompositePartService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidPaneCompositeOpen = this._register(
		new Emitter<{
			composite: IPaneComposite;
			viewContainerLocation: ViewContainerLocation;
		}>()
	);
	readonly onDidPaneCompositeOpen = this._onDidPaneCompositeOpen.event;

	private readonly _onDidPaneCompositeClose = this._register(
		new Emitter<{
			composite: IPaneComposite;
			viewContainerLocation: ViewContainerLocation;
		}>()
	);
	readonly onDidPaneCompositeClose = this._onDidPaneCompositeClose.event;

	private readonly paneCompositeParts = new Map<
		ViewContainerLocation,
		IPaneCompositePart
	>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.registerPart(
			ViewContainerLocation.Panel,
			instantiationService.createInstance(PanelPart)
		);
		this.registerPart(
			ViewContainerLocation.AuxiliaryBar,
			instantiationService.createInstance(AuxiliaryBarPart)
		);
	}

	private registerPart(
		location: ViewContainerLocation,
		part: IPaneCompositePart
	): void {
		this.paneCompositeParts.set(location, part);
		this._register(part.onDidPaneCompositeOpen(composite =>
			this._onDidPaneCompositeOpen.fire({
				composite,
				viewContainerLocation: location,
			})
		));
		this._register(part.onDidPaneCompositeClose(composite =>
			this._onDidPaneCompositeClose.fire({
				composite,
				viewContainerLocation: location,
			})
		));
	}

	getRegistryId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation)?.registryId
			?? this.getRegistryIdByLocation(viewContainerLocation);
	}

	getPartId(viewContainerLocation: ViewContainerLocation): SINGLE_WINDOW_PARTS {
		const part = this.getPartByLocation(viewContainerLocation);
		if (part) {
			return part.partId;
		}

		return Parts.SIDEBAR_PART;
	}

	openPaneComposite(
		id: string | undefined,
		viewContainerLocation: ViewContainerLocation,
		focus?: boolean
	): Promise<IPaneComposite | undefined> {
		return this.getPartByLocation(viewContainerLocation)
			?.openPaneComposite(id, focus) ?? Promise.resolve(undefined);
	}

	getActivePaneComposite(
		viewContainerLocation: ViewContainerLocation
	): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation)
			?.getActivePaneComposite();
	}

	getPaneComposite(
		id: string,
		viewContainerLocation: ViewContainerLocation
	): PaneCompositeDescriptor | undefined {
		return this.getPartByLocation(viewContainerLocation)
			?.getPaneComposite(id);
	}

	getPaneComposites(
		viewContainerLocation: ViewContainerLocation
	): PaneCompositeDescriptor[] {
		return this.getPartByLocation(viewContainerLocation)
			?.getPaneComposites() ?? [];
	}

	getPinnedPaneCompositeIds(
		viewContainerLocation: ViewContainerLocation
	): string[] {
		return this.getPartByLocation(viewContainerLocation)
			?.getPinnedPaneCompositeIds() ?? [];
	}

	getVisiblePaneCompositeIds(
		viewContainerLocation: ViewContainerLocation
	): string[] {
		return this.getPartByLocation(viewContainerLocation)
			?.getVisiblePaneCompositeIds() ?? [];
	}

	getPaneCompositeIds(
		viewContainerLocation: ViewContainerLocation
	): string[] {
		return this.getPartByLocation(viewContainerLocation)
			?.getPaneCompositeIds() ?? [];
	}

	getProgressIndicator(
		id: string,
		viewContainerLocation: ViewContainerLocation
	): IProgressIndicator | undefined {
		return this.getPartByLocation(viewContainerLocation)
			?.getProgressIndicator(id);
	}

	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation)?.hideActivePaneComposite();
	}

	getLastActivePaneCompositeId(
		viewContainerLocation: ViewContainerLocation
	): string {
		return this.getPartByLocation(viewContainerLocation)
			?.getLastActivePaneCompositeId() ?? '';
	}

	private getPartByLocation(
		viewContainerLocation: ViewContainerLocation
	): IPaneCompositePart | undefined {
		return this.paneCompositeParts.get(viewContainerLocation);
	}

	private getRegistryIdByLocation(
		viewContainerLocation: ViewContainerLocation
	): string {
		switch (viewContainerLocation) {
			case ViewContainerLocation.Sidebar:
				return PaneCompositeExtensions.Viewlets;
			case ViewContainerLocation.Panel:
				return PaneCompositeExtensions.Panels;
			case ViewContainerLocation.AuxiliaryBar:
				return PaneCompositeExtensions.Auxiliary;
			default:
				return assertNever(viewContainerLocation);
		}
	}
}

registerSingleton(
	IPaneCompositePartService,
	OmniPaneCompositePartService,
	InstantiationType.Delayed
);
