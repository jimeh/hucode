/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ExtensionType,
	type IExtension,
	type IExtensionManifest,
	isResolverExtension,
} from '../../../../platform/extensions/common/extensions.js';
import type {
	IScannedExtension,
} from '../../../../platform/extensionManagement/common/extensionsScannerService.js';

export const HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY =
	'omniDisableUserExtensionsWithoutThemes';

export type HucodeExtensionEnablementPolicy =
	typeof HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY;

/**
 * Built-in extensions the Omni shell neither exposes nor needs.
 *
 * The shell has no editor, SCM, debug, or chat surfaces, so these contribute
 * nothing there while still paying their activation cost. Desktop drops them
 * at scan time through `skipBuiltinExtensions`, which is a native environment
 * setting the server-web extension scanner never sees; web drops them at
 * enablement instead. Both platforms read this one list so the two mechanisms
 * cannot drift apart.
 */
export const HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS = [
	'GitHub.copilot-chat',
	'vscode.debug-auto-launch',
	'vscode.debug-server-ready',
	'vscode.git',
	'vscode.git-base',
	'vscode.github',
	'vscode.github-authentication',
	'vscode.grunt',
	'vscode.gulp',
	'vscode.jake',
	'vscode.merge-conflict',
	'vscode.microsoft-authentication',
	'vscode.npm',
	'vscode.terminal-suggest',
	'vscode.tunnel-forwarding',
] as const;

const hucodeOmniShellSkippedBuiltinIds = new Set<string>(
	HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.map(id => id.toLowerCase())
);

/**
 * Returns whether the Omni shell skips the built-in extension with this id.
 */
export function hucodeIsOmniShellSkippedBuiltinId(id: string): boolean {
	return hucodeOmniShellSkippedBuiltinIds.has(id.toLowerCase());
}

/**
 * Returns whether the Omni shell should refuse to load this extension.
 *
 * Scoped to built-ins, which here means what `toExtension` reports: a
 * user-installed *builtin* has `type === User` and `isBuiltin === true`, and is
 * skipped. An ordinary marketplace extension sharing one of these ids is not,
 * and is left to the theme-only user extension policy, which already covers it.
 */
export function hucodeIsExtensionSkippedInOmniShell(
	extension: IExtension
): boolean {
	return extension.isBuiltin
		&& hucodeIsOmniShellSkippedBuiltinId(extension.identifier.id);
}

/**
 * Returns whether Hucode should filter user extensions to theme contributors.
 */
export function hucodeShouldKeepOnlyUserThemeExtensions(
	policy: HucodeExtensionEnablementPolicy | undefined
): boolean {
	return policy === HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY;
}

/**
 * Returns whether the extension manifest contributes shell-usable theme assets.
 */
export function hucodeExtensionContributesTheme(
	manifest: IExtensionManifest
): boolean {
	const contributes = manifest.contributes;
	return !!(
		contributes?.themes?.length
		|| contributes?.iconThemes?.length
		|| contributes?.productIconThemes?.length
	);
}

function hucodeIsResolverExtension(
	manifest: IExtensionManifest,
	remoteAuthority: string | undefined
): boolean {
	if (isResolverExtension(manifest, remoteAuthority)) {
		return true;
	}

	return remoteAuthority === undefined
		&& manifest.activationEvents?.some(
			event => event.startsWith('onResolveRemoteAuthority:')
		) === true;
}

/**
 * Computes whether an installed extension is disabled by Hucode policy.
 */
export function hucodeIsExtensionDisabledByPolicy(
	extension: IExtension,
	policy: HucodeExtensionEnablementPolicy | undefined,
	remoteAuthority: string | undefined
): boolean | undefined {
	if (!hucodeShouldKeepOnlyUserThemeExtensions(policy)) {
		return undefined;
	}

	if (
		extension.isBuiltin
		|| extension.type !== ExtensionType.User
		|| hucodeIsResolverExtension(extension.manifest, remoteAuthority)
	) {
		return false;
	}

	return !hucodeExtensionContributesTheme(extension.manifest);
}

/**
 * Returns whether a scanned user extension should remain visible to the shell.
 */
export function hucodeShouldKeepScannedUserExtension(
	extension: IScannedExtension,
	policy: HucodeExtensionEnablementPolicy | undefined,
	remoteAuthority: string | undefined
): boolean {
	if (!hucodeShouldKeepOnlyUserThemeExtensions(policy)) {
		return true;
	}

	return hucodeIsResolverExtension(extension.manifest, remoteAuthority)
		|| hucodeExtensionContributesTheme(extension.manifest);
}
