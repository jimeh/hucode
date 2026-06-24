/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOmniWorkspaceRestoreEntry } from
	'../../platform/window/common/window.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from './omniWindow.js';

export interface IHostedWorkspaceStateEntry {
	readonly instanceId: string;
	readonly projectId?: string;
	readonly worktreePath: string;
	readonly state: HucodeHostedWorkbenchLifecycleState;
	readonly visible: boolean;
	readonly focused: boolean;
	readonly lastActiveAt?: number;
}

export function createHostedWorkspaceState<T extends IHostedWorkspaceStateEntry>(
	entries: Iterable<T>,
	activeInstanceId: string | undefined,
	projectsSidebarVisible: boolean,
	projectSwitcherCanGoBack: boolean,
	projectSwitcherCanGoForward: boolean,
	toExternalInstance: (entry: T) => IHucodeHostedWorkbenchInstance =
		defaultExternalInstance
): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible,
		projectSwitcherCanGoBack,
		projectSwitcherCanGoForward,
		instances: sortHostedWorkspaceEntries(
			Array.from(entries).map(toExternalInstance),
			activeInstanceId
		),
	};
}

export function hasLoadedHostedWorkspace<T extends IHostedWorkspaceStateEntry>(
	entries: Iterable<T>,
	isDisposed: (entry: T) => boolean = () => false
): boolean {
	return Array.from(entries).some(entry =>
		!isDisposed(entry) &&
		entry.state !== 'crashed' &&
		entry.state !== 'unloaded'
	);
}

export function getReadyHostedWorkspaceState(
	entry: IHostedWorkspaceStateEntry,
	activeInstanceId: string | undefined
): HucodeHostedWorkbenchLifecycleState {
	return entry.instanceId === activeInstanceId ? 'active' : 'loaded';
}

export function isHostedWorkspacePendingReady(
	entry: IHostedWorkspaceStateEntry
): boolean {
	return entry.state === 'restore-pending' || entry.state === 'loading';
}

export function getMostRecentHostedWorkspace<
	T extends IHostedWorkspaceStateEntry
>(
	entries: Iterable<T>,
	excludeInstanceId?: string,
	isUnavailable: (entry: T) => boolean = () => false
): T | undefined {
	return Array.from(entries)
		.filter(entry =>
			entry.instanceId !== excludeInstanceId &&
			!isUnavailable(entry) &&
			entry.state !== 'crashed' &&
			entry.state !== 'unloaded'
		)
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
}

export function getRestoreActiveWorktreePath(
	entries: readonly IOmniWorkspaceRestoreEntry[],
	configuredActiveWorktreePath: string | undefined
): string | undefined {
	const mostRecentWorktreePath = [...entries]
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
		?.worktreePath;
	const hasConfiguredActiveWorktreePath =
		!!configuredActiveWorktreePath &&
		entries.some(entry =>
			entry.worktreePath === configuredActiveWorktreePath
		);

	return (
		hasConfiguredActiveWorktreePath
			? configuredActiveWorktreePath
			: undefined) ??
		entries.find(entry => entry.state === 'active')?.worktreePath ??
		mostRecentWorktreePath;
}

export function sortRestoreEntries(
	entries: readonly IOmniWorkspaceRestoreEntry[],
	activeWorktreePath: string | undefined
): IOmniWorkspaceRestoreEntry[] {
	return [...entries].sort((a, b) => {
		if (a.worktreePath === activeWorktreePath) {
			return -1;
		}

		if (b.worktreePath === activeWorktreePath) {
			return 1;
		}

		return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
	});
}

export function createHostedWorkspaceRestoreEntries<
	T extends IHostedWorkspaceStateEntry
>(
	entries: Iterable<T>,
	activeInstanceId: string | undefined
): IOmniWorkspaceRestoreEntry[] {
	return Array.from(entries)
		.filter(entry =>
			entry.state !== 'crashed' && entry.state !== 'unloaded'
		)
		.map(entry => {
			const state: IOmniWorkspaceRestoreEntry['state'] =
				entry.instanceId === activeInstanceId ? 'active' : 'loaded';

			return {
				...(entry.projectId ? { projectId: entry.projectId } : {}),
				worktreePath: entry.worktreePath,
				lastActiveAt: entry.lastActiveAt,
				state,
			};
		})
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
}

export function defaultExternalInstance(
	entry: IHostedWorkspaceStateEntry
): IHucodeHostedWorkbenchInstance {
	return {
		instanceId: entry.instanceId,
		projectId: entry.projectId,
		worktreePath: entry.worktreePath,
		state: entry.state,
		visible: entry.visible,
		focused: entry.focused,
		lastActiveAt: entry.lastActiveAt,
	};
}

function sortHostedWorkspaceEntries(
	entries: IHucodeHostedWorkbenchInstance[],
	activeInstanceId: string | undefined
): IHucodeHostedWorkbenchInstance[] {
	return entries.sort((a, b) => {
		if (a.instanceId === activeInstanceId) {
			return -1;
		}

		if (b.instanceId === activeInstanceId) {
			return 1;
		}

		return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
	});
}
