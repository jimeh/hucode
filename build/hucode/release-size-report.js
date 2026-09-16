/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function printHelp() {
	console.log(`Usage: node build/hucode/release-size-report.js [options]

Reports packaged Hucode app sizes and warns on release size regressions.

Options:
--app <path>      Packaged app output directory. Defaults to ../VSCode-*.
--arch <arch>     Target architecture. Defaults to the host arch.
--markdown-out <path> Markdown report path.
--out <path>      JSON report path.
--platform <name> Target platform. Defaults to the host platform.
--copilot-node-modules-warn-mb <mb> Warn above this Copilot node_modules size.
--copilot-node-modules-fail-mb <mb> Fail above this Copilot node_modules size.
-h, --help        Show this help.
`);
}

function parseArgs(args) {
	const options = {
		app: undefined,
		arch: process.arch,
		markdownOut: undefined,
		out: undefined,
		platform: process.platform,
		copilotNodeModulesWarnBytes: undefined,
		copilotNodeModulesFailBytes: undefined,
		help: false
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case '--app':
				options.app = path.resolve(repoRoot, readValue(args, ++index, arg));
				break;
			case '--arch':
				options.arch = readValue(args, ++index, arg);
				break;
			case '--markdown-out':
				options.markdownOut = path.resolve(repoRoot, readValue(args, ++index, arg));
				break;
			case '--out':
				options.out = path.resolve(repoRoot, readValue(args, ++index, arg));
				break;
			case '--platform':
				options.platform = readValue(args, ++index, arg);
				break;
			case '--copilot-node-modules-warn-mb':
				options.copilotNodeModulesWarnBytes = readMegabytes(
					readValue(args, ++index, arg),
					arg
				);
				break;
			case '--copilot-node-modules-fail-mb':
				options.copilotNodeModulesFailBytes = readMegabytes(
					readValue(args, ++index, arg),
					arg
				);
				break;
			case '-h':
			case '--help':
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option '${arg}'.`);
		}
	}

	if (!options.app) {
		options.app = path.resolve(
			repoRoot,
			'..',
			`VSCode-${options.platform}-${options.arch}`
		);
	}

	return options;
}

function readValue(args, index, option) {
	const value = args[index];
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${option}.`);
	}

	return value;
}

function readMegabytes(value, option) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`Invalid megabyte value for ${option}: ${value}`);
	}

	return Math.round(number * 1024 * 1024);
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findFirstDirectory(root, predicate, depth = 0) {
	if (depth > 8) {
		return undefined;
	}

	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const entryPath = path.join(root, entry.name);
		if (await predicate(entryPath)) {
			return entryPath;
		}

		const nested = await findFirstDirectory(entryPath, predicate, depth + 1);
		if (nested) {
			return nested;
		}
	}

	return undefined;
}

async function isAppResourceRoot(candidate) {
	return (await exists(path.join(candidate, 'product.json')))
		&& (await exists(path.join(candidate, 'package.json')));
}

async function resolveAppPaths(appPath, platform) {
	if (!(await exists(appPath))) {
		throw new Error(`App output not found: ${appPath}`);
	}

	if (await isAppResourceRoot(appPath)) {
		return {
			appRoot: appPath,
			resourcesApp: appPath
		};
	}

	const directResourcesApp = path.join(appPath, 'resources', 'app');
	if (await isAppResourceRoot(directResourcesApp)) {
		return {
			appRoot: appPath,
			resourcesApp: directResourcesApp
		};
	}

	const darwinResourcesApp = path.join(appPath, 'Contents', 'Resources', 'app');
	if (await isAppResourceRoot(darwinResourcesApp)) {
		return {
			appRoot: appPath,
			resourcesApp: darwinResourcesApp
		};
	}

	const resourceRoot = await findFirstDirectory(
		appPath,
		candidate => isAppResourceRoot(candidate)
	);
	if (!resourceRoot) {
		throw new Error(`Could not find resources/app under ${appPath}`);
	}

	const appRoot = platform === 'darwin'
		? await findDarwinAppRoot(resourceRoot, appPath)
		: appPath;

	return {
		appRoot,
		resourcesApp: resourceRoot
	};
}

async function findDarwinAppRoot(resourceRoot, fallbackRoot) {
	let current = resourceRoot;
	while (current && current !== path.dirname(current)) {
		if (path.basename(current).endsWith('.app')) {
			return current;
		}

		current = path.dirname(current);
	}

	return fallbackRoot;
}

async function directorySize(root) {
	if (!(await exists(root))) {
		return 0;
	}

	const stats = await fs.lstat(root);
	if (!stats.isDirectory()) {
		return stats.size;
	}

	const entries = await fs.readdir(root, { withFileTypes: true });
	let total = 0;
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		const entryStats = await fs.lstat(entryPath);
		if (entryStats.isSymbolicLink()) {
			total += entryStats.size;
			continue;
		}

		if (entryStats.isDirectory()) {
			total += await directorySize(entryPath);
			continue;
		}

		total += entryStats.size;
	}

	return total;
}

async function sourceMapStats(root) {
	if (!(await exists(root))) {
		return { count: 0, bytes: 0 };
	}

	const entries = await fs.readdir(root, { withFileTypes: true });
	let count = 0;
	let bytes = 0;

	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await sourceMapStats(entryPath);
			count += nested.count;
			bytes += nested.bytes;
			continue;
		}

		if (!entry.isFile() || !entry.name.endsWith('.map')) {
			continue;
		}

		const stats = await fs.stat(entryPath);
		count++;
		bytes += stats.size;
	}

	return { count, bytes };
}

async function measureArea(key, label, areaPath) {
	return {
		key,
		label,
		path: areaPath,
		exists: await exists(areaPath),
		bytes: await directorySize(areaPath)
	};
}

