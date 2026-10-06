/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shouldGenerateNodeCompileCache, type INodeCompileCacheProduct } from './nodeCompileCache.ts';

interface IHucodeNodeCompileCacheProduct extends INodeCompileCacheProduct {
	readonly electronArtifactFeed?: string;
}

/**
 * Restricts packaged Node.js compile cache generation to builds whose Electron
 * produces a user-independent cache.
 *
 * Public Electron releases append the generating user's uid to the cache
 * version tag on POSIX. Upstream's validator rejects that tag, and the cache
 * would not match an installing user's uid anyway. Upstream product builds
 * use Electron from `electronArtifactFeed`, which does not append the uid, so
 * builds without a feed generate the cache only on Windows.
 */
export function shouldGenerateHucodeNodeCompileCache(platform: string, arch: string, product: IHucodeNodeCompileCacheProduct): boolean {
	if (!shouldGenerateNodeCompileCache(platform, arch, product)) {
		return false;
	}

	return platform === 'win32' || !!product.electronArtifactFeed;
}
