/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Configures GitHub release asset selection. */
interface IGithubReleaseAssetOptions {
	readonly version: string;
	readonly name: string | ((name: string) => boolean);
	readonly latest?: boolean;
}

type GithubReleaseAssetLocation =
	| { readonly kind: 'direct'; readonly url: string }
	| { readonly kind: 'api'; readonly path: string };

/** Returns the conventional VSIX filename for a pinned built-in extension. */
export function getGithubReleaseAssetName(
	extensionName: string,
	version: string
): string {
	return `${extensionName}.${version}.vsix`;
}

/** Builds the public download URL for an exact GitHub release asset. */
export function getGithubReleaseAssetUrl(
	repo: string,
	version: string,
	assetName: string
): string {
	const cleanRepo = repo.replace(/^\/+|\/+$/g, '');
	return `https://github.com/${cleanRepo}/releases/download/${encodeURIComponent(`v${version}`)}/${encodeURIComponent(assetName)}`;
}

/** Selects direct download for pinned assets and API discovery for latest assets. */
export function resolveGithubReleaseAssetLocation(
	repo: string,
	options: IGithubReleaseAssetOptions
): GithubReleaseAssetLocation {
	const cleanRepo = repo.replace(/^\/+|\/+$/g, '');
	if (!options.latest) {
		if (typeof options.name !== 'string') {
			throw new Error(
				'Pinned GitHub release assets require an exact asset name.'
			);
		}
		return {
			kind: 'direct',
			url: getGithubReleaseAssetUrl(
				cleanRepo,
				options.version,
				options.name
			),
		};
	}

	return {
		kind: 'api',
		path: `/repos/${cleanRepo}/releases?per_page=100`,
	};
}

/** Builds GitHub API headers using the first available supported token. */
export function getGithubApiHeaders(
	environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'VSCode Build',
	};
	const token = environment.GITHUB_TOKEN || environment.GH_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}
