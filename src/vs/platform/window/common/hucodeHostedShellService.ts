/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import {
	IChannel,
	IServerChannel,
	ProxyChannel,
} from '../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { HucodeHostedShellAction, isHucodeHostedShellAction } from
	'./hucodeHostedShellActions.js';
import { IRectangle } from './window.js';

/** MessagePort channel exposing the narrow hosted-to-shell capability. */
export const HUCODE_HOSTED_SHELL_CHANNEL = 'hucodeHostedShell';

/** Desktop IPC request used only to acquire a bound hosted capability port. */
export const HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL =
	'vscode:hucodeHostedShellPort';

/** Desktop IPC response carrying the bound hosted capability port. */
export const HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL =
	'vscode:hucodeHostedShellPortResult';

/** Current version of the hosted shell capability contract. */
export const HUCODE_HOSTED_SHELL_PROTOCOL_VERSION = 1;

/** Required operation groups in version 1 of the hosted shell capability. */
export const HUCODE_HOSTED_SHELL_CORE_CAPABILITIES = Object.freeze([
	'state',
	'ready',
	'selfLifecycle',
	'focus',
	'shellActions',
	'navigation',
	'paste',
	'screenshot',
] as const);

/** Optional operation groups understood by the current version 1 peers. */
export const HUCODE_HOSTED_SHELL_OPTIONAL_CAPABILITIES = Object.freeze([
	'navigationSnapshot',
] as const);

/** Complete capability offer made by current hosted workbenches. */
export const HUCODE_HOSTED_SHELL_CAPABILITIES = Object.freeze([
	...HUCODE_HOSTED_SHELL_CORE_CAPABILITIES,
	...HUCODE_HOSTED_SHELL_OPTIONAL_CAPABILITIES,
] as const);

/** One operation group named by the hosted shell capability handshake. */
export type HucodeHostedShellCapability =
	typeof HUCODE_HOSTED_SHELL_CAPABILITIES[number];

const hucodeHostedShellCachedAvailability = Symbol(
	'hucodeHostedShellCachedAvailability'
);

/** Local-only synchronous availability metadata, never exposed over IPC. */
export type HucodeHostedShellCachedAvailability = {
	readonly [hucodeHostedShellCachedAvailability]?: () => boolean;
};

/** Reads transport availability without awaiting a pending connection. */
export function isHucodeHostedShellServiceAvailable(
	service: IHucodeHostedShellService
): boolean {
	return (service as IHucodeHostedShellService &
		HucodeHostedShellCachedAvailability
	)[hucodeHostedShellCachedAvailability]?.() ?? true;
}

/** Attaches local availability metadata without widening the remote surface. */
export function withHucodeHostedShellCachedAvailability<
	T extends IHucodeHostedShellService
>(service: T, available: () => boolean): T {
	Object.defineProperty(service, hucodeHostedShellCachedAvailability, {
		value: available,
	});
	return service;
}

/** Exact remotely exposed surface of {@link IHucodeHostedShellService}. */
export const HUCODE_HOSTED_SHELL_REMOTE_MEMBERS = Object.freeze([
	'onDidChangeState',
	'getState',
	'getNavigationSnapshot',
	'notifyReady',
	'closeSelf',
	'reopenSelfInNormalWindow',
	'reloadSelf',
	'focusSelf',
	'focusShell',
	'requestShellAction',
	'navigateToFolder',
	'triggerPasteInSelf',
	'captureSelfScreenshot',
] as const satisfies readonly (keyof IHucodeHostedShellService)[]);

type MissingHostedShellRemoteMember = Exclude<
	keyof IHucodeHostedShellService,
	typeof HUCODE_HOSTED_SHELL_REMOTE_MEMBERS[number] | '_serviceBrand'
>;
const hostedShellRemoteMembersAreExhaustive:
	MissingHostedShellRemoteMember extends never ? true : never = true;
void hostedShellRemoteMembersAreExhaustive;

const hucodeHostedShellRemoteMemberSet = new Set<string>(
	HUCODE_HOSTED_SHELL_REMOTE_MEMBERS
);

