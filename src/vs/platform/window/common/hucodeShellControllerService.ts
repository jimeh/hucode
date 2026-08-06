/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { UriComponents } from '../../../base/common/uri.js';
import { IChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from
	'../../instantiation/common/instantiation.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IOmniRetainedWorkbench,
	IRectangle,
} from './window.js';

type HucodeHostedWorkbenchLifecycleState =
	| 'restore-pending'
	| 'loading'
	| 'active'
	| 'loaded'
	| 'dormant'
	| 'unloaded'
	| 'missing'
	| 'crashed';

interface IHucodeHostedWorkbenchInstance {
	readonly instanceId: string;
	readonly projectId?: string;
	readonly worktreePath: string;
	readonly state: HucodeHostedWorkbenchLifecycleState;
	readonly webContentsId?: number;
	readonly processId?: number;
	readonly visible: boolean;
	readonly focused: boolean;
	readonly lastActiveAt?: number;
}

type ProjectSwitcherOmniSection = 'workbenches' | 'projects';

interface IHucodeHostedWorkspaceState {
	readonly activeInstanceId?: string;
	readonly projectsSidebarVisible: boolean;
	readonly projectSwitcherCanGoBack: boolean;
	readonly projectSwitcherCanGoForward: boolean;
	readonly projectSwitcherSectionOrder?:
	readonly ProjectSwitcherOmniSection[];
	readonly instances: readonly IHucodeHostedWorkbenchInstance[];
	readonly retainedWorkbenches?: readonly IOmniRetainedWorkbench[];
}

interface IHucodeCompleteProjectCatalogEntry {
	readonly projectId: string;
	readonly folderUris: readonly UriComponents[];
}

interface IHucodeProjectFolderPromotion {
	readonly projectId: string;
	readonly folderUri: UriComponents;
}

type HucodeHostedWorkbenchRestorePolicy = 'active' | 'all' | 'none';

/** Numeric lifecycle reasons accepted by the shell shutdown boundary. */
type HucodeShellShutdownReason = 1 | 2 | 3 | 4;

/** MessagePort channel exposing the privileged, owner-bound shell capability. */
export const HUCODE_SHELL_CONTROLLER_CHANNEL = 'hucodeShellController';

/** Desktop IPC request used only to acquire the bound shell capability port. */
export const HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL =
	'vscode:hucodeShellControllerPort';

/** Desktop IPC response carrying the bound shell capability port. */
export const HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL =
	'vscode:hucodeShellControllerPortResult';

/** Current same-build desktop shell capability contract version. */
export const HUCODE_SHELL_CONTROLLER_PROTOCOL_VERSION = 1;

/** Path-scoped preparation before a shell opens a folder standalone. */
export interface IHucodeStandaloneWorkspaceRequest {
	readonly folderUri: UriComponents;
	readonly retainedWorkbenchId?: string;
}

export const IHucodeShellControllerService =
	createDecorator<IHucodeShellControllerService>(
		'hucodeShellControllerService'
	);

/** Privileged operations available only to one bound Omni shell renderer. */
export interface IHucodeShellControllerService {
	readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay: boolean;
	readonly onDidChangeState: Event<IHucodeHostedWorkspaceState>;

