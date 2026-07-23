/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IReference, ImmortalReference } from '../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import type {
	AuthenticateParams,
	AuthenticateResult,
	IAgentCreateSessionConfig,
	IAgentHostNetworkDiagnosticsInfo,
	IAgentHostNetworkFetchResult,
	IAgentHostInspectInfo,
	IAgentHostService,
	IAgentHostSocketInfo,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentSessionMetadata,
	IMcpNotification
} from '../../../platform/agentHost/common/agentService.js';
import type { IRemoteWatchHandle } from '../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import type { IActiveSubscriptionInfo, IAgentSubscription } from '../../../platform/agentHost/common/state/agentSubscription.js';
import type {
	CreateResourceWatchParams,
	CreateResourceWatchResult,
	ResourceCopyParams,
	ResourceCopyResult,
	ResourceDeleteParams,
	ResourceDeleteResult,
	ResourceListResult,
	ResourceMkdirParams,
	ResourceMkdirResult,
	ResourceMoveParams,
	ResourceMoveResult,
	ResourceReadResult,
	ResourceResolveParams,
	ResourceResolveResult,
	ResourceWriteParams,
	ResourceWriteResult
} from '../../../platform/agentHost/common/state/sessionProtocol.js';
import type {
	ActionEnvelope,
	ChatAction,
	ClientAnnotationsAction,
	ClientChangesetAction,
	INotification,
	IRootConfigChangedAction,
	SessionAction,
	TerminalAction
} from '../../../platform/agentHost/common/state/sessionActions.js';
import type {
	CompletionsParams,
	CompletionsResult,
	CreateTerminalParams,
	ResolveSessionConfigResult,
	SessionConfigCompletionsResult
} from '../../../platform/agentHost/common/state/protocol/commands.js';
import type { InitializeResult } from '../../../platform/agentHost/common/state/protocol/common/commands.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../../../platform/agentHost/common/state/protocol/channels-changeset/commands.js';
import {
	ComponentToState,
	createRootState,
	RootState,
	StateComponents
} from '../../../platform/agentHost/common/state/sessionState.js';

const unsupported = () => {
	throw new Error('Agent host is not available in the Hucode Omni shell.');
};

class StaticAgentSubscription<T> implements IAgentSubscription<T> {

	readonly onDidChange: Event<T> = Event.None;
	readonly onWillApplyAction: Event<ActionEnvelope> = Event.None;
	readonly onDidApplyAction: Event<ActionEnvelope> = Event.None;

	constructor(readonly value: T, readonly verifiedValue: T) { }
}

/**
 * Agent host stub used by the Hucode Omni shell.
 *
 * The Omni window does not create chat or agent sessions, but common workbench
 * chat contributions can still read `IAgentHostService`. This service keeps
 * those reads inert without starting VS Code's desktop agent host process.
 */
export class OmniAgentHostService implements IAgentHostService {
	declare readonly _serviceBrand: undefined;

	readonly clientId = 'hucode-omni';
	readonly onAgentHostExit = Event.None;
	readonly onAgentHostStart = Event.None;
	readonly onDidNotification: Event<INotification> = Event.None;
	readonly onDidAction: Event<ActionEnvelope> = Event.None;
	readonly onMcpNotification: Event<IMcpNotification> = Event.None;
	readonly initializeResult: IObservable<InitializeResult | undefined> = constObservable(undefined);

	// Match NullAgentHostService: Omni never starts an agent-host auth flow, so
	// consumers should always observe a settled false state.
	readonly authenticationPending: IObservable<boolean> = constObservable(false);
	readonly rootState = new StaticAgentSubscription<RootState>(
		createRootState(),
		createRootState()
	);

	setAuthenticationPending(_pending: boolean): void { }

	getSubscription<T extends StateComponents>(
		_kind: T,
		_resource: URI
	): IReference<IAgentSubscription<ComponentToState[T]>> {
		return new ImmortalReference(unsupported());
	}

