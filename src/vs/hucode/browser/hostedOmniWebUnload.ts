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
 * Version 1 shells call {@link prepareUnload}, which completes the whole
 * shutdown before it answers. Version 2 shells call
 * {@link prepareUnloadForCommit}, re-check that the request still owns the
 * workbench, and then call {@link commitUnload}.
 */
export class HucodeHostedOmniWebUnloadCoordinator {

	private prepared = false;
	private committed = false;

	constructor(
		private readonly lifecycleService: ILifecycleService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Preserves the version 1 single-phase contract for an older shell driving
	 * this workbench. A true answer means shutdown has reached the irreversible
	 * commit, even if that commit failed before it could confirm completion.
	 */
	async prepareUnload(): Promise<boolean> {
		if (!await this.prepareUnloadForCommit()) {
			return false;
		}

		try {
			return await this.commitUnload();
		} catch {
			// The old shell has no separate fail-open commit phase. Once commit
			// starts, keeping the iframe could retain a workbench that already
			// shut down, so report the request as removal-ready.
			return true;
		}
	}

	/**
	 * Runs the veto-capable half of the version 2 handshake. Resolves false when a
	 * shutdown listener vetoed or the attempt failed; either way the
	 * lifecycle service has not shut down and the shell keeps the workbench
	 * alive.
	 *
	 * The shutdown listeners themselves do run, and not all are idempotent or
	 * conditional on the shutdown actually happening. An abandoned preparation
	 * leaves a usable workbench, not necessarily an untouched one.
	 */
	async prepareUnloadForCommit(): Promise<boolean> {
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
