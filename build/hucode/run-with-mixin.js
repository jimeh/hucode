/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(args) {
	let quality = 'stable';
	const separator = args.indexOf('--');
	const before = separator === -1 ? args : args.slice(0, separator);
	const command = separator === -1 ? [] : args.slice(separator + 1);

	for (let i = 0; i < before.length; i++) {
		if (before[i] === '--quality') {
			quality = before[i + 1];
			i++;
		}
	}

	if (command.length === 0) {
		throw new Error('Missing command after --.');
	}

	return { quality, command };
}

async function listFiles(root) {
	const files = [];

	/**
	 * @param {string} current
	 */
	async function walk(current) {
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			files.push(path.relative(root, entryPath));
		}
	}

	await walk(root);
	return files;
}

/**
 * Stages generated mixin files into the repo and returns a restore callback.
 *
 * @param {string} quality
 */
async function stageMixin(quality) {
	const mixinRoot = path.join(repoRoot, '.build', 'distro', 'mixin', quality);
	const files = await listFiles(mixinRoot);
	const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-stage-'));
	const createdFiles = [];

	for (const relativePath of files) {
		const sourcePath = path.join(mixinRoot, relativePath);
		const targetPath = path.join(repoRoot, relativePath);
		const backupPath = path.join(backupRoot, relativePath);

		await fs.mkdir(path.dirname(backupPath), { recursive: true });
		try {
			await fs.copyFile(targetPath, backupPath);
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */(error).code !== 'ENOENT') {
				throw error;
			}
			createdFiles.push(targetPath);
		}

		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.copyFile(sourcePath, targetPath);
	}

	return async () => {
		for (const relativePath of files) {
			const targetPath = path.join(repoRoot, relativePath);
			const backupPath = path.join(backupRoot, relativePath);
			try {
				await fs.copyFile(backupPath, targetPath);
			} catch (error) {
				if (/** @type {NodeJS.ErrnoException} */(error).code !== 'ENOENT') {
					throw error;
				}
			}
		}

		for (const filePath of createdFiles) {
			await fs.rm(filePath, { force: true });
		}

		await fs.rm(backupRoot, { recursive: true, force: true });
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { quality, command } = parseArgs(process.argv.slice(2));
	const restore = await stageMixin(quality);

	let restored = false;
	const restoreOnce = async () => {
		if (!restored) {
			restored = true;
			await restore();
		}
	};

	try {
		await new Promise((resolve, reject) => {
			const child = spawn(command[0], command.slice(1), {
				cwd: repoRoot,
				stdio: 'inherit',
				shell: process.platform === 'win32'
			});

			const forwardSignal = signal => {
				if (!child.killed) {
					child.kill(signal);
				}
			};

			for (const signal of ['SIGINT', 'SIGTERM']) {
				process.on(signal, forwardSignal);
			}

			child.on('error', reject);
			child.on('exit', code => {
				if (code === 0) {
					resolve(undefined);
					return;
				}
				reject(new Error(`${command[0]} exited with code ${code ?? 'null'}.`));
			});
		});
	} finally {
		await restoreOnce();
	}
}
