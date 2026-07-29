/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../platform/log/common/log.js';
import { ILifecycleService } from
	'../../workbench/services/lifecycle/common/lifecycle.js';

/**
 * Lifecycle services that can run the two halves of a shutdown separately: a
 * veto-capable preparation that changes no lifecycle state, and the
 * irreversible commit that follows it. `BrowserLifecycleService` implements
 * both; `ILifecycleService` itself only offers the combined `shutdown()`.
 */
export interface IHucodeTwoPhaseShutdown {

	/**
	 * Fires `onBeforeShutdown` and resolves the collected veto.
	 */
	prepareShutdown(): Promise<boolean>;

	/**
	 * Fires `onWillShutdown` and `onDidShutdown`.
	 */
	commitShutdown(): Promise<void>;
}

/** Narrows a lifecycle service to the two-phase shutdown seam. */
export function supportsTwoPhaseShutdown(
	lifecycleService: ILifecycleService
): lifecycleService is ILifecycleService & IHucodeTwoPhaseShutdown {
	const candidate = lifecycleService as Partial<IHucodeTwoPhaseShutdown>;
	return typeof candidate.prepareShutdown === 'function' &&
		typeof candidate.commitShutdown === 'function';
}

/**
 * Workbench half of the hosted Omni web unload protocol.
 *
 * The shell only knows whether a hosted workbench is really going away after
 * it has seen the veto answer and re-checked that nothing superseded the
 * request, so the handshake is two calls: {@link prepareUnload} answers the
 * question without shutting anything down, and {@link commitUnload} performs
 * the shutdown the shell has by then committed to.
 */
export class HucodeHostedOmniWebUnloadCoordinator {

	private prepared = false;
	private committed = false;

	constructor(
		private readonly lifecycleService: ILifecycleService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Runs the veto-capable half of the handshake. Resolves false when a
	 * shutdown listener vetoed or the attempt failed; either way the
	 * lifecycle service has not shut down and the shell keeps the workbench
	 * alive.
	 *
	 * The shutdown listeners themselves do run, and some are not idempotent:
	 * the web terminal service, for one, latches itself into a shutting-down
	 * state that stops it persisting layout. An abandoned preparation leaves
	 * a usable workbench, not an untouched one.
	 */
	async prepareUnload(): Promise<boolean> {
		if (this.committed) {
			return true; // already shut down, nothing left to veto
		}

		this.prepared = false;
		if (!supportsTwoPhaseShutdown(this.lifecycleService)) {
			this.logService.error(
				'[hucode] hosted workbench unload needs a lifecycle service ' +
				'with two-phase shutdown support'
			);
			return false;
		}

		try {
			if (await this.lifecycleService.prepareShutdown()) {
				return false; // vetoed
			}
		} catch (error) {
			this.logService.error(error);
			return false;
		}

		this.prepared = true;
		return true;
	}

	/**
	 * Runs the irreversible half once the shell has decided the workbench is
	 * going away. Resolves false when no prepared unload is outstanding, so a
	 * commit the workbench never agreed to leaves it running instead of
	 * shutting it down behind an undecided handshake. Failures after a prepared
	 * commit reject so the shell takes its fail-open removal path.
	 */
	async commitUnload(): Promise<boolean> {
		if (this.committed) {
			return true;
		}

		if (!this.prepared) {
			this.logService.error(
				'[hucode] hosted workbench unload commit without a prepared ' +
				'unload'
			);
			return false;
		}

		if (!supportsTwoPhaseShutdown(this.lifecycleService)) {
			this.logService.error(
				'[hucode] hosted workbench unload needs a lifecycle service ' +
				'with two-phase shutdown support'
			);
			return false;
		}

		try {
			await this.lifecycleService.commitShutdown();
		} catch (error) {
			this.logService.error(error);
			throw error;
		}

		this.prepared = false;
		this.committed = true;
		return true;
	}
}
