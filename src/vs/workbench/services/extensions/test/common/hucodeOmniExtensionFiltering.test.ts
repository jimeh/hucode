/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	ExtensionIdentifier,
	type IExtension,
	type IExtensionDescription,
} from '../../../../../platform/extensions/common/extensions.js';
import { toExtension } from '../../common/extensions.js';
import { filterEnabledExtensions } from '../../common/abstractExtensionService.js';
import {
	EnablementState,
	type IWorkbenchExtensionEnablementService,
} from '../../../extensionManagement/common/extensionManagement.js';
import { hucodeIsExtensionSkippedInOmniShell } from
	'../../common/hucodeExtensionEnablementPolicy.js';

/**
 * The Omni shell filter only stops extensions from activating because
 * `filterEnabledExtensions` drops disabled extensions before
 * `_resolveAndProcessExtensions` hands them to `_registry.deltaExtensions`,
 * and extension hosts are started from that registry. These tests pin that
 * link: enablement state alone is not the outcome anyone cares about.
 */
suite('HucodeOmniExtensionFiltering', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shell-skipped built-ins never reach the registry', () => {
		const copilotChat = aBuiltinExtension('GitHub.copilot-chat');
		const git = aBuiltinExtension('vscode.git');
		const themeDefaults = aBuiltinExtension('vscode.theme-defaults');

		const kept = filterEnabledExtensions(
			new NullLogService(),
			anOmniShellEnablementService(),
			[copilotChat, git, themeDefaults],
			false
		);

		assert.deepStrictEqual(
			kept.map(extension => extension.identifier.value),
			['vscode.theme-defaults']
		);
	});

	test('a workbench keeps every one of them', () => {
		const extensions = [
			aBuiltinExtension('GitHub.copilot-chat'),
			aBuiltinExtension('vscode.git'),
			aBuiltinExtension('vscode.theme-defaults'),
		];

		const kept = filterEnabledExtensions(
			new NullLogService(),
			aWorkbenchEnablementService(),
			extensions,
			false
		);

		assert.deepStrictEqual(
			kept.map(extension => extension.identifier.value),
			['GitHub.copilot-chat', 'vscode.git', 'vscode.theme-defaults']
		);
	});

	test('an extension under development is never filtered', () => {
		const underDevelopment = {
			...aBuiltinExtension('vscode.git'),
			isUnderDevelopment: true,
		};

		const kept = filterEnabledExtensions(
			new NullLogService(),
			anOmniShellEnablementService(),
			[underDevelopment],
			false
		);

		assert.deepStrictEqual(
			kept.map(extension => extension.identifier.value),
			['vscode.git']
		);
	});

	function aBuiltinExtension(id: string): IExtensionDescription {
		const [publisher, name] = id.split('.');
		return <IExtensionDescription>{
			identifier: new ExtensionIdentifier(id),
			extensionLocation: URI.parse(`file:///builtin/${id}`),
			isBuiltin: true,
			isUserBuiltin: false,
			isUnderDevelopment: false,
			name,
			publisher,
			version: '1.0.0',
			engines: { vscode: '*' },
			main: 'main.js',
		};
	}

	/**
	 * Stands in for `ExtensionEnablementService` in the shell, reusing the real
	 * predicate so this cannot drift from what that service actually decides.
	 */
	function anOmniShellEnablementService(): IWorkbenchExtensionEnablementService {
		return {
			getEnablementStates: (extensions: IExtension[]) => extensions.map(extension =>
				hucodeIsExtensionSkippedInOmniShell(extension)
					? EnablementState.DisabledByEnvironment
					: EnablementState.EnabledGlobally
			),
			isEnabledEnablementState: (state: EnablementState) =>
				state === EnablementState.EnabledGlobally
				|| state === EnablementState.EnabledWorkspace
				|| state === EnablementState.EnabledByEnvironment,
		} as unknown as IWorkbenchExtensionEnablementService;
	}

	function aWorkbenchEnablementService(): IWorkbenchExtensionEnablementService {
		return {
			getEnablementStates: (extensions: IExtension[]) =>
				extensions.map(() => EnablementState.EnabledGlobally),
			isEnabledEnablementState: (state: EnablementState) =>
				state === EnablementState.EnabledGlobally,
		} as unknown as IWorkbenchExtensionEnablementService;
	}

	// `toExtension` is what `filterEnabledExtensions` maps through before it
	// consults enablement, so the skip predicate must agree with its output.
	test('the predicate agrees with the mapping the filter applies', () => {
		assert.deepStrictEqual({
			builtin: hucodeIsExtensionSkippedInOmniShell(
				toExtension(aBuiltinExtension('vscode.git'))
			),
			unlisted: hucodeIsExtensionSkippedInOmniShell(
				toExtension(aBuiltinExtension('vscode.theme-defaults'))
			),
		}, {
			builtin: true,
			unlisted: false,
		});
	});
});
