/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import path from 'path';
import * as ts from 'typescript';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);

const appPath = 'src/vs/code/electron-main/app.ts';
const eslintConfigPath = 'eslint.config.js';
const sharedContractPath = 'src/vs/hucode/common/omniWindow.ts';
const mainContractPath = 'src/vs/hucode/electron-main/omniWindow.ts';
const desktopCompositionRootPath =
	'src/vs/hucode/electron-browser/omniWindowService.ts';
const omniDesktopMainPath = 'src/vs/hucode/omni.desktop.main.ts';
const workbenchDesktopMainPath = 'src/vs/workbench/workbench.desktop.main.ts';

suite('Hucode desktop shell authority boundary', () => {
	test('does not publish the complete shell service as global IPC', async () => {
		const sourceFiles = await collectTypeScriptFiles(
			path.join(repoRoot, 'src', 'vs')
		);
		const oldChannelReferences: string[] = [];
		for (const file of sourceFiles) {
			const source = await fs.readFile(file, 'utf8');
			if (/\bHUCODE_SHELL_CHANNEL_NAME\b|(['"])hucodeShell\1/.test(source)) {
				oldChannelReferences.push(path.relative(repoRoot, file));
			}
		}
		assert.deepStrictEqual(oldChannelReferences, []);

		const app = await readSource(appPath);
		const { sourceFile: appSourceFile, method: initChannels } = findClassMethod(
			app,
			'CodeApplication',
			'initChannels'
		);
		assert.deepStrictEqual(
			initChannels.parameters.map(parameter => parameter.name.getText()),
			['accessor', 'mainProcessElectronServer', 'sharedProcessClient']
		);
		const forbiddenAliases = collectIdentifierAliases(appSourceFile, [
			'HucodeShellMainService',
			'IHucodeShellMainService',
		]);
		const forbiddenIdentifiers = collectIdentifiers(initChannels).filter(
			identifier => forbiddenAliases.has(identifier) || [
				'HucodeShellMainService',
				'IHucodeShellMainService',
				'hucodeShellMainService',
			].includes(identifier)
		);
		assert.deepStrictEqual(forbiddenIdentifiers, []);
		assert.deepStrictEqual(
			collectUnsafeParameterUses(
				initChannels,
				'mainProcessElectronServer'
			),
			[]
		);
	});

	test('keeps the complete desktop service on an independent main decorator',
		async () => {
			const mainContract = await readSource(mainContractPath);
			assert.match(
				mainContract,
				/createDecorator<IHucodeShellMainService>\(\s*['"]hucodeShellMainService['"]/
			);
			assert.doesNotMatch(mainContract, /refineServiceDecorator/);

			const sharedContract = await readSource(sharedContractPath);
			assert.match(
				sharedContract,
				/createDecorator<IHucodeShellService>\(['"]hucodeShellService['"]\)/
			);
		}
	);

	test('desktop entrypoints register only the narrow shell adapters', async () => {
		const compositionRoot = await readSource(desktopCompositionRootPath);
		assert.match(
			compositionRoot,
			/\.\/hostedShellServiceAdapter\.js/
		);
		assert.match(
			compositionRoot,
			/\.\/shellControllerServiceAdapter\.js/
		);
		assert.match(compositionRoot, /\.\/hucodeClipboardService\.js/);
		assert.doesNotMatch(compositionRoot, /registerMainProcessRemoteService/);
		assert.doesNotMatch(compositionRoot, /HUCODE_SHELL_CHANNEL_NAME/);

		for (const [entrypoint, compositionRootImport] of [
			[
				omniDesktopMainPath,
				'./electron-browser/omniWindowService.js',
			],
			[
				workbenchDesktopMainPath,
				'../hucode/electron-browser/omniWindowService.js',
			],
		] as const) {
			const source = await readSource(entrypoint);
			assert.match(source, new RegExp(escapeRegExp(compositionRootImport)));
			assert.doesNotMatch(source, /hostedShellServiceAdapter\.js/);
			assert.doesNotMatch(source, /shellControllerServiceAdapter\.js/);
		}

		const eslintConfig = await readSource(eslintConfigPath);
		assert.match(
			eslintConfig,
			/vs\/hucode\/electron-browser\/omniWindowService\.js/
		);
		assert.doesNotMatch(
			eslintConfig,
			/vs\/hucode\/electron-browser\/hostedShellServiceAdapter\.js/
		);
		assert.doesNotMatch(
			eslintConfig,
			/vs\/hucode\/electron-browser\/shellControllerServiceAdapter\.js/
		);

		const rendererFiles = (await collectTypeScriptFiles(
			path.join(repoRoot, 'src', 'vs')
		)).filter(file => file.split(path.sep).includes('electron-browser'));
		const fullServiceClients: string[] = [];
		for (const file of rendererFiles) {
			if ((await fs.readFile(file, 'utf8')).includes('IHucodeShellService')) {
				fullServiceClients.push(path.relative(repoRoot, file));
			}
		}
		assert.deepStrictEqual(fullServiceClients, []);
	});
});

async function readSource(relativePath: string): Promise<string> {
	return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectTypeScriptFiles(candidate));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			files.push(candidate);
		}
	}
	return files;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findClassMethod(
	source: string,
	className: string,
	methodName: string
): { sourceFile: ts.SourceFile; method: ts.MethodDeclaration } {
	const sourceFile = ts.createSourceFile(
		appPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	let result: ts.MethodDeclaration | undefined;
	for (const statement of sourceFile.statements) {
		if (!ts.isClassDeclaration(statement) ||
			statement.name?.text !== className) {
			continue;
		}
		result = statement.members.find(
			(member): member is ts.MethodDeclaration =>
				ts.isMethodDeclaration(member) &&
				member.name.getText(sourceFile) === methodName
		);
		break;
	}
	assert.ok(result, `${className}.${methodName} must exist`);
	return { sourceFile, method: result };
}

function collectIdentifiers(node: ts.Node): string[] {
	const identifiers: string[] = [];
	const visit = (child: ts.Node): void => {
		if (ts.isIdentifier(child)) {
			identifiers.push(child.text);
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return identifiers;
}

function collectIdentifierAliases(
	sourceFile: ts.SourceFile,
	canonicalNames: readonly string[]
): ReadonlySet<string> {
	const aliases = new Set(canonicalNames);
	let changed = true;
	while (changed) {
		changed = false;
		const visit = (node: ts.Node): void => {
			if (ts.isImportSpecifier(node) &&
				node.propertyName && aliases.has(node.propertyName.text) &&
				!aliases.has(node.name.text)) {
				aliases.add(node.name.text);
				changed = true;
			} else if (ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer && ts.isIdentifier(node.initializer) &&
				aliases.has(node.initializer.text) &&
				!aliases.has(node.name.text)) {
				aliases.add(node.name.text);
				changed = true;
			} else if (ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left) && ts.isIdentifier(node.right) &&
				aliases.has(node.right.text) && !aliases.has(node.left.text)) {
				aliases.add(node.left.text);
				changed = true;
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return aliases;
}

function collectUnsafeParameterUses(
	method: ts.MethodDeclaration,
	parameterName: string
): string[] {
	const unsafeUses: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === parameterName) {
			const parent = node.parent;
			const isDeclaration = ts.isParameter(parent) && parent.name === node;
			const isDirectRegistration = ts.isPropertyAccessExpression(parent) &&
				parent.expression === node && parent.name.text === 'registerChannel';
			const isReviewedGateway = ts.isNewExpression(parent) &&
				parent.expression.getText() === 'McpGatewayChannel' &&
				parent.arguments?.includes(node);
			if (!isDeclaration && !isDirectRegistration && !isReviewedGateway) {
				unsafeUses.push(parent.getText().slice(0, 120));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(method);
	return unsafeUses;
}
