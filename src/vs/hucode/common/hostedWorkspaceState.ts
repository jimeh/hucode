/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { IDisposable } from '../../base/common/lifecycle.js';
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
	state: HucodeHostedWorkbenchLifecycleState;
	readonly visible: boolean;
	readonly focused: boolean;
	lastActiveAt?: number;
}

/**
 * Shared mutable state for hosted workspace controllers.
 */
export class HostedWorkspaceStateModel<T extends IHostedWorkspaceStateEntry> {
	readonly instancesById = new Map<string, T>();
	readonly instanceIdsByPath = new Map<string, string>();

	activeInstanceId: string | undefined;
	projectsSidebarVisible = true;
	projectSwitcherCanGoBack = false;
	projectSwitcherCanGoForward = false;

	constructor(
		private readonly toPathKey: (path: string) => string = path => path,
		private readonly now: () => number = () => Date.now()
	) { }

	/**
	 * Adds a hosted workspace to the indexed state.
	 */
	addInstance(instance: T): void {
		const pathKey = this.toPathKey(instance.worktreePath);
		const existingInstanceId = this.instanceIdsByPath.get(pathKey);
		if (
			existingInstanceId &&
			existingInstanceId !== instance.instanceId
		) {
			this.instancesById.delete(existingInstanceId);
			if (this.activeInstanceId === existingInstanceId) {
				this.activeInstanceId = undefined;
			}
		}

		this.instancesById.set(instance.instanceId, instance);
		this.instanceIdsByPath.set(pathKey, instance.instanceId);
	}

	/**
	 * Removes a hosted workspace from the indexed state.
	 */
	removeInstance(instance: T): void {
		this.instancesById.delete(instance.instanceId);
		const pathKey = this.toPathKey(instance.worktreePath);
		if (this.instanceIdsByPath.get(pathKey) === instance.instanceId) {
			this.instanceIdsByPath.delete(pathKey);
		}
		if (this.activeInstanceId === instance.instanceId) {
			this.activeInstanceId = undefined;
		}
	}

	/**
	 * Returns a hosted workspace by its filesystem path.
	 */
	getInstanceByPath(worktreePath: string): T | undefined {
		const instanceId = this.instanceIdsByPath.get(this.toPathKey(worktreePath));
		return instanceId ? this.instancesById.get(instanceId) : undefined;
	}

	/**
	 * Marks a hosted workspace as active and updates its recency.
	 */
	activateInstance(instance: T): void {
		const previousActiveInstance = this.activeInstanceId
			? this.instancesById.get(this.activeInstanceId)
			: undefined;
		this.activeInstanceId = instance.instanceId;
		instance.lastActiveAt = this.now();
		if (
			isHostedWorkspaceAvailable(instance) &&
			!isHostedWorkspacePendingReady(instance)
		) {
			instance.state = 'active';
		}
		if (
			previousActiveInstance &&
			previousActiveInstance.instanceId !== instance.instanceId &&
			isHostedWorkspaceAvailable(previousActiveInstance) &&
			!isHostedWorkspacePendingReady(previousActiveInstance)
		) {
			previousActiveInstance.state = 'loaded';
		}
	}

	/**
	 * Applies the shared hosted-workbench ready transition.
	 */
	markInstanceReady(instance: T): void {
		instance.state = getReadyHostedWorkspaceState(
			instance,
			this.activeInstanceId
		);
	}

	/**
	 * Stores project-switcher navigation state.
	 */
	setProjectSwitcherNavigationState(
		canGoBack: boolean,
		canGoForward: boolean
	): boolean {
		if (
			this.projectSwitcherCanGoBack === canGoBack &&
			this.projectSwitcherCanGoForward === canGoForward
		) {
			return false;
		}

		this.projectSwitcherCanGoBack = canGoBack;
		this.projectSwitcherCanGoForward = canGoForward;
		return true;
	}

