/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../base/common/lifecycle.js';
import {
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../platform/window/common/hucodeHostedShellService.js';

type HucodeHostedShellStateSource = Pick<
	IHucodeHostedShellService,
	'getState' | 'onDidChangeState'
>;

/**
 * Observes hosted shell state without allowing a late initial snapshot to
 * overwrite an event or outlive the returned subscription.
 */
export function observeHucodeHostedShellState(
	source: HucodeHostedShellStateSource,
	listener: (state: IHucodeHostedShellState) => void
): IDisposable {
	let didReceiveStateChange = false;
	let disposed = false;
	const subscription = source.onDidChangeState(state => {
		didReceiveStateChange = true;
		listener(state);
	});

	void source.getState().then(state => {
		if (!didReceiveStateChange && !disposed) {
			listener(state);
		}
	}, () => {
		// A disposed MessagePort can reject the initial snapshot while the
		// hosting document is already tearing down. State events, if any, remain
		// authoritative and the rejection must not escape as an unhandled promise.
	});

	return {
		dispose: () => {
			disposed = true;
			subscription.dispose();
		},
	};
}
