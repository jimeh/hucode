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

	function gitTargets(consumerId: string): GitWorktreeTargetChange {
		return { consumerId, observations: [] };
	}

	test('does not retain events before an IPC listener', () => {
		const { events, channel } = createFixture();
		const received = {
			onDidChangeProjects: [] as (readonly ProjectRecord[])[],
			onDidChangeCatalog: [] as ProjectCatalogSnapshot[],
			onDidChangeGitWorktreeTargets: [] as GitWorktreeTargetChange[],
		};
		const subscribedEvents = () => Object.entries(events).filter(([, emitter]) => emitter.hasListeners()).map(([name]) => name);
		const liveProjects: readonly ProjectRecord[] = [];

		events.onDidChangeProjects.fire([]);
		events.onDidChangeCatalog.fire(catalog(1));
		events.onDidChangeGitWorktreeTargets.fire(gitTargets('early'));
		const subscribedBeforeListening = subscribedEvents();
		const listeners = new DisposableStore();
		listeners.add(channel.listen<readonly ProjectRecord[]>('window', 'onDidChangeProjects')(e => received.onDidChangeProjects.push(e)));
		listeners.add(channel.listen<ProjectCatalogSnapshot>('window', 'onDidChangeCatalog')(e => received.onDidChangeCatalog.push(e)));
		listeners.add(channel.listen<GitWorktreeTargetChange>('window', 'onDidChangeGitWorktreeTargets')(e => received.onDidChangeGitWorktreeTargets.push(e)));
		events.onDidChangeProjects.fire(liveProjects);
		events.onDidChangeCatalog.fire(catalog(2));
		events.onDidChangeGitWorktreeTargets.fire(gitTargets('live'));
		listeners.dispose();

		deepStrictEqual({
			subscribedBeforeListening,
			received,
			subscribedAfterListening: subscribedEvents(),
		}, {
			subscribedBeforeListening: [],
			received: {
				onDidChangeProjects: [liveProjects],
				onDidChangeCatalog: [catalog(2)],
				onDidChangeGitWorktreeTargets: [gitTargets('live')],
			},
			subscribedAfterListening: [],
		});
	});
});