	getSubscriptionUnmanaged<T extends StateComponents>(
		_kind: T,
		_resource: URI
	): IAgentSubscription<ComponentToState[T]> | undefined {
		return undefined;
	}

	getInflightSessionCreate(
		_resource: URI
	): Promise<unknown> | undefined {
		return undefined;
	}

	getActiveSubscriptions(): readonly IActiveSubscriptionInfo[] { return []; }

	dispatch(
		_channel: string,
		_action: SessionAction | ChatAction | TerminalAction |
			ClientChangesetAction | ClientAnnotationsAction |
			IRootConfigChangedAction
	): void {
		unsupported();
	}

	async restartAgentHost(): Promise<void> { unsupported(); }
	async authenticate(
		_params: AuthenticateParams
	): Promise<AuthenticateResult> { return unsupported(); }
	async listSessions(): Promise<IAgentSessionMetadata[]> { return []; }
	async createSession(
		_config?: IAgentCreateSessionConfig
	): Promise<URI> { return unsupported(); }
	async resolveSessionConfig(
		_params: IAgentResolveSessionConfigParams
	): Promise<ResolveSessionConfigResult> { return unsupported(); }
	async sessionConfigCompletions(
		_params: IAgentSessionConfigCompletionsParams
	): Promise<SessionConfigCompletionsResult> { return unsupported(); }
	async completions(
		_params: CompletionsParams
	): Promise<CompletionsResult> { return { items: [] }; }
	async getCompletionTriggerCharacters(): Promise<readonly string[]> { return []; }
	async getNetworkDiagnosticsInfo(
	): Promise<IAgentHostNetworkDiagnosticsInfo> { return unsupported(); }
	async diagnosticsFetch(
		_url: string
	): Promise<IAgentHostNetworkFetchResult> { return unsupported(); }
	async startWebSocketServer(
	): Promise<IAgentHostSocketInfo> { return unsupported(); }
	async getInspectInfo(
		_tryEnable: boolean
	): Promise<IAgentHostInspectInfo | undefined> { return undefined; }
	async disposeSession(_session: URI): Promise<void> { }
	async createChat(_session: URI, _chat: URI): Promise<void> { unsupported(); }
	async disposeChat(_chat: URI): Promise<void> { }
	async createTerminal(_params: CreateTerminalParams): Promise<void> { unsupported(); }
	async disposeTerminal(_terminal: URI): Promise<void> { }
	async invokeChangesetOperation(
		_params: InvokeChangesetOperationParams
	): Promise<InvokeChangesetOperationResult> { return unsupported(); }
	async handleMcpRequest(
		_channel: string,
		_method: string,
		_params: Record<string, unknown> | undefined
	): Promise<unknown> { return unsupported(); }
	async resourceList(_uri: URI): Promise<ResourceListResult> { return unsupported(); }
	async resourceRead(_uri: URI): Promise<ResourceReadResult> { return unsupported(); }
	async resourceWrite(
		_params: ResourceWriteParams
	): Promise<ResourceWriteResult> { return unsupported(); }
	async resourceCopy(
		_params: ResourceCopyParams
	): Promise<ResourceCopyResult> { return unsupported(); }
	async resourceDelete(
		_params: ResourceDeleteParams
	): Promise<ResourceDeleteResult> { return unsupported(); }
	async resourceMove(
		_params: ResourceMoveParams
	): Promise<ResourceMoveResult> { return unsupported(); }
	async resourceResolve(
		_params: ResourceResolveParams
	): Promise<ResourceResolveResult> { return unsupported(); }
	async resourceMkdir(
		_params: ResourceMkdirParams
	): Promise<ResourceMkdirResult> { return unsupported(); }
	async createResourceWatch(
		_params: CreateResourceWatchParams
	): Promise<CreateResourceWatchResult> { return unsupported(); }
	async watchResource(
		_params: CreateResourceWatchParams
	): Promise<IRemoteWatchHandle> { return unsupported(); }
}
