/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	downloadArtifact,
	type ElectronPlatformArtifactDetails,
} from '@electron/get';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getElectronVersion } from '../lib/util.ts';
import { ELECTRON_CHECKSUM_FILE } from './electron-checksums.ts';

const MAX_ATTEMPTS = 4;
const INITIAL_RETRY_DELAY_MS = 5_000;
const TRANSIENT_HTTP_STATUSES = new Set([
	408,
	425,
	429,
	500,
	502,
	503,
	504,
]);
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
	'EAI_AGAIN',
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENOTFOUND',
	'EPIPE',
	'ETIMEDOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
]);
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'armhf', 'x64']);

export interface IElectronPrefetchOptions {
	readonly version: string;
	readonly platform: string;
	readonly arch: string;
}

export interface IElectronPrefetchDependencies {
	readonly download: (
		options: ElectronPlatformArtifactDetails
	) => Promise<string>;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly warning: (message: string) => void;
}

interface IErrorMetadata {
	readonly cause?: unknown;
	readonly code?: unknown;
	readonly response?: {
		readonly status?: unknown;
	};
}

/**
 * Builds the complete `@electron/get` request for a platform artifact.
 */
export function buildElectronArtifactDetails(
	options: IElectronPrefetchOptions,
	checksums: Readonly<Record<string, string>>
): ElectronPlatformArtifactDetails {
	const arch = options.arch === 'armhf' ? 'arm' : options.arch;
	const checksumArch = arch === 'arm' ? 'armv7l' : arch;
	const artifactFileName =
		`electron-v${options.version}-${options.platform}-${checksumArch}.zip`;
	if (!checksums[artifactFileName]) {
		throw new Error(
			`Missing Electron checksum for ${artifactFileName}`
		);
	}

	return {
		...options,
		artifactName: 'electron',
		arch,
		checksums: { ...checksums },
	};
}

/**
 * Downloads and validates an Electron artifact into `@electron/get`'s cache,
 * retrying failures that are safe to repeat.
 */
export async function prefetchElectron(
	details: ElectronPlatformArtifactDetails,
	dependencies: IElectronPrefetchDependencies = defaultDependencies
): Promise<string> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await dependencies.download(details);
		} catch (error) {
			if (
				attempt === MAX_ATTEMPTS ||
				!isTransientDownloadError(error)
			) {
				throw error;
			}

			const delay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
			dependencies.warning(
				`Electron prefetch attempt ${attempt} of ${MAX_ATTEMPTS} ` +
				`failed; retrying in ${delay / 1_000}s: ` +
				formatErrorChain(error)
			);
			await dependencies.sleep(delay);
		}
	}

	throw new Error('Electron prefetch exhausted without a result.');
}

const defaultDependencies: IElectronPrefetchDependencies = {
	download: options => downloadArtifact(options),
	sleep: milliseconds =>
		new Promise(resolve => setTimeout(resolve, milliseconds)),
	warning: message => console.warn(message),
};

function errorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<unknown>();
	let current = error;

	while (current && !seen.has(current)) {
		chain.push(current);
		seen.add(current);
		current = typeof current === 'object'
			? (current as IErrorMetadata).cause
			: undefined;
	}

	return chain;
}

function errorCode(error: unknown): string | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		typeof (error as IErrorMetadata).code === 'string'
	) {
		return (error as IErrorMetadata).code as string;
	}

	return undefined;
}

function responseStatus(error: unknown): number | undefined {
	if (
		typeof error !== 'object' ||
		error === null ||
		typeof (error as IErrorMetadata).response?.status !== 'number'
	) {
		return undefined;
	}

	return (error as IErrorMetadata).response?.status as number;
}

function isTransientDownloadError(error: unknown): boolean {
	let foundCode = false;

	for (const current of errorChain(error)) {
		const status = responseStatus(current);
		if (status !== undefined) {
			return TRANSIENT_HTTP_STATUSES.has(status);
		}

		const code = errorCode(current);
		if (code) {
			foundCode = true;
			if (TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
				return true;
			}
		}
	}

	return !foundCode &&
		error instanceof TypeError &&
		error.message === 'fetch failed';
}

function formatErrorChain(error: unknown): string {
	return errorChain(error)
		.map(current => {
			const message = current instanceof Error
				? `${current.name}: ${current.message}`
				: String(current);
			const code = errorCode(current);
			const status = responseStatus(current);
			return [
				message,
				code ? `[${code}]` : undefined,
				status !== undefined ? `[HTTP ${status}]` : undefined,
			].filter(Boolean).join(' ');
		})
		.join(' caused by ');
}

function readArguments(args: readonly string[]): {
	readonly platform: string;
	readonly arch: string;
} {
	let platform: string | undefined;
	let arch: string | undefined;

	for (let index = 0; index < args.length; index++) {
		switch (args[index]) {
			case '--platform':
				platform = args[++index];
				break;
			case '--arch':
				arch = args[++index];
				break;
			default:
				throw new Error(`Unknown argument: ${args[index]}`);
		}
	}

	if (!platform || !SUPPORTED_PLATFORMS.has(platform)) {
		throw new Error(
			`--platform must be one of: ${[...SUPPORTED_PLATFORMS].join(', ')}`
		);
	}
	if (!arch || !SUPPORTED_ARCHITECTURES.has(arch)) {
		throw new Error(
			`--arch must be one of: ${[...SUPPORTED_ARCHITECTURES].join(', ')}`
		);
	}

	return { platform, arch };
}

/**
 * Parses Electron's pinned SHA-256 checksum manifest.
 */
export function parseElectronChecksums(
	content: string
): Record<string, string> {
	const checksums: Record<string, string> = {};

	for (const line of content.split(/\r?\n/)) {
		if (!line) {
			continue;
		}

		const match = /^([0-9a-f]{64}) \*(.+)$/.exec(line);
		if (!match) {
			throw new Error(`Invalid Electron checksum line: ${line}`);
		}
		checksums[match[2]] = match[1];
	}

	if (Object.keys(checksums).length === 0) {
		throw new Error('Electron checksum file is empty');
	}

	return checksums;
}

function readElectronChecksums(): Record<string, string> {
	return parseElectronChecksums(
		readFileSync(ELECTRON_CHECKSUM_FILE, 'utf8')
	);
}

async function main(): Promise<void> {
	const { platform, arch } = readArguments(process.argv.slice(2));
	const { electronVersion } = getElectronVersion();
	const artifactPath = await prefetchElectron(
		buildElectronArtifactDetails({
			version: electronVersion,
			platform,
			arch,
		}, readElectronChecksums())
	);
	console.log(
		`Electron ${electronVersion} ${platform}-${arch} cached at ${artifactPath}`
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(`Electron prefetch failed: ${formatErrorChain(error)}`);
		process.exitCode = 1;
	}
}
