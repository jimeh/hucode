/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	GitWorktreeTargetChange,
	IProjectManagerService,
	ProjectCatalogSnapshot,
	ProjectRecord,
} from '../../common/projectManager.js';
import { createProjectManagerChannel } from '../../common/projectManagerChannel.js';

suite('ProjectManagerChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture() {
		const events = {
			onDidChangeProjects: store.add(new Emitter<readonly ProjectRecord[]>()),
			onDidChangeCatalog: store.add(new Emitter<ProjectCatalogSnapshot>()),
			onDidChangeGitWorktreeTargets: store.add(new Emitter<GitWorktreeTargetChange>()),
		};
		const service = upcastPartial<IProjectManagerService>({
			onDidChangeProjects: events.onDidChangeProjects.event,
			onDidChangeCatalog: events.onDidChangeCatalog.event,
			onDidChangeGitWorktreeTargets: events.onDidChangeGitWorktreeTargets.event,
		});
		const channel = createProjectManagerChannel(service, store.add(new DisposableStore()));
		return { events, channel };
	}

	function catalog(revision: number): ProjectCatalogSnapshot {
		return { epoch: 'epoch', revision, projects: [], workbenches: [] };
	}

	test('does not retain catalog snapshots before an IPC listener', () => {
		const { events, channel } = createFixture();
		const received: ProjectCatalogSnapshot[] = [];

		events.onDidChangeCatalog.fire(catalog(1));
		const subscribedBeforeListening = events.onDidChangeCatalog.hasListeners();
		const listener = channel.listen<ProjectCatalogSnapshot>('window', 'onDidChangeCatalog')(e => received.push(e));
		events.onDidChangeCatalog.fire(catalog(2));
		listener.dispose();

		deepStrictEqual({
			subscribedBeforeListening,
			received,
			subscribedAfterListening: events.onDidChangeCatalog.hasListeners(),
		}, {
			subscribedBeforeListening: false,
			received: [catalog(2)],
			subscribedAfterListening: false,
		});
	});
});