/** Creates a server channel that rejects inherited or undeclared members. */
export function createHucodeHostedShellServerChannel(
	service: IHucodeHostedShellService,
	disposables: DisposableStore,
	capabilities: readonly HucodeHostedShellCapability[] =
		HUCODE_HOSTED_SHELL_CAPABILITIES
): IServerChannel {
	const channel = ProxyChannel.fromService(service, disposables);
	const navigationSnapshotEnabled = capabilities.includes(
		'navigationSnapshot'
	);
	return {
		listen(context, event, arg) {
			if (event !== 'onDidChangeState') {
				throw new Error(`Event not found: ${event}`);
			}
			return channel.listen(context, event, arg);
		},
		call(context, command, args) {
			if (command === 'onDidChangeState' ||
				(command === 'getNavigationSnapshot' &&
					!navigationSnapshotEnabled) ||
				!hucodeHostedShellRemoteMemberSet.has(command)) {
				return Promise.reject(new Error(`Method not found: ${command}`));
			}
			return channel.call(context, command, args);
		},
	};
}

/** Observable outcomes shared by hosted shell operations. */
export const HucodeHostedShellOperationOutcome = {
	Accepted: 'accepted',
	Rejected: 'rejected',
	Stale: 'stale',
	Unavailable: 'unavailable',
	Unsupported: 'unsupported',
	Superseded: 'superseded',
} as const;

export type HucodeHostedShellOperationOutcome =
	typeof HucodeHostedShellOperationOutcome[
	keyof typeof HucodeHostedShellOperationOutcome
	];

/** Lifecycle states observable by the workbench that owns the instance. */
export type HucodeHostedSelfLifecycleState =
	| 'restore-pending'
	| 'loading'
	| 'active'
	| 'loaded'
	| 'dormant'
	| 'unloaded'
	| 'missing'
	| 'crashed';

/** Minimal shell state projected to one hosted workbench. */
export interface IHucodeHostedShellState {
	readonly available: boolean;
	readonly projectsSidebarVisible: boolean;
	readonly projectSwitcherCanGoBack: boolean;
	readonly projectSwitcherCanGoForward: boolean;
	readonly lifecycleState?: HucodeHostedSelfLifecycleState;
	readonly active: boolean;
	readonly visible: boolean;
}

/** Canonical state for an unavailable or disconnected hosted capability. */
export const HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE:
	IHucodeHostedShellState = Object.freeze({
		available: false,
		projectsSidebarVisible: false,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		active: false,
		visible: false,
	});

/** Self-scoped result of a hosted workbench readiness notification. */
export interface IHucodeHostedReadyResult {
	readonly outcome: HucodeHostedShellOperationOutcome;
	readonly state?: IHucodeHostedShellState;
}

/** Folder navigation requested by the currently bound hosted workbench. */
export interface IHucodeHostedNavigationRequest {
	readonly folderUri: UriComponents;
}

/** Sanitized visual section containing one hosted navigation target. */
export type HucodeHostedNavigationSection = 'workbenches' | 'projects';

/** Read-only sibling target exposed without controller identity. */
export interface IHucodeHostedNavigationTarget {
	readonly folderUri: UriComponents;
	readonly lifecycleState: Exclude<
		HucodeHostedSelfLifecycleState,
		'restore-pending'
	>;
	readonly lastActiveAt?: number;
	readonly section: HucodeHostedNavigationSection;
	readonly order: number;
	readonly label?: string;
	readonly pathLabel?: string;
}

/** Sanitized worktree metadata needed to render hosted switcher choices. */
export interface IHucodeHostedNavigationWorktree {
	readonly folderUri: UriComponents;
	readonly label: string;
	readonly customLabel?: string;
	readonly branch?: string;
	readonly isMain: boolean;
	readonly isDetached: boolean;
	readonly pinned?: boolean;
	readonly lastVisitedAt?: number;
}

/** Sanitized project metadata without controller or persisted identity. */
export interface IHucodeHostedNavigationProject {
	readonly rootUri: UriComponents;
	readonly label: string;
	readonly pinned: boolean;
	readonly order: number;
	readonly worktrees: readonly IHucodeHostedNavigationWorktree[];
}

/** On-demand read model used by hosted workbench-switching commands. */
export interface IHucodeHostedNavigationSnapshot {
	readonly targets: readonly IHucodeHostedNavigationTarget[];
	readonly sectionOrder: readonly HucodeHostedNavigationSection[];
	readonly projects?: readonly IHucodeHostedNavigationProject[];
}

/** Authoritative identity captured when a hosted connection is created. */
export interface IHucodeHostedShellBinding {
	readonly windowId: number;
	readonly instanceId: string;
	readonly connectionGeneration: number;
}

