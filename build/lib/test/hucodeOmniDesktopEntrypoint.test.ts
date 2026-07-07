/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

const workbenchDesktopMain = 'src/vs/workbench/workbench.desktop.main.ts';
const omniDesktopMain = 'src/vs/hucode/omni.desktop.main.ts';
const workbenchDesktopBootstrap =
	'src/vs/workbench/electron-browser/desktop.main.ts';
const omniDesktopBootstrap = 'src/vs/hucode/electron-browser/omni.main.ts';

/**
 * Imports present in `workbench.desktop.main.ts` that Omni's desktop
 * entrypoint intentionally does not track. Every entry needs a reason; a new
 * upstream import that is not listed here must be added to
 * `omni.desktop.main.ts` or documented below.
 */
const omittedFromOmniDesktop = new Map([
	[
		'src/vs/workbench/workbench.common.main.js',
		'Omni loads its own common entrypoint (omni.common.main.js).',
	],
	[
		'src/vs/workbench/electron-browser/desktop.main.js',
		'Omni boots through omni.main.js instead of DesktopMain.',
	],
	[
		'src/vs/workbench/services/title/electron-browser/titleService.js',
		'Omni registers its own titlebar service in its workbench shell.',
	],
	[
		'src/vs/workbench/services/workspaces/electron-browser/workspaceEditingService.js',
		'OmniWorkspaceContextService covers workspace editing for Omni.',
	],
	[
		'src/vs/workbench/services/agentHost/electron-browser/agentHostService.js',
		'Omni registers OmniAgentHostService instead.',
	],
	[
		'src/vs/platform/agentHost/electron-browser/remoteAgentHostService.js',
		'Omni registers the null remote-agent-host service.',
	],
	[
		'src/vs/platform/agentHost/electron-browser/sshRemoteAgentHostService.js',
		'Omni registers the null remote-agent-host service.',
	],
	[
		'src/vs/workbench/contrib/extensions/electron-browser/devtoolsExtensionHost.contribution.js',
		'DevTools extension host UI is not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/chat/electron-browser/chat.contribution.js',
		'Desktop chat UI is not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/agentsVoice/electron-browser/agentsVoiceNativeCommands.js',
		'Agents voice commands are not part of Omni.',
	],
	[
		'src/vs/workbench/contrib/mcp/electron-browser/mcp.contribution.js',
		'MCP desktop UI is not part of Omni.',
	],
	[
		'src/vs/hucode/browser/hostedOmniWorkspace.contribution.js',
		'Applies to hosted workbench windows, not the Omni shell itself.',
	],
]);

/**
 * Imports Omni's desktop entrypoint adds on top of the upstream desktop
 * entrypoint.
 */
const addedByOmniDesktop = new Map([
	[
		'src/vs/hucode/omni.common.main.js',
		'Omni common entrypoint.',
	],
	[
		'src/vs/hucode/electron-browser/omni.main.js',
		'Omni desktop bootstrap.',
	],
	[
		'src/vs/hucode/browser/paneCompositePartService.js',
		'Omni pane composite part service.',
	],
	[
		'src/vs/hucode/electron-browser/omniCommandService.js',
		'Omni command service.',
	],
	[
		'src/vs/hucode/browser/omniWindowUI.js',
		'Omni window UI contribution.',
	],
	[
		'src/vs/hucode/browser/omniProjectsSidebarActions.js',
		'Omni Projects sidebar actions.',
	],
	[
		'src/vs/platform/agentHost/common/agentService.js',
		'IAgentHostService wiring for OmniAgentHostService.',
	],
	[
		'src/vs/hucode/browser/services/omniAgentHostService.js',
		'Omni agent host service implementation.',
	],
	[
		'src/vs/workbench/contrib/chat/browser/agentSessions/experiments/agentTitleBarStatusService.js',
		'Omni registers the agent titlebar status service explicitly.',
	],
	[
		'src/vs/hucode/browser/projectSwitcher/createProjectWorktree.contribution.js',
		'Omni project switcher contribution.',
	],
	[
		'src/vs/hucode/browser/projectSwitcher/renameProjectWorktree.contribution.js',
		'Omni project switcher contribution.',
	],
	[
		'src/vs/hucode/browser/projectSwitcher/projectSwitcher.contribution.js',
		'Omni project switcher contribution.',
	],
	[
		'src/vs/hucode/browser/layoutActions.js',
		'Omni layout actions.',
	],
	[
		'src/vs/hucode/browser/omniHost.contribution.js',
		'Omni host part contribution.',
	],
]);

/**
 * Imports present in upstream `desktop.main.ts` (the DesktopMain bootstrap
 * Omni forks) that `omni.main.ts` intentionally does not track. New upstream
 * bootstrap imports usually indicate new service wiring that Omni must
 * mirror; list an import here only with a concrete reason.
 */
