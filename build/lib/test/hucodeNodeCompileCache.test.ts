/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { shouldGenerateHucodeNodeCompileCache } from '../hucodeNodeCompileCache.ts';

suite('Hucode Node.js compile cache generation', () => {
	const product = {
		applicationName: 'hucode',
		nameLong: 'Hucode',
		nameShort: 'Hucode',
		quality: 'stable'
	};
	const targets = [
		['win32', 'x64'],
		['win32', 'arm64'],
		['darwin', 'x64'],
		['darwin', 'arm64'],
		['linux', 'x64'],
		['linux', 'arm64'],
	] as const;

	function generatedTargets(configuration: Parameters<typeof shouldGenerateHucodeNodeCompileCache>[2]): string[] {
		return targets
			.filter(([platform, arch]) => shouldGenerateHucodeNodeCompileCache(platform, arch, configuration))
			.map(([platform, arch]) => `${platform}-${arch}`);
	}

	test('public Electron builds generate the cache only on Windows', () => {
		assert.deepStrictEqual(generatedTargets(product), ['win32-x64']);
	});

	test('builds from an Electron artifact feed keep upstream targets', () => {
		assert.deepStrictEqual(
			generatedTargets({ ...product, electronArtifactFeed: 'feed' }),
			['win32-x64', 'darwin-arm64', 'linux-x64']
		);
	});

	test('builds without a quality never generate the cache', () => {
		assert.deepStrictEqual(generatedTargets({ ...product, quality: undefined }), []);
	});
});