/** Authority-side instance data used only while projecting bound state. */
export interface IHucodeHostedShellAuthorityInstanceState {
	readonly instanceId: string;
	readonly state: HucodeHostedSelfLifecycleState;
	readonly visible: boolean;
}

/** Authority-side snapshot consumed by the shared bound policy. */
export interface IHucodeHostedShellAuthorityState {
	readonly connectionGeneration: number;
	readonly disposed: boolean;
	readonly projectsSidebarVisible: boolean;
	readonly projectSwitcherCanGoBack: boolean;
	readonly projectSwitcherCanGoForward: boolean;
	readonly activeInstanceId?: string;
	readonly instances: readonly IHucodeHostedShellAuthorityInstanceState[];
	readonly navigationSnapshot?: IHucodeHostedNavigationSnapshot;
}

/**
 * Platform delegate invoked only with the facade's captured binding.
 * Side-effecting implementations must re-check that binding at their commit
 * point because the facade's asynchronous policy preflight is not atomic.
 */
export interface IHucodeHostedShellDelegate {
	readonly onDidChangeState: Event<IHucodeHostedShellAuthorityState>;
	getState(
		binding: IHucodeHostedShellBinding
	): Promise<IHucodeHostedShellAuthorityState>;
	getNavigationSnapshot?(
		binding: IHucodeHostedShellBinding
	): Promise<IHucodeHostedNavigationSnapshot | undefined>;
	notifyReady(binding: IHucodeHostedShellBinding): Promise<void>;
	closeSelf(binding: IHucodeHostedShellBinding): Promise<boolean>;
	reopenSelfInNormalWindow(
		binding: IHucodeHostedShellBinding
	): Promise<boolean>;
	reloadSelf(binding: IHucodeHostedShellBinding): Promise<boolean>;
	focusSelf(binding: IHucodeHostedShellBinding): Promise<boolean>;
	focusShell(binding: IHucodeHostedShellBinding): Promise<boolean>;
	requestShellAction(
		binding: IHucodeHostedShellBinding,
		action: HucodeHostedShellAction
	): Promise<boolean>;
	navigateToFolder(
		binding: IHucodeHostedShellBinding,
		request: IHucodeHostedNavigationRequest,
		authorization: IHucodeHostedShellContinuationAuthorization
	): Promise<HucodeHostedShellOperationOutcome>;
	triggerPasteInSelf(binding: IHucodeHostedShellBinding): Promise<boolean>;
	captureSelfScreenshot(
		binding: IHucodeHostedShellBinding,
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
}

/** Re-check used after every asynchronous navigation preflight. */
export interface IHucodeHostedShellContinuationAuthorization {
	isCurrentAndActiveVisible(): Promise<boolean>;
}

export const IHucodeHostedShellService =
	createDecorator<IHucodeHostedShellService>('hucodeHostedShellService');

/** Least-authority shell capability available to a hosted workbench. */
export interface IHucodeHostedShellService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IHucodeHostedShellState>;
	getState(): Promise<IHucodeHostedShellState>;
	getNavigationSnapshot?(): Promise<
		IHucodeHostedNavigationSnapshot | undefined
	>;
	notifyReady(): Promise<IHucodeHostedReadyResult>;
	closeSelf(): Promise<HucodeHostedShellOperationOutcome>;
	reopenSelfInNormalWindow(): Promise<HucodeHostedShellOperationOutcome>;
	reloadSelf(): Promise<HucodeHostedShellOperationOutcome>;
	focusSelf(): Promise<HucodeHostedShellOperationOutcome>;
	focusShell(): Promise<HucodeHostedShellOperationOutcome>;
	requestShellAction(
		action: HucodeHostedShellAction
	): Promise<HucodeHostedShellOperationOutcome>;
	navigateToFolder(
		request: IHucodeHostedNavigationRequest
	): Promise<HucodeHostedShellOperationOutcome>;
	triggerPasteInSelf(): Promise<HucodeHostedShellOperationOutcome>;
	captureSelfScreenshot(
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
}

/**
 * Negotiates the atomic version 1 capability independently from unload
 * versioning. Every required group must be offered; unknown future groups are
 * ignored so a newer peer can remain backward compatible.
 */
export function negotiateHucodeHostedShellCapabilities(
	protocolVersion: unknown,
	capabilities: unknown
): readonly HucodeHostedShellCapability[] | undefined {
	if (
		protocolVersion !== HUCODE_HOSTED_SHELL_PROTOCOL_VERSION ||
		!Array.isArray(capabilities)
	) {
		return undefined;
	}

	const offered = new Set(capabilities.filter(
		(value): value is string => typeof value === 'string'
	));
	if (!HUCODE_HOSTED_SHELL_CORE_CAPABILITIES.every(capability =>
		offered.has(capability))
	) {
		return undefined;
	}
	return HUCODE_HOSTED_SHELL_CAPABILITIES.filter(capability =>
		offered.has(capability)
	);
}

/** Creates the sole policy facade for one authoritatively bound connection. */
export function createBoundHucodeHostedShellFacade(
	binding: IHucodeHostedShellBinding,
	delegate: IHucodeHostedShellDelegate
): IHucodeHostedShellService {
	const project = (state: IHucodeHostedShellAuthorityState) =>
		projectHostedShellState(binding, state);
	const onDidChangeState = Event.latch(
		Event.map(
			Event.filter(delegate.onDidChangeState, state =>
				isCurrentBinding(binding, state)),
			project
		),
		areHucodeHostedShellStatesEqual
	);
	const getAuthorityState = () => delegate.getState(binding);
	const runCurrent = async (
		run: () => Promise<boolean>,
		requireActiveVisible = false
	): Promise<HucodeHostedShellOperationOutcome> => {
		const state = await getAuthorityState();
		if (!isCurrentBinding(binding, state)) {
			return HucodeHostedShellOperationOutcome.Stale;
		}
		const self = getBoundSelf(binding, state);
		if (!self) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		if (requireActiveVisible && !isActiveAndVisible(binding, state)) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}
		return await run()
			? HucodeHostedShellOperationOutcome.Accepted
			: HucodeHostedShellOperationOutcome.Unavailable;
	};

