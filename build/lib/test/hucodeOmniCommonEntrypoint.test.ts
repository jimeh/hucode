/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);

const workbenchCommonMain = 'src/vs/workbench/workbench.common.main.ts';
const omniCommonMain = 'src/vs/hucode/omni.common.main.ts';
const workbenchHtml = 'src/vs/code/electron-browser/workbench/workbench.html';
const workbenchDevHtml = 'src/vs/code/electron-browser/workbench/workbench-dev.html';
const omniHtml = 'src/vs/hucode/electron-browser/omni.html';
const omniDevHtml = 'src/vs/hucode/electron-browser/omni-dev.html';

const omittedFromOmni = new Map([
	[
		'src/vs/workbench/common/agentsColors.js',
		'Sessions-window theming only.',
	],
	[
		'src/vs/workbench/common/agentsSizes.js',
		'Sessions-window layout sizing only.',
	],
	[
		'src/vs/workbench/services/policies/browser/accountPolicyGate.contribution.js',
		'Account policy gate expects bootstrap state Omni does not provide.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/agentSessions/agentSessions.contribution.js',
		'Registers the local Agent Sessions provider Omni deliberately avoids.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHost.contribution.js',
		'Registers the standard Agent Host integration replaced by Omni services.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/remoteAgentHost/remoteAgentHost.contribution.js',
		'Registers remote Agent Host and cloud sandbox integration that Omni keeps inert.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/chat.view.contribution.js',
		'Chat view UI is not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/mcp/browser/mcp.view.contribution.js',
		'MCP view UI is not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/remoteCodingAgents/browser/remoteCodingAgents.contribution.js',
		'Remote coding agent UI is not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/editorWindow/editorWindowSessions.contribution.js',
		'Registers the editor-window Agent Sessions services Omni deliberately avoids.',
	],
	[
		'src/vs/workbench/contrib/sessionChanges/browser/sessionChanges.contribution.js',
		'Changeset picker for the editor-window Agent Sessions Changes editor, which Omni omits.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/sessionInputBanners/sessionWorktreeCleanup.contribution.js',
		'Agent session storage cleanup for the editor-window Agent Sessions Omni deliberately avoids.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/chatView/chatViewOpenInChatPart.contribution.js',
		'Opens chat views in the editor-window chat part, which Omni does not render.',
	],
	[
		'src/vs/workbench/contrib/sessions/providers/agentsView/browser/agentsViewProviders.contribution.js',
		'Registers an editor-window Agent Sessions service Omni deliberately avoids.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostWorktree.contribution.js',
		'Editor-window worktree support for the standard Agent Host integration replaced by Omni services.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/agentsView/agentHostWorktreeComposerFolders.js',
		'Editor-window Agent Host worktree composer folders; Omni replaces the Agent Host integration.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/agentsView/agentHostWorktreeChatResolver.contribution.js',
		'Resolves editor-window Agent Host worktree chats; Omni replaces the Agent Host integration.',
	],
	[
		'src/vs/workbench/contrib/sessions/browser/chatView/chatViewSessionsList.contribution.js',
		'Sessions list inside the chat view, which Omni does not render.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/onboarding/agentPickerSpotlight.contribution.js',
		'Agent picker onboarding targets chat UI that Omni does not render.',
	],
	[
		'src/vs/workbench/contrib/workspaces/browser/folderLocationWorkingSets.contribution.js',
		'Folder-location working sets apply to single-folder workspaces; the Omni shell has no workspace folder.',
	],
]);

const addedByOmni = new Map([
	[
		'src/vs/platform/agentHost/common/remoteAgentHostService.js',
		'Provides the null remote-agent-host service registration.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsService.js',
		'Provides the Agent Sessions service without registering a provider.',
	],
]);

interface ImportRecord {
	readonly canonical: string;
	readonly normalizedStatement: string;
}

