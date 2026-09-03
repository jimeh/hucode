/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IPath } from '../../../../platform/window/common/window.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import type {
	HucodeExtensionEnablementPolicy,
} from '../../extensions/common/hucodeExtensionEnablementPolicy.js';

export const IWorkbenchEnvironmentService = refineServiceDecorator<IEnvironmentService, IWorkbenchEnvironmentService>(IEnvironmentService);

/**
 * A workbench specific environment service that is only present in workbench
 * layer.
 */
export interface IWorkbenchEnvironmentService extends IEnvironmentService {

	// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
	// NOTE: KEEP THIS INTERFACE AS SMALL AS POSSIBLE. AS SUCH:
	//       PUT NON-WEB PROPERTIES INTO THE NATIVE WORKBENCH
	//       ENVIRONMENT SERVICE
	// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

	// --- Paths
	readonly logFile: URI;
	readonly windowLogsPath: URI;
	readonly extHostLogsPath: URI;

	// --- Extensions
	readonly extensionEnabledProposedApi?: string[];
	readonly hucodeExtensionEnablementPolicy?: HucodeExtensionEnablementPolicy;

	// --- Config
	readonly remoteAuthority?: string;
	readonly skipReleaseNotes: boolean;
	readonly skipWelcome: boolean;
	readonly disableWorkspaceTrust: boolean;
	readonly isSessionsWindow: boolean;
	readonly isOmniWindow: boolean;
	readonly isHostedOmniWorkspace?: boolean;

	/**
	 * Whether this window is the Omni shell itself, from trusted configuration
	 * only.
	 *
	 * `isOmniWindow` and `isHostedOmniWorkspace` are both settable from the web
	 * client's `payload` URL parameter, which is fine for the UI routing that
	 * reads them but not for deciding which extensions may load. This is
	 * derived from the server-injected page configuration on web and from the
	 * main-process window configuration on desktop, so a crafted URL cannot
	 * move a window in or out of the shell's extension policy.
	 */
	readonly isOmniShellWindow: boolean;
	readonly hostedWebContentsId?: number;
	readonly hostedInstanceId?: string;
	readonly webviewExternalEndpoint: string;

	// --- Development
	readonly debugRenderer: boolean;
	readonly logExtensionHostCommunication?: boolean;
	readonly enableSmokeTestDriver?: boolean;
	readonly profDurationMarkers?: string[];

	// --- Editors to open
	readonly filesToOpenOrCreate?: IPath[] | undefined;
	readonly filesToDiff?: IPath[] | undefined;
	readonly filesToMerge?: IPath[] | undefined;

	// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
	// NOTE: KEEP THIS INTERFACE AS SMALL AS POSSIBLE. AS SUCH:
	//       - PUT NON-WEB PROPERTIES INTO NATIVE WB ENV SERVICE
	// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
}
