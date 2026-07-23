/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment } from '../../base/common/platform.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { INativeWindowConfiguration } from '../../platform/window/common/window.js';

/**
 * Hucode Omni window path marker used by VS Code's main-process open plan.
 */
export interface IHucodeOmniWindowPath {
	readonly isOmniWindow: true;
	readonly omniActiveWorktreePath?: string;
	readonly omniResidentWorkspaces?:
	INativeWindowConfiguration['omniResidentWorkspaces'];
	readonly omniRetainedWorkbenches?:
	INativeWindowConfiguration['omniRetainedWorkbenches'];
}

/**
 * Configuration subset needed to open a Hucode Omni browser window.
 */
export interface IHucodeOmniOpenConfiguration {
	readonly userEnv?: IProcessEnvironment;
	readonly cli?: NativeParsedArgs;
	readonly initialStartup?: boolean;
	readonly forceNewTabbedWindow?: boolean;
	readonly forceProfile?: string;
	readonly forceTempProfile?: boolean;
}

/**
 * Open configuration guarantees for an explicit new Omni-window request.
 */
export interface IHucodeNewOmniWindowOpenConfiguration {
	readonly forceNewWindow: true;
	readonly forceOmniWindow: true;
	readonly forceEmpty: false;
	readonly noRecentEntry: true;
}

/**
 * Window subset needed to focus a newly opened Hucode Omni window.
 */
export interface IHucodeFocusableOmniWindow {
	focus(): void;
}

/**
 * Browser-window options that identify an Omni shell window.
 */
export interface IHucodeOmniBrowserWindowOptions
	extends IHucodeOmniOpenConfiguration {
	readonly forceNewWindow: boolean;
	readonly isOmniWindow: true;
	readonly omniActiveWorktreePath?: string;
	readonly omniResidentWorkspaces?:
	INativeWindowConfiguration['omniResidentWorkspaces'];
	readonly omniRetainedWorkbenches?:
	INativeWindowConfiguration['omniRetainedWorkbenches'];
}

/**
 * Window-state subset persisted for Hucode Omni shell windows.
 */
export interface IHucodeOmniWindowState {
	readonly windowKind?: string;
	readonly omniActiveWorktreePath?: string;
	readonly omniResidentWorkspaces?:
	INativeWindowConfiguration['omniResidentWorkspaces'];
	readonly omniRetainedWorkbenches?:
	INativeWindowConfiguration['omniRetainedWorkbenches'];
}

/**
 * Identifies Hucode Omni paths in the main-process open plan.
 */
export function isHucodeOmniPathToOpen(
	path: { readonly isOmniWindow?: boolean } | undefined
): path is IHucodeOmniWindowPath {
	return !!path?.isOmniWindow;
}

/**
 * Creates an Omni path marker for explicit Omni window open requests.
 */
export function createHucodeOmniWindowPath(
	options: Omit<IHucodeOmniWindowPath, 'isOmniWindow'> = {}
): IHucodeOmniWindowPath {
	return {
		isOmniWindow: true,
		...options,
	};
}

/**
 * Applies the main-process guarantees for an explicit new Omni-window request.
 */
export function getHucodeNewOmniWindowOpenConfiguration<
	TConfig extends object
>(openConfig: TConfig): TConfig & IHucodeNewOmniWindowOpenConfiguration {
	return {
		...openConfig,
		forceNewWindow: true,
		forceOmniWindow: true,
		forceEmpty: false,
		noRecentEntry: true,
	};
}

/**
 * Opens and focuses one explicit new Hucode Omni window.
 */
export async function openNewHucodeOmniWindow<
	TConfig extends object,
	TWindow extends IHucodeFocusableOmniWindow
>(
	openConfig: TConfig,
	open: (
		configuration: TConfig & IHucodeNewOmniWindowOpenConfiguration
	) => Promise<TWindow[]>
): Promise<TWindow[]> {
	const windows = await open(
		getHucodeNewOmniWindowOpenConfiguration(openConfig)
	);
	windows.at(-1)?.focus();
	return windows;
}

/**
 * Returns the Hucode default startup window when there is no session or path to
 * restore.
 */
