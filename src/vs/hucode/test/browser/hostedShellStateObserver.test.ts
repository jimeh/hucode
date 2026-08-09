/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IHucodeHostedShellState } from
	'../../../platform/window/common/hucodeHostedShellService.js';
import { observeHucodeHostedShellState } from
	'../../browser/hostedShellStateObserver.js';

suite('HostedShellStateObserver', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function state(projectsSidebarVisible: boolean): IHucodeHostedShellState {
		return {
			available: projectsSidebarVisible,
			projectsSidebarVisible,
			projectSwitcherCanGoBack: projectsSidebarVisible,
			projectSwitcherCanGoForward: projectsSidebarVisible,
			lifecycleState: projectsSidebarVisible ? 'active' : undefined,
			active: projectsSidebarVisible,
			visible: projectsSidebarVisible,
		};
	}

	test('does not emit an initial snapshot after a newer state event',
		async () => {
			const initialState = new DeferredPromise<IHucodeHostedShellState>();
			const stateChanges = disposables.add(
				new Emitter<IHucodeHostedShellState>()
			);
			const observed: IHucodeHostedShellState[] = [];
			disposables.add(observeHucodeHostedShellState({
				getState: () => initialState.p,
				onDidChangeState: stateChanges.event,
			}, value => observed.push(value)));
			const currentState = state(true);

			stateChanges.fire(currentState);
			await initialState.complete(state(false));

			assert.deepStrictEqual(observed, [currentState]);
		});

	test('emits the initial snapshot and subsequent state events', async () => {
		const initialState = new DeferredPromise<IHucodeHostedShellState>();
		const stateChanges = disposables.add(
			new Emitter<IHucodeHostedShellState>()
		);
		const observed: IHucodeHostedShellState[] = [];
		disposables.add(observeHucodeHostedShellState({
			getState: () => initialState.p,
			onDidChangeState: stateChanges.event,
		}, value => observed.push(value)));
		const initial = state(false);
		const current = state(true);

		await initialState.complete(initial);
		stateChanges.fire(current);

		assert.deepStrictEqual(observed, [initial, current]);
	});

	test('ignores a pending initial snapshot after disposal', async () => {
		const initialState = new DeferredPromise<IHucodeHostedShellState>();
		const stateChanges = disposables.add(
			new Emitter<IHucodeHostedShellState>()
		);
		const observed: IHucodeHostedShellState[] = [];
		const observation = disposables.add(observeHucodeHostedShellState({
			getState: () => initialState.p,
			onDidChangeState: stateChanges.event,
		}, value => observed.push(value)));

		observation.dispose();
		await initialState.complete(state(true));
		stateChanges.fire(state(false));

		assert.deepStrictEqual(observed, []);
	});

	test('ignores an initial snapshot rejected during connection teardown',
		async () => {
			const stateChanges = disposables.add(
				new Emitter<IHucodeHostedShellState>()
			);
			const observed: IHucodeHostedShellState[] = [];
			disposables.add(observeHucodeHostedShellState({
				getState: () => Promise.reject(new Error('connection disposed')),
				onDidChangeState: stateChanges.event,
			}, value => observed.push(value)));

			await Promise.resolve();

			assert.deepStrictEqual(observed, []);
		});
});
