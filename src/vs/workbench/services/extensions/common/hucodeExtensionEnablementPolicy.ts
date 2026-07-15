/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