export function getHucodeDefaultStartupWindowPath(
	options: {
		readonly initialStartup?: boolean;
		readonly hasRestorableWindows?: boolean;
	}
): IHucodeOmniWindowPath | undefined {
	if (!options.initialStartup || options.hasRestorableWindows) {
		return undefined;
	}

	return createHucodeOmniWindowPath();
}

/**
 * Converts persisted Omni window state into a restorable open-plan path.
 */
export function getHucodeOmniPathFromWindowState(
	windowState: IHucodeOmniWindowState
): IHucodeOmniWindowPath | undefined {
	if (windowState.windowKind !== 'omni') {
		return undefined;
	}

	return createHucodeOmniWindowPath({
		omniActiveWorktreePath: windowState.omniActiveWorktreePath,
		omniResidentWorkspaces: windowState.omniResidentWorkspaces,
		omniRetainedWorkbenches: windowState.omniRetainedWorkbenches,
	});
}

/**
 * Keeps Hucode Omni windows in the preserve-restore path set.
 */
export function filterHucodePreserveRestorePaths<TPath extends object>(
	paths: readonly TPath[],
	isWorkspacePath: (path: TPath) => boolean,
	isFolderPath: (path: TPath) => boolean
): TPath[] {
	return paths.filter(path =>
		isWorkspacePath(path) ||
		isFolderPath(path) ||
		!!(path as { readonly backupPath?: string }).backupPath ||
		isHucodeOmniPathToOpen(path)
	);
}

/**
 * Removes duplicate restorable Omni windows from the open plan.
 */
export function distinctHucodeOmniWindowPaths<TPath extends IHucodeOmniWindowPath>(
	paths: readonly TPath[]
): TPath[] {
	const seen = new Set<string>();
	const result: TPath[] = [];

	for (const path of paths) {
		const key = getHucodeOmniWindowRestoreKey(path);
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(path);
	}

	return result;
}

/**
 * Builds browser-window options for a Hucode Omni shell window.
 */
export function getHucodeOmniBrowserWindowOptions(
	openConfig: IHucodeOmniOpenConfiguration,
	omniWindow: IHucodeOmniWindowPath,
	forceNewWindow: boolean
): IHucodeOmniBrowserWindowOptions {
	return {
		userEnv: openConfig.userEnv,
		cli: openConfig.cli,
		initialStartup: openConfig.initialStartup,
		forceNewWindow,
		forceNewTabbedWindow: openConfig.forceNewTabbedWindow,
		forceProfile: openConfig.forceProfile,
		forceTempProfile: openConfig.forceTempProfile,
		isOmniWindow: true,
		omniActiveWorktreePath: omniWindow.omniActiveWorktreePath,
		omniResidentWorkspaces: omniWindow.omniResidentWorkspaces,
		omniRetainedWorkbenches: omniWindow.omniRetainedWorkbenches,
	};
}

/**
 * Determines whether file opens were routed through Omni or should continue
 * through regular VS Code window selection.
 */
export async function getHucodeOmniFileOpenPlan<TWindow extends object>(
	options: {
		readonly forceNewWindow?: boolean;
		readonly windows: readonly TWindow[];
		readonly openInOmniWindow: () => Promise<TWindow | undefined>;
	}
): Promise<
	| { readonly omniWindow: TWindow; readonly fallbackWindows?: undefined }
	| { readonly omniWindow?: undefined; readonly fallbackWindows: TWindow[] }
> {
	if (!options.forceNewWindow) {
		const omniWindow = await options.openInOmniWindow();
		if (omniWindow) {
			return { omniWindow };
		}
	}

	return {
		fallbackWindows: getHucodeRegularFileOpenWindows(options.windows),
	};
}

/**
 * Excludes Omni shell windows from normal file-open fallback selection.
 */
export function getHucodeRegularFileOpenWindows<TWindow extends object>(
	windows: readonly TWindow[]
): TWindow[] {
	return windows.filter(window =>
		!(window as { readonly isOmniWindow?: boolean }).isOmniWindow
	);
}

function getHucodeOmniWindowRestoreKey(
	omniWindow: IHucodeOmniWindowPath
): string {
	return JSON.stringify({
		active: omniWindow.omniActiveWorktreePath,
		resident: omniWindow.omniResidentWorkspaces ?? [],
		retained: omniWindow.omniRetainedWorkbenches ?? [],
	});
}