	getState(): Promise<IHucodeHostedWorkspaceState>;
	focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean>;
	focusNormalWindowByPath(worktreePath: string): Promise<boolean>;
	openWorkspace(
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	openAndFocusWorkspace(
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	suspendWorkspace(instanceId: string): Promise<IHucodeHostedWorkspaceState>;
	retainAndOpenWorkbench(
		folderUri: UriComponents
	): Promise<IHucodeHostedWorkspaceState>;
	unloadRetainedWorkbench(
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState>;
	dismissRetainedWorkbench(
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState>;
	reorderRetainedWorkbenches(
		orderedWorkbenchIds: readonly string[]
	): Promise<IHucodeHostedWorkspaceState>;
	setRetainedWorkbenchLabel(
		workbenchId: string,
		label: string | undefined
	): Promise<IHucodeHostedWorkspaceState>;
	reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
		projects: readonly IHucodeCompleteProjectCatalogEntry[]
	): Promise<IHucodeHostedWorkspaceState>;
	promoteRetainedWorkbenchProjectFolders(
		projectFolders: readonly IHucodeProjectFolderPromotion[]
	): Promise<IHucodeHostedWorkspaceState>;
	setHostedWorkbenchRestorePolicy(
		policy: HucodeHostedWorkbenchRestorePolicy
	): Promise<void>;
	openFilesInWorkspace(
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean>;
	openFilesInActiveWorkspace(request: INativeOpenFileRequest): Promise<boolean>;
	closeWorkspace(instanceId?: string): Promise<IHucodeHostedWorkspaceState>;
	reopenWorkspaceInNormalWindow(instanceId: string): Promise<boolean>;
	prepareWorkspaceForStandaloneOpen(
		request: IHucodeStandaloneWorkspaceRequest
	): Promise<boolean>;
	focusWorkspace(): Promise<void>;
	focusShell(): Promise<void>;
	setProjectsSidebarVisible(visible: boolean): Promise<void>;
	setProjectSwitcherNavigationState(
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void>;
	setProjectSwitcherSectionOrder(
		order: readonly ProjectSwitcherOmniSection[]
	): Promise<void>;
	runActionInWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean>;
	runKeybindingInWorkspace(
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean>;
	triggerPasteInWorkspace(): Promise<boolean>;
	reloadWorkspace(): Promise<void>;
	toggleWorkspaceDevTools(): Promise<boolean>;
	layoutWorkspace(bounds: IRectangle): Promise<void>;
	captureWorkspaceScreenshot(
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
	setWorkspaceOverlayOcclusion(occluded: boolean): Promise<void>;
	shutdownWindowWorkspaces(reason: HucodeShellShutdownReason): Promise<void>;
}

/** Exact remotely exposed surface of the privileged shell capability. */
export const HUCODE_SHELL_CONTROLLER_REMOTE_MEMBERS = Object.freeze([
	'onDidChangeState',
	'getState',
	'focusHostedWorkspaceByPath',
	'focusNormalWindowByPath',
	'openWorkspace',
	'openAndFocusWorkspace',
	'suspendWorkspace',
	'retainAndOpenWorkbench',
	'unloadRetainedWorkbench',
	'dismissRetainedWorkbench',
	'reorderRetainedWorkbenches',
	'setRetainedWorkbenchLabel',
	'reconcileRetainedWorkbenchesWithCompleteProjectCatalog',
	'promoteRetainedWorkbenchProjectFolders',
	'setHostedWorkbenchRestorePolicy',
	'openFilesInWorkspace',
	'openFilesInActiveWorkspace',
	'closeWorkspace',
	'reopenWorkspaceInNormalWindow',
	'prepareWorkspaceForStandaloneOpen',
	'focusWorkspace',
	'focusShell',
	'setProjectsSidebarVisible',
	'setProjectSwitcherNavigationState',
	'setProjectSwitcherSectionOrder',
	'runActionInWorkspace',
	'runKeybindingInWorkspace',
	'triggerPasteInWorkspace',
	'reloadWorkspace',
	'toggleWorkspaceDevTools',
	'layoutWorkspace',
	'captureWorkspaceScreenshot',
	'setWorkspaceOverlayOcclusion',
	'shutdownWindowWorkspaces',
] as const satisfies readonly (keyof IHucodeShellControllerService)[]);

type MissingShellControllerRemoteMember = Exclude<
	keyof IHucodeShellControllerService,
	typeof HUCODE_SHELL_CONTROLLER_REMOTE_MEMBERS[number] |
	'_serviceBrand' | 'supportsWorkspaceScreenshotOverlay'
>;
const shellControllerRemoteMembersAreExhaustive:
	MissingShellControllerRemoteMember extends never ? true : never = true;
void shellControllerRemoteMembersAreExhaustive;

/** Creates the typed client for an owner-authenticated shell port. */
export function createHucodeShellControllerClient(
	channel: IChannel
): IHucodeShellControllerService {
	const remote = ProxyChannel.toService<IHucodeShellControllerService>(channel, {
		properties: new Map([
			['supportsWorkspaceScreenshotOverlay', true],
		]),
	});
	return {
		_serviceBrand: undefined,
		supportsWorkspaceScreenshotOverlay: true,
		onDidChangeState: remote.onDidChangeState,
		getState: () => remote.getState(),
		focusHostedWorkspaceByPath: (path, projectId) =>
			remote.focusHostedWorkspaceByPath(path, projectId),
		focusNormalWindowByPath: path => remote.focusNormalWindowByPath(path),
		openWorkspace: (path, projectId) =>
			remote.openWorkspace(path, projectId),
		openAndFocusWorkspace: (path, projectId) =>
			remote.openAndFocusWorkspace(path, projectId),
		suspendWorkspace: instanceId => remote.suspendWorkspace(instanceId),
		retainAndOpenWorkbench: folderUri =>
			remote.retainAndOpenWorkbench(folderUri),
		unloadRetainedWorkbench: workbenchId =>
			remote.unloadRetainedWorkbench(workbenchId),
		dismissRetainedWorkbench: workbenchId =>
			remote.dismissRetainedWorkbench(workbenchId),
		reorderRetainedWorkbenches: ids =>
			remote.reorderRetainedWorkbenches(ids),
		setRetainedWorkbenchLabel: (workbenchId, label) =>
			remote.setRetainedWorkbenchLabel(workbenchId, label),
		reconcileRetainedWorkbenchesWithCompleteProjectCatalog: projects =>
			remote.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(projects),
		promoteRetainedWorkbenchProjectFolders: projectFolders =>
			remote.promoteRetainedWorkbenchProjectFolders(projectFolders),
		setHostedWorkbenchRestorePolicy: policy =>
			remote.setHostedWorkbenchRestorePolicy(policy),
		openFilesInWorkspace: (path, request, projectId) =>
			remote.openFilesInWorkspace(path, request, projectId),
		openFilesInActiveWorkspace: request =>
			remote.openFilesInActiveWorkspace(request),
		closeWorkspace: instanceId => remote.closeWorkspace(instanceId),
		reopenWorkspaceInNormalWindow: instanceId =>
			remote.reopenWorkspaceInNormalWindow(instanceId),
		prepareWorkspaceForStandaloneOpen: request =>
			remote.prepareWorkspaceForStandaloneOpen(request),
		focusWorkspace: () => remote.focusWorkspace(),
		focusShell: () => remote.focusShell(),
		setProjectsSidebarVisible: visible =>
			remote.setProjectsSidebarVisible(visible),
		setProjectSwitcherNavigationState: (back, forward) =>
			remote.setProjectSwitcherNavigationState(back, forward),
		setProjectSwitcherSectionOrder: order =>
			remote.setProjectSwitcherSectionOrder(order),
		runActionInWorkspace: request => remote.runActionInWorkspace(request),
		runKeybindingInWorkspace: request =>
			remote.runKeybindingInWorkspace(request),
		triggerPasteInWorkspace: () => remote.triggerPasteInWorkspace(),
		reloadWorkspace: () => remote.reloadWorkspace(),
		toggleWorkspaceDevTools: () => remote.toggleWorkspaceDevTools(),
		layoutWorkspace: bounds => remote.layoutWorkspace(bounds),
		captureWorkspaceScreenshot: (rect, quality) =>
			remote.captureWorkspaceScreenshot(rect, quality),
		setWorkspaceOverlayOcclusion: occluded =>
			remote.setWorkspaceOverlayOcclusion(occluded),
		shutdownWindowWorkspaces: reason =>
			remote.shutdownWindowWorkspaces(reason),
	};
}