suite('Hucode Omni common entrypoint', () => {

	test('tracks upstream common workbench imports except documented deltas', async () => {
		const workbenchImports = await readImportRecords(workbenchCommonMain);
		const omniImports = await readImportRecords(omniCommonMain);

		const upstreamImportPaths = new Set(
			workbenchImports.map(importRecord => importRecord.canonical)
		);
		const omniImportPaths = new Set(
			omniImports.map(importRecord => importRecord.canonical)
		);

		const expectedOmniImports = new Set(
			workbenchImports
				.map(importRecord => importRecord.canonical)
				.filter(importPath => !omittedFromOmni.has(importPath))
		);
		for (const importPath of addedByOmni.keys()) {
			expectedOmniImports.add(importPath);
		}

		const workbenchSharedImports = sharedImportStatements(
			workbenchImports,
			omittedFromOmni
		);

		assert.deepStrictEqual(
			{
				staleOmissions: setDifference(
					new Set(omittedFromOmni.keys()),
					upstreamImportPaths
				),
				staleAdditions: setDifference(
					new Set(addedByOmni.keys()),
					omniImportPaths
				),
				missingFromOmni: setDifference(expectedOmniImports, omniImportPaths),
				undocumentedInOmni: setDifference(omniImportPaths, expectedOmniImports),
				sharedImports: sharedImportStatements(omniImports, addedByOmni),
			},
			{
				staleOmissions: [],
				staleAdditions: [],
				missingFromOmni: [],
				undocumentedInOmni: [],
				sharedImports: workbenchSharedImports,
			},
			'Omni import contract'
		);
	});

	test('tracks upstream trusted type policies', async () => {
		assert.deepStrictEqual(
			{
				omni: await readTrustedTypes(omniHtml),
				omniDev: await readTrustedTypes(omniDevHtml),
			},
			{
				omni: await readTrustedTypes(workbenchHtml),
				omniDev: await readTrustedTypes(workbenchDevHtml),
			},
			'Omni trusted type policy contract'
		);
	});
});

async function readImportRecords(entrypoint: string): Promise<ImportRecord[]> {
	const source = await fs.readFile(path.join(repoRoot, entrypoint), 'utf8');
	const importerDirectory = path.posix.dirname(entrypoint);
	const records: ImportRecord[] = [];

	for (const [index, line] of source.split(/\r?\n/).entries()) {
		const trimmedLine = line.trim();
		const match = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"];?$/
			.exec(trimmedLine);
		if (!match) {
			if (/^import\b/.test(trimmedLine)) {
				throw new Error(
					`Unsupported import form in ${entrypoint}:${index + 1}`
				);
			}

			continue;
		}

		const canonical = canonicalImportPath(importerDirectory, match[1]);
		records.push({
			canonical,
			normalizedStatement: trimmedLine.replace(
				/(['"])([^'"]+)\1/,
				`'${canonical}'`
			),
		});
	}

	return records;
}

function canonicalImportPath(importerDirectory: string, importPath: string): string {
	if (!importPath.startsWith('.')) {
		return importPath;
	}

	return path.posix.normalize(path.posix.join(importerDirectory, importPath));
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
	return [...left].filter(value => !right.has(value)).sort();
}

function sharedImportStatements(
	importRecords: ImportRecord[],
	ignoredImports: Map<string, string>
): string[] {
	return importRecords
		.filter(importRecord => !ignoredImports.has(importRecord.canonical))
		.map(importRecord => importRecord.normalizedStatement);
}

async function readTrustedTypes(entrypoint: string): Promise<string[]> {
	const source = await fs.readFile(path.join(repoRoot, entrypoint), 'utf8');
	const match = /trusted-types\s+([\s\S]*?)\s*;/m.exec(source);
	if (!match) {
		throw new Error(`Missing trusted-types directive in ${entrypoint}`);
	}

	return match[1]
		.split(/\s+/)
		.map(policyName => policyName.trim())
		.filter(Boolean);
}
