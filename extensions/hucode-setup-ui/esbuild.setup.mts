/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds the Hucode setup renderer into `media/`.
 *
 * The shared webview esbuild path does not compile Tailwind directives, so a small local plugin
 * runs PostCSS with `@tailwindcss/postcss` over the one CSS entry point. Nothing else about the
 * build differs from the other extension media bundles.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type esbuild from 'esbuild';
import { run } from '../esbuild-webview-common.mts';

const packageDir = import.meta.dirname;
const srcDir = path.join(packageDir, 'src');
const outDir = path.join(packageDir, 'media');
const repoRoot = path.join(packageDir, '..', '..');

/** Compiles Tailwind for the renderer's single stylesheet entry point. */
const tailwindPlugin: esbuild.Plugin = {
	name: 'hucode-tailwind',
	setup(build) {
		build.onLoad({ filter: /\.css$/ }, async args => {
			const [{ default: postcss }, { default: tailwind }] = await Promise.all([
				import('postcss'),
				import('@tailwindcss/postcss'),
			]);
			const css = await fs.readFile(args.path, 'utf8');
			const result = await postcss([tailwind()]).process(css, { from: args.path });
			return {
				contents: result.css,
				loader: 'css',
				// Tailwind scans the renderer sources for utility usage, so a component change has
				// to invalidate the stylesheet too.
				watchDirs: [srcDir],
			};
		});
	},
};

/** Keeps the tracked protocol mirror byte-identical to core before anything compiles it. */
function syncProtocol(): void {
	const script = path.join(repoRoot, 'build', 'hucode', 'setup-ui-protocol.ts');
	const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
	if (result.status !== 0) {
		throw new Error('Failed to synchronize the setup UI protocol mirror.');
	}
}

run({
	entryPoints: {
		'index': path.join(srcDir, 'import', 'index.tsx'),
		'style': path.join(srcDir, 'styles', 'setup.css'),
	},
	srcDir,
	outdir: outDir,
	beforeBuild: syncProtocol,
	additionalOptions: {
		define: {
			'process.env.NODE_ENV': '"production"',
		},
		plugins: [tailwindPlugin],
	},
}, process.argv);
