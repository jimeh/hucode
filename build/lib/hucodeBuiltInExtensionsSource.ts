/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BuiltInExtensionDownloadSource = 'github' | 'marketplace' | 'vsix';

type BuiltInExtensionsSource = Exclude<BuiltInExtensionDownloadSource, 'vsix'>;
type BuiltInExtension = {
	readonly vsix?: string;
	readonly platformSpecific?: Readonly<Record<string, string>>;
};
type ProductConfiguration = {
	readonly builtInExtensionsSource?: unknown;
	readonly extensionsGallery?: { readonly serviceUrl?: string };
};

function resolveConfiguredSource(product: ProductConfiguration): BuiltInExtensionsSource {
	const configuredSource = product.builtInExtensionsSource;
	if (configuredSource === undefined) {
		return product.extensionsGallery?.serviceUrl ? 'marketplace' : 'github';
	}

	if (configuredSource !== 'github' && configuredSource !== 'marketplace') {
		const value = typeof configuredSource === 'string'
			? `'${configuredSource}'`
			: JSON.stringify(configuredSource) ?? String(configuredSource);
		throw new Error(
			`Invalid builtInExtensionsSource ${value}. Expected 'github' or 'marketplace'.`
		);
	}

	if (
		configuredSource === 'marketplace' &&
		!product.extensionsGallery?.serviceUrl
	) {
		throw new Error(
			'builtInExtensionsSource is \'marketplace\', but extensionsGallery.serviceUrl is not configured.'
		);
	}

	return configuredSource;
}

/**
 * Creates a built-in extension source resolver after validating product policy.
 */
export function createBuiltInExtensionSourceResolver(
	product: ProductConfiguration
): (extension: BuiltInExtension) => BuiltInExtensionDownloadSource {
	const configuredSource = resolveConfiguredSource(product);

	return extension => {
		if (extension.vsix) {
			return 'vsix';
		}

		if (extension.platformSpecific) {
			return 'github';
		}

		return configuredSource;
	};
}

/**
 * Resolves where a built-in extension should be downloaded from.
 */
export function resolveBuiltInExtensionDownloadSource(
	extension: BuiltInExtension,
	product: ProductConfiguration
): BuiltInExtensionDownloadSource {
	return createBuiltInExtensionSourceResolver(product)(extension);
}