function mib(bytes) {
	return bytes / 1024 / 1024;
}

function formatMib(bytes) {
	return `${mib(bytes).toFixed(1)} MiB`;
}

function relativeToRepo(filePath) {
	return path.relative(repoRoot, filePath) || '.';
}

function warningCommand(message) {
	const escaped = message
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A');

	return `::warning title=Hucode release size::${escaped}`;
}

function createReport(options, appPaths, areas, sourceMaps, guardrails) {
	return {
		generatedAt: new Date().toISOString(),
		platform: options.platform,
		arch: options.arch,
		appPath: appPaths.appRoot,
		resourcesAppPath: appPaths.resourcesApp,
		sizes: Object.fromEntries(areas.map(area => [
			area.key,
			{
				label: area.label,
				path: area.path,
				exists: area.exists,
				bytes: area.bytes,
				mib: Number(mib(area.bytes).toFixed(1))
			}
		])),
		sourceMaps: {
			count: sourceMaps.count,
			bytes: sourceMaps.bytes,
			mib: Number(mib(sourceMaps.bytes).toFixed(1))
		},
		guardrails
	};
}

function createMarkdown(report) {
	const lines = [
		`# Hucode Release Size Report (${report.platform}-${report.arch})`,
		'',
		`Generated: ${report.generatedAt}`,
		'',
		'| Area | Size | Path |',
		'| --- | ---: | --- |'
	];

	for (const area of Object.values(report.sizes)) {
		lines.push(
			`| ${area.label} | ${formatMib(area.bytes)} | ` +
			`${relativeToRepo(area.path)} |`
		);
	}

	lines.push(
		'',
		'| Metric | Count | Size |',
		'| --- | ---: | ---: |',
		`| Source maps | ${report.sourceMaps.count} | ` +
			`${formatMib(report.sourceMaps.bytes)} |`,
		'',
		'## Guardrails',
		''
	);

	if (!report.guardrails.warnings.length && !report.guardrails.failures.length) {
		lines.push('- No size guardrails triggered.');
	}

	for (const warning of report.guardrails.warnings) {
		lines.push(`- Warning: ${warning}`);
	}

	for (const failure of report.guardrails.failures) {
		lines.push(`- Failure: ${failure}`);
	}

	lines.push('');
	return `${lines.join('\n')}\n`;
}

function printConsoleReport(report) {
	console.log(`Hucode release size report: ${report.platform}-${report.arch}`);
	for (const area of Object.values(report.sizes)) {
		console.log(`  ${area.label}: ${formatMib(area.bytes)}`);
	}

	console.log(
		`  Source maps: ${report.sourceMaps.count} files, ` +
		formatMib(report.sourceMaps.bytes)
	);
}

function evaluateGuardrails(options, areas) {
	const warnings = [];
	const failures = [];
	const copilotNodeModules = areas.find(area => area.key === 'copilotNodeModules');

	if (!copilotNodeModules?.exists) {
		warnings.push('Copilot node_modules directory was not found.');
		return { warnings, failures };
	}

	const size = copilotNodeModules.bytes;
	if (
		options.copilotNodeModulesFailBytes !== undefined
		&& size > options.copilotNodeModulesFailBytes
	) {
		failures.push(
			`Copilot node_modules is ${formatMib(size)}, above fail threshold ` +
			formatMib(options.copilotNodeModulesFailBytes)
		);
	}

	if (
		options.copilotNodeModulesWarnBytes !== undefined
		&& size > options.copilotNodeModulesWarnBytes
	) {
		warnings.push(
			`Copilot node_modules is ${formatMib(size)}, above warn threshold ` +
			formatMib(options.copilotNodeModulesWarnBytes)
		);
	}

	return { warnings, failures };
}

async function writeText(filePath, contents) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, contents, 'utf8');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const appPaths = await resolveAppPaths(options.app, options.platform);
	const resourcesApp = appPaths.resourcesApp;
	const copilotRoot = path.join(resourcesApp, 'extensions', 'copilot');
	const areas = [
		await measureArea('app', 'App total', appPaths.appRoot),
		await measureArea('resourcesApp', 'resources/app', resourcesApp),
		await measureArea('out', 'resources/app/out', path.join(resourcesApp, 'out')),
		await measureArea(
			'extensions',
			'resources/app/extensions',
			path.join(resourcesApp, 'extensions')
		),
		await measureArea('copilot', 'Copilot extension', copilotRoot),
		await measureArea(
			'copilotNodeModules',
			'Copilot node_modules',
			path.join(copilotRoot, 'node_modules')
		),
		await measureArea(
			'appNodeModules',
			'App node_modules',
			path.join(resourcesApp, 'node_modules')
		)
	];
	const sourceMaps = await sourceMapStats(resourcesApp);
	const guardrails = evaluateGuardrails(options, areas);
	const report = createReport(options, appPaths, areas, sourceMaps, guardrails);
	const markdown = createMarkdown(report);

	printConsoleReport(report);

	for (const warning of guardrails.warnings) {
		if (process.env.GITHUB_ACTIONS) {
			console.log(warningCommand(warning));
		} else {
			console.warn(`Warning: ${warning}`);
		}
	}

	for (const failure of guardrails.failures) {
		console.error(`Failure: ${failure}`);
	}

	if (options.out) {
		await writeText(options.out, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`Hucode size report JSON: ${options.out}`);
	}

	if (options.markdownOut) {
		await writeText(options.markdownOut, markdown);
		console.log(`Hucode size report Markdown: ${options.markdownOut}`);
	}

	if (process.env.GITHUB_STEP_SUMMARY) {
		await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
	}

	if (guardrails.failures.length) {
		process.exit(1);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
