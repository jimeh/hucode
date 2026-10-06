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
 * Pins one link in the chain, and only one: that `filterEnabledExtensions`
 * drops a disabled extension before `_resolveAndProcessExtensions` hands the
 * survivors to `_registry.deltaExtensions`.
 *
 * The hops after it — the registry delta, and the snapshot the extension host
 * is started from — stay uncovered. Driving `AbstractExtensionService` far
 * enough to assert on host membership trips the disposable leak checker,
 * because `LockableExtensionDescriptionRegistry` never registers its inner
 * `ExtensionDescriptionRegistry` (extensionDescriptionRegistry.ts:268) and
 * that only shows up once a test registers real extensions. Those hops are
 * upstream and shared by every extension, not specific to this filter.
 *
 * Whether the *enablement service* reaches the right verdict is not tested
 * here; the stubs below stand in for it deliberately, so a change to
 * `_computeEnablementState` will not be caught by this file. That belongs to
 * `extensionEnablementService.test.ts`, which drives the real service.
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
		// Consequence, and intended: running the shell in extension-development
		// mode does load vscode.git. `filterEnabledExtensions` exempts
		// `isUnderDevelopment` before consulting enablement at all.
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
			isEnabledEnablementState: isEnabledState,
		} as unknown as IWorkbenchExtensionEnablementService;
	}

	function aWorkbenchEnablementService(): IWorkbenchExtensionEnablementService {
		return {
			getEnablementStates: (extensions: IExtension[]) =>
				extensions.map(() => EnablementState.EnabledGlobally),
			isEnabledEnablementState: isEnabledState,
		} as unknown as IWorkbenchExtensionEnablementService;
	}

	// Mirrors ExtensionEnablementService.isEnabledEnablementState. Shared so
	// the two stubs differ only in the verdict they return, not in how a
	// verdict is read.
	function isEnabledState(state: EnablementState): boolean {
		return state === EnablementState.EnabledGlobally
			|| state === EnablementState.EnabledWorkspace
			|| state === EnablementState.EnabledByEnvironment;
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
