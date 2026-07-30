/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const verifierPackage = 'node-ovsx-sign';
const importScript = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = pathToFileURL(
	path.join(process.cwd(), 'node_modules', ${JSON.stringify(verifierPackage)})
		+ path.sep
).href;
const verifierUrl = import.meta.resolve(${JSON.stringify(verifierPackage)});
if (!verifierUrl.startsWith(packageRoot)) {
	throw new Error(
		'${verifierPackage} resolved outside the server-web output: '
			+ verifierUrl
	);
}

const verifier = await import(verifierUrl);
if (typeof verifier.verify !== 'function') {
	throw new Error('${verifierPackage} does not export verify');
}
`;

function runtimeEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_PATH;
	return env;
}

/**
 * Verifies that a server-web output contains the OpenVSX signature verifier.
 */
export async function verifyServerWebSignatureVerifier(
	serverRoot: string,
	verifyRuntimeImport = false,
	nodeExecutable = path.join(serverRoot, 'node'),
	runtimeImportTimeoutMs = 30_000
): Promise<void> {
	const packageJsonPath = path.join(
		serverRoot,
		'node_modules',
		verifierPackage,
		'package.json'
	);

	try {
		await fs.access(packageJsonPath);
	} catch {
		throw new Error(
			`Server-web signature verifier not found: ${packageJsonPath}`
		);
	}

	if (!verifyRuntimeImport) {
		return;
	}

	const result = spawnSync(
		nodeExecutable,
		['--input-type=module', '--eval', importScript],
		{
			cwd: serverRoot,
			encoding: 'utf8',
			env: runtimeEnvironment(),
			killSignal: 'SIGKILL',
			timeout: runtimeImportTimeoutMs
		}
	);

	if (result.status === 0) {
		return;
	}

	const details = result.error?.message
		|| result.stderr.trim()
		|| `exit code ${result.status}`;
	throw new Error(
		`Packaged runtime failed to import ${verifierPackage}: ${details}`
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const verifyRuntimeImport = args.includes('--verify-runtime-import');
	const serverRoot = args.find(arg => !arg.startsWith('--'));
	if (!serverRoot) {
		throw new Error(
			'Usage: server-web-verifier.ts <server-root> '
			+ '[--verify-runtime-import]'
		);
	}

	await verifyServerWebSignatureVerifier(
		path.resolve(serverRoot),
		verifyRuntimeImport
	);
}

if (
	process.argv[1]
	&& path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