const omittedFromOmniBootstrap = new Map([
	[
		'src/vs/workbench/browser/workbench.js',
		'Omni instantiates its own workbench shell (hucode/browser/workbench.js).',
	],
	[
		'src/vs/workbench/services/configuration/browser/configurationService.js',
		'Omni uses OmniConfigurationService instead of WorkspaceService.',
	],
	[
		'src/vs/workbench/services/configuration/common/configurationCache.js',
		'Only needed by WorkspaceService, which Omni does not use.',
	],
	[
		'src/vs/platform/policy/common/copilotManagedSettingsIpc.js',
		'Omni builds its account policy service without the Copilot managed-settings channel.',
	],
]);

/**
 * Imports Omni's bootstrap adds on top of upstream DesktopMain.
 */
const addedByOmniBootstrap = new Map([
	[
		'src/vs/hucode/browser/workbench.js',
		'The Omni workbench shell.',
	],
	[
		'src/vs/workbench/electron-browser/parts/titlebar/menubarControl.js',
		'Omni creates the native menubar control for its titlebar.',
	],
	[
		'src/vs/workbench/services/workspaces/common/workspaceEditing.js',
		'OmniWorkspaceContextService is registered as IWorkspaceEditingService.',
	],
	[
		'src/vs/hucode/browser/services/configuration/omniConfigurationService.js',
		'Omni configuration service.',
	],
	[
		'src/vs/hucode/browser/services/workspace/omniWorkspaceContextService.js',
		'Omni workspace context service.',
	],
	[
		'src/vs/platform/workspaces/common/workspaceIdentifier.js',
		'Omni resolves its workspace identifier directly.',
	],
	[
		'src/vs/hucode/common/omniWindow.js',
		'Hucode shell service channel wiring.',
	],
	[
		'src/vs/workbench/services/lifecycle/common/lifecycle.js',
		'Omni consumes ShutdownReason for its lifecycle handling.',
	],
	[
		'src/vs/workbench/services/extensions/common/hucodeExtensionEnablementPolicy.js',
		'Omni exposes the Hucode extension enablement policy.',
	],
]);

suite('Hucode Omni desktop entrypoints', () => {

	test('omni.desktop.main tracks workbench.desktop.main imports except documented deltas', async () => {
		await assertImportContract(
			workbenchDesktopMain,
			omniDesktopMain,
			omittedFromOmniDesktop,
			addedByOmniDesktop
		);
	});

	test('omni.main tracks the DesktopMain bootstrap imports except documented deltas', async () => {
		await assertImportContract(
			workbenchDesktopBootstrap,
			omniDesktopBootstrap,
			omittedFromOmniBootstrap,
			addedByOmniBootstrap
		);
	});
});

async function assertImportContract(
	upstreamEntrypoint: string,
	omniEntrypoint: string,
	omittedFromOmni: Map<string, string>,
	addedByOmni: Map<string, string>
): Promise<void> {
	const upstreamImports = await readImportPaths(upstreamEntrypoint);
	const omniImports = await readImportPaths(omniEntrypoint);

	const expectedOmniImports = new Set(
		[...upstreamImports].filter(
			importPath => !omittedFromOmni.has(importPath)
		)
	);
	for (const importPath of addedByOmni.keys()) {
		expectedOmniImports.add(importPath);
	}

	assert.deepStrictEqual(
		{
			staleOmissions: setDifference(
				new Set(omittedFromOmni.keys()),
				upstreamImports
			),
			staleAdditions: setDifference(
				new Set(addedByOmni.keys()),
				omniImports
			),
			missingFromOmni: setDifference(expectedOmniImports, omniImports),
			undocumentedInOmni: setDifference(
				omniImports,
				expectedOmniImports
			),
		},
		{
			staleOmissions: [],
			staleAdditions: [],
			missingFromOmni: [],
			undocumentedInOmni: [],
		},
		`Omni import contract: ${omniEntrypoint} vs ${upstreamEntrypoint}`
	);
}

/**
 * Collects the canonical module paths of all static imports in an
 * entrypoint. Unlike the common-entrypoint test this tolerates imports that
 * wrap across lines, which the Hucode bootstrap files use to keep lines
 * within 80 columns.
 */
async function readImportPaths(entrypoint: string): Promise<Set<string>> {
	const source = stripComments(
		await fs.readFile(path.join(repoRoot, entrypoint), 'utf8')
	);
	const importerDirectory = path.posix.dirname(entrypoint);
	const paths = new Set<string>();

	// Static imports only: the `[^'"()]` class stops the match at dynamic
	// `import(...)` calls and at any other parenthesised code.
	const importPattern = /\bimport\b[^'"()]*?['"](?<modulePath>[^'"]+)['"]/g;
	for (const match of source.matchAll(importPattern)) {
		const modulePath = match.groups!.modulePath;
		paths.add(
			modulePath.startsWith('.')
				? path.posix.normalize(
					path.posix.join(importerDirectory, modulePath)
				)
				: modulePath
		);
	}

	return paths;
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
	return [...left].filter(value => !right.has(value)).sort();
}