	return {
		_serviceBrand: undefined,
		onDidChangeState,
		async getState() {
			const state = await getAuthorityState();
			return isCurrentBinding(binding, state) && getBoundSelf(binding, state)
				? project(state)
				: HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
		},
		async getNavigationSnapshot() {
			const state = await getAuthorityState();
			if (!isCurrentBinding(binding, state) || !getBoundSelf(binding, state)) {
				return undefined;
			}
			const snapshot = delegate.getNavigationSnapshot
				? await delegate.getNavigationSnapshot(binding)
				: state.navigationSnapshot;
			const current = await getAuthorityState();
			return isCurrentBinding(binding, current) && getBoundSelf(binding, current)
				? snapshot
				: undefined;
		},
		async notifyReady() {
			const state = await getAuthorityState();
			if (!isCurrentBinding(binding, state)) {
				return { outcome: HucodeHostedShellOperationOutcome.Stale };
			}
			if (!getBoundSelf(binding, state)) {
				return { outcome: HucodeHostedShellOperationOutcome.Unavailable };
			}
			await delegate.notifyReady(binding);
			const current = await getAuthorityState();
			if (!isCurrentBinding(binding, current)) {
				return { outcome: HucodeHostedShellOperationOutcome.Stale };
			}
			if (!getBoundSelf(binding, current)) {
				return { outcome: HucodeHostedShellOperationOutcome.Unavailable };
			}
			return {
				outcome: HucodeHostedShellOperationOutcome.Accepted,
				state: project(current),
			};
		},
		closeSelf: () => runCurrent(() => delegate.closeSelf(binding)),
		reopenSelfInNormalWindow: () => runCurrent(
			() => delegate.reopenSelfInNormalWindow(binding)
		),
		reloadSelf: () => runCurrent(() => delegate.reloadSelf(binding)),
		focusSelf: () => runCurrent(() => delegate.focusSelf(binding)),
		focusShell: () => runCurrent(
			() => delegate.focusShell(binding),
			true
		),
		requestShellAction: action => {
			if (!isHucodeHostedShellAction(action)) {
				return Promise.resolve(HucodeHostedShellOperationOutcome.Unsupported);
			}
			return runCurrent(
				() => delegate.requestShellAction(binding, action),
				true
			);
		},
		async navigateToFolder(request) {
			const state = await getAuthorityState();
			if (!isCurrentBinding(binding, state)) {
				return HucodeHostedShellOperationOutcome.Stale;
			}
			if (!isSupportedHucodeHostedNavigationRequest(request)) {
				return HucodeHostedShellOperationOutcome.Unsupported;
			}
			if (!isActiveAndVisible(binding, state)) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			return delegate.navigateToFolder(binding, request, {
				async isCurrentAndActiveVisible() {
					const current = await getAuthorityState();
					return isCurrentBinding(binding, current) &&
						isActiveAndVisible(binding, current);
				},
			});
		},
		triggerPasteInSelf: () => runCurrent(
			() => delegate.triggerPasteInSelf(binding),
			true
		),
		async captureSelfScreenshot(rect, quality) {
			const state = await getAuthorityState();
			if (
				!isCurrentBinding(binding, state) ||
				!isActiveAndVisible(binding, state)
			) {
				return undefined;
			}
			return delegate.captureSelfScreenshot(binding, rect, quality);
		},
	};
}