	/**
	 * Stores project-sidebar visibility while preserving the no-workbench guard.
	 */
	setProjectsSidebarVisible(
		visible: boolean,
		hasLoadedWorkbench: boolean
	): boolean {
		const nextVisible = !visible && !hasLoadedWorkbench ? true : visible;
		if (this.projectsSidebarVisible === nextVisible) {
			return false;
		}

		this.projectsSidebarVisible = nextVisible;
		return true;
	}

	/**
	 * Builds the public hosted-workspace state.
	 */
	toState(
		toExternalInstance?: (entry: T) => IHucodeHostedWorkbenchInstance
	): IHucodeHostedWorkspaceState {
		return createHostedWorkspaceState(
			this.instancesById.values(),
			this.activeInstanceId,
			this.projectsSidebarVisible,
			this.projectSwitcherCanGoBack,
			this.projectSwitcherCanGoForward,
			toExternalInstance
		);
	}
}

/**
 * Creates the hosted-workspace state used before any workspace exists.
 */
export function createEmptyHostedWorkspaceState(): IHucodeHostedWorkspaceState {
	return {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}

/**
 * Builds the external hosted-workspace state with the active instance first.
 */
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

/**
 * Returns whether any entry represents a non-terminal hosted workbench.
 */
export function hasLoadedHostedWorkspace<T extends IHostedWorkspaceStateEntry>(
	entries: Iterable<T>,
	isDisposed: (entry: T) => boolean = () => false
): boolean {
	return Array.from(entries).some(entry =>
		!isDisposed(entry) &&
		isHostedWorkspaceAvailable(entry)
	);
}

/**
 * Converts a ready hosted workbench to active or loaded state.
 */
export function getReadyHostedWorkspaceState(
	entry: IHostedWorkspaceStateEntry,
	activeInstanceId: string | undefined
): HucodeHostedWorkbenchLifecycleState {
	return entry.instanceId === activeInstanceId ? 'active' : 'loaded';
}

/**
 * Returns whether an entry is still waiting for hosted workbench readiness.
 */
export function isHostedWorkspacePendingReady(
	entry: IHostedWorkspaceStateEntry
): boolean {
	return entry.state === 'restore-pending' || entry.state === 'loading';
}

/**
 * Returns whether a hosted workbench can still receive work.
 */
export function isHostedWorkspaceAvailable(
	entry: IHostedWorkspaceStateEntry
): boolean {
	return entry.state !== 'crashed' && entry.state !== 'unloaded';
}

/**
 * Waits until a hosted workspace leaves its pending-ready state.
 */
export function waitForHostedWorkspaceReady(
	entry: IHostedWorkspaceStateEntry,
	onDidChangeState: Event<unknown>,
	timeoutMs: number,
	isUnavailable: (entry: IHostedWorkspaceStateEntry) => boolean = () => false
): Promise<boolean> {
	if (!isHostedWorkspacePendingReady(entry)) {
		return Promise.resolve(
			isHostedWorkspaceAvailable(entry) && !isUnavailable(entry)
		);
	}

	return new Promise<boolean>(resolve => {
		let complete = false;
		const cleanup: {
			listener?: IDisposable;
			handle?: ReturnType<typeof setTimeout>;
		} = {};
		const finish = (ready: boolean): void => {
			if (complete) {
				return;
			}

			complete = true;
			cleanup.listener?.dispose();
			if (cleanup.handle !== undefined) {
				clearTimeout(cleanup.handle);
			}
			resolve(ready);
		};

		cleanup.listener = onDidChangeState(() => {
			if (isHostedWorkspacePendingReady(entry)) {
				return;
			}

			finish(isHostedWorkspaceAvailable(entry) && !isUnavailable(entry));
		});
		if (complete) {
			cleanup.listener.dispose();
			return;
		}

		cleanup.handle = setTimeout(() => finish(false), timeoutMs);
	});
}

/**
 * Selects the most recently active available hosted workbench.
 */
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

/**
 * Selects the restore target, preferring a still-present configured worktree.
 */
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

/**
 * Sorts restore entries with the selected active worktree first.
 */
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

/**
 * Creates persisted restore entries for live hosted workbenches.
 */
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

/**
 * Converts an internal hosted-workspace entry to the public instance shape.
 */
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
