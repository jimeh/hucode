/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'module';
import es from 'event-stream';

const require = createRequire(import.meta.url);
const plist = require('plist') as {
	parse(contents: string): unknown;
	build(value: unknown): string;
};

/**
 * Returns a macOS application plist with the user-visible bundle version set.
 */
export function patchDarwinInfoPlistContents(contents: string, version: string): Buffer {
	const infoPlist = plist.parse(contents);
	if (!infoPlist || typeof infoPlist !== 'object') {
		throw new Error('Unable to parse macOS Info.plist.');
	}

	const patchedInfoPlist = infoPlist as Record<string, unknown>;
	patchedInfoPlist['CFBundleVersion'] = version;
	patchedInfoPlist['CFBundleShortVersionString'] = version;

	return Buffer.from(plist.build(patchedInfoPlist));
}

/**
 * Patches selected macOS Info.plist files in a vinyl stream.
 */
export function patchDarwinInfoPlistVersion(
	version: string | undefined,
	infoPlistPaths: Iterable<string>
): NodeJS.ReadWriteStream {
	const normalizedPaths = new Set(
		[...infoPlistPaths].map(infoPlistPath => infoPlistPath.replace(/\\/g, '/'))
	);

	return es.map((file: any, callback: (error?: Error, file?: unknown) => void) => {
		if (!version || !normalizedPaths.has(file.relative.replace(/\\/g, '/'))) {
			callback(undefined, file);
			return;
		}

		if (file.isBuffer()) {
			try {
				file.contents = patchDarwinInfoPlistContents(
					file.contents.toString('utf8'),
					version
				);
				callback(undefined, file);
			} catch (error) {
				callback(error as Error);
			}
			return;
		}

		if (file.isStream()) {
			const chunks: Buffer[] = [];

			file.contents.on('error', (error: Error) => callback(error));
			file.contents.on('data', (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			file.contents.on('end', () => {
				try {
					file.contents = patchDarwinInfoPlistContents(
						Buffer.concat(chunks).toString('utf8'),
						version
					);
					callback(undefined, file);
				} catch (error) {
					callback(error as Error);
				}
			});
			return;
		}

		callback(undefined, file);
	});
}
