/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import crypto from 'crypto';
import {
	computeNodeModulesBaseCacheKey,
	computePnpmStoreCacheKey,
	type ReadRepositoryFile,
} from '../azure-pipelines/common/cacheKeys.ts';

/**
 * Computes the cache key of a prebuilt node_modules archive: the configuration
 * that decides how dependencies are built and laid out, and the lockfile of
 * every install root, which decides what is installed. The arguments name the
 * job and its platform.
 */
export function computeHucodeNodeModulesCacheKey(
	args: readonly string[],
	readFile?: ReadRepositoryFile
): string {
	return crypto.createHash('sha256')
		.update(computeNodeModulesBaseCacheKey(args, readFile))
		.update(computePnpmStoreCacheKey(readFile))
		.digest('hex');
}

if (import.meta.main) {
	process.stdout.write(computeHucodeNodeModulesCacheKey(process.argv.slice(2)));
}