/** Creates a typed client whose methods exactly mirror the hosted facade. */
export function createHucodeHostedShellClient(
	channel: IChannel,
	capabilities: readonly HucodeHostedShellCapability[] =
		HUCODE_HOSTED_SHELL_CAPABILITIES
): IHucodeHostedShellService {
	const remote = ProxyChannel.toService<IHucodeHostedShellService>(channel);
	return {
		_serviceBrand: undefined,
		onDidChangeState: remote.onDidChangeState,
		getState: () => remote.getState(),
		getNavigationSnapshot: capabilities.includes('navigationSnapshot')
			? () => remote.getNavigationSnapshot!()
			: async () => undefined,
		notifyReady: () => remote.notifyReady(),
		closeSelf: () => remote.closeSelf(),
		reopenSelfInNormalWindow: () => remote.reopenSelfInNormalWindow(),
		reloadSelf: () => remote.reloadSelf(),
		focusSelf: () => remote.focusSelf(),
		focusShell: () => remote.focusShell(),
		requestShellAction: action => remote.requestShellAction(action),
		navigateToFolder: request => remote.navigateToFolder(request),
		triggerPasteInSelf: () => remote.triggerPasteInSelf(),
		captureSelfScreenshot: (rect, quality) =>
			remote.captureSelfScreenshot(rect, quality),
	};
}

function projectHostedShellState(
	binding: IHucodeHostedShellBinding,
	state: IHucodeHostedShellAuthorityState
): IHucodeHostedShellState {
	const self = getBoundSelf(binding, state);
	if (!self) {
		return HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	}
	return {
		available: true,
		projectsSidebarVisible: state.projectsSidebarVisible,
		projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
		projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
		lifecycleState: self.state,
		active: state.activeInstanceId === binding.instanceId,
		visible: self.visible,
	};
}

/** Equality used to suppress state events caused only by sibling changes. */
export function areHucodeHostedShellStatesEqual(
	a: IHucodeHostedShellState,
	b: IHucodeHostedShellState
): boolean {
	return a.available === b.available &&
		a.projectsSidebarVisible === b.projectsSidebarVisible &&
		a.projectSwitcherCanGoBack === b.projectSwitcherCanGoBack &&
		a.projectSwitcherCanGoForward === b.projectSwitcherCanGoForward &&
		a.lifecycleState === b.lifecycleState &&
		a.active === b.active &&
		a.visible === b.visible;
}

function getBoundSelf(
	binding: IHucodeHostedShellBinding,
	state: IHucodeHostedShellAuthorityState
) {
	return state.instances.find(instance =>
		instance.instanceId === binding.instanceId);
}

function isCurrentBinding(
	binding: IHucodeHostedShellBinding,
	state: IHucodeHostedShellAuthorityState
): boolean {
	return !state.disposed &&
		state.connectionGeneration === binding.connectionGeneration;
}

function isActiveAndVisible(
	binding: IHucodeHostedShellBinding,
	state: IHucodeHostedShellAuthorityState
): boolean {
	return state.activeInstanceId === binding.instanceId &&
		getBoundSelf(binding, state)?.visible === true;
}

/** Validates the exact navigation schemes exposed by the hosted capability. */
export function isSupportedHucodeHostedNavigationRequest(
	value: unknown
): value is IHucodeHostedNavigationRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	try {
		const resource = URI.revive(
			(value as { readonly folderUri?: UriComponents }).folderUri
		);
		return !!resource && (
			resource.scheme === Schemas.file ||
			resource.scheme === Schemas.vscodeRemote
		);
	} catch {
		return false;
	}
}
