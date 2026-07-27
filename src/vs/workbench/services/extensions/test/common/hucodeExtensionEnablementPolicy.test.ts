/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ExtensionType,
	type IExtension,
	type IExtensionManifest,
	TargetPlatform,
} from '../../../../../platform/extensions/common/extensions.js';
import type {
	IScannedExtension,
} from '../../../../../platform/extensionManagement/common/extensionsScannerService.js';
import {
	HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
	HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS,
	hucodeIsExtensionDisabledByPolicy,
	hucodeIsExtensionSkippedInOmniShell,
	hucodeIsOmniShellSkippedBuiltinId,
	hucodeShouldKeepScannedUserExtension,
} from '../../common/hucodeExtensionEnablementPolicy.js';

suite('HucodeExtensionEnablementPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not apply without explicit policy', () => {
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(aExtension('pub.a'), undefined, undefined),
			undefined
		);
	});

	test('disables user extension without theme contributions', () => {
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.a'),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			true
		);
	});

	test('allows user theme extensions with executable helpers', () => {
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.theme', {
					main: './extension.js',
					activationEvents: ['onStartupFinished'],
					contributes: {
						themes: [{ label: 'Theme' }]
					}
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
	});

	test('allows user file and product icon theme extensions', () => {
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.fileIcons', {
					contributes: {
						iconThemes: [{ label: 'File Icons' }]
					}
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.productIcons', {
					contributes: {
						productIconThemes: [{ label: 'Product Icons' }]
					}
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
	});

	test('allows built-in and resolver extensions', () => {
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension(
					'pub.builtin',
					undefined,
					ExtensionType.System
				),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.resolver', {
					activationEvents: ['onResolveRemoteAuthority:ssh-remote']
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				'ssh-remote+host'
			),
			false
		);
		assert.strictEqual(
			hucodeIsExtensionDisabledByPolicy(
				aExtension('pub.pendingResolver', {
					activationEvents: ['onResolveRemoteAuthority:ssh-remote']
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
	});

	test('skips the shell built-ins that caused the watcher exhaustion', () => {
		assert.deepStrictEqual({
			copilotChat: hucodeIsExtensionSkippedInOmniShell(
				aExtension('GitHub.copilot-chat', {}, ExtensionType.System)
			),
			git: hucodeIsExtensionSkippedInOmniShell(
				aExtension('vscode.git', {}, ExtensionType.System)
			),
			unlistedBuiltin: hucodeIsExtensionSkippedInOmniShell(
				aExtension('vscode.theme-defaults', {}, ExtensionType.System)
			),
		}, {
			copilotChat: true,
			git: true,
			unlistedBuiltin: false,
		});
	});

	test('leaves marketplace extensions to the theme-only policy', () => {
		assert.strictEqual(
			hucodeIsExtensionSkippedInOmniShell(
				aExtension('GitHub.copilot-chat', {}, ExtensionType.User)
			),
			false
		);
	});

	test('skips a user-installed builtin', () => {
		// `toExtension` sets `isBuiltin` from `isBuiltin || isUserBuiltin` while
		// deriving `type` from `isBuiltin` alone, so an extension installed with
		// --install-builtin-extension arrives as User *and* builtin. The
		// predicate keys off `isBuiltin`, so it is skipped; the ordinary
		// marketplace copy above is not.
		const userBuiltin = {
			...aExtension('vscode.git', {}, ExtensionType.User),
			isBuiltin: true,
		};

		assert.strictEqual(hucodeIsExtensionSkippedInOmniShell(userBuiltin), true);
	});

	test('matches skipped built-in ids without regard to case', () => {
		assert.deepStrictEqual({
			asDeclared: hucodeIsOmniShellSkippedBuiltinId('GitHub.copilot-chat'),
			lowered: hucodeIsOmniShellSkippedBuiltinId('github.copilot-chat'),
			uppered: hucodeIsOmniShellSkippedBuiltinId('VSCODE.GIT'),
			unlisted: hucodeIsOmniShellSkippedBuiltinId('vscode.json'),
		}, {
			asDeclared: true,
			lowered: true,
			uppered: true,
			unlisted: false,
		});
	});

	test('skip list covers the extensions issue #106 traced', () => {
		// The Copilot Chat to vscode.git path is what opened 35 repositories
		// and consumed 291,606 inotify watches from an empty shell.
		assert.ok(
			HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.includes(
				'GitHub.copilot-chat'
			)
		);
		assert.ok(
			HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.includes('vscode.git')
		);
	});

	test('skip list covers every eagerly activating built-in', () => {
		// These six are the only bundled built-ins declaring `*` or
		// `onStartupFinished`, so anything omitted here still starts in a shell
		// that cannot use it. vscode.git-base activates on `*` and was missed
		// on the first pass.
		for (const id of [
			'GitHub.copilot-chat',
			'vscode.debug-auto-launch',
			'vscode.git',
			'vscode.git-base',
			'vscode.github',
			'vscode.merge-conflict',
		]) {
			assert.ok(
				hucodeIsOmniShellSkippedBuiltinId(id),
				`${id} activates eagerly but is not skipped in the shell`
			);
		}
	});

	test('filters scanned user extensions only when policy is active', () => {
		const extension = aScannedExtension('pub.a');

		assert.strictEqual(
			hucodeShouldKeepScannedUserExtension(extension, undefined, undefined),
			true
		);
		assert.strictEqual(
			hucodeShouldKeepScannedUserExtension(
				extension,
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			false
		);
		assert.strictEqual(
			hucodeShouldKeepScannedUserExtension(
				aScannedExtension('pub.theme', {
					contributes: {
						themes: [{ label: 'Theme' }]
					}
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			true
		);
		assert.strictEqual(
			hucodeShouldKeepScannedUserExtension(
				aScannedExtension('pub.resolver', {
					activationEvents: ['onResolveRemoteAuthority:ssh-remote']
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				'ssh-remote+host'
			),
			true
		);
		assert.strictEqual(
			hucodeShouldKeepScannedUserExtension(
				aScannedExtension('pub.pendingResolver', {
					activationEvents: ['onResolveRemoteAuthority:ssh-remote']
				}),
				HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
				undefined
			),
			true
		);
	});

	function aExtension(
		id: string,
		manifest: Partial<IExtensionManifest> = {},
		type = ExtensionType.User
	): IExtension {
		const [publisher, name] = id.split('.');
		return {
			type,
			isBuiltin: type === ExtensionType.System,
			identifier: { id },
			manifest: {
				name,
				publisher,
				engines: { vscode: '^1.0.0' },
				...manifest,
				version: manifest.version ?? '1.0.0'
			},
			location: URI.file(id),
			targetPlatform: TargetPlatform.UNDEFINED,
			isValid: true,
			validations: [],
			preRelease: false
		};
	}

	function aScannedExtension(
		id: string,
		manifest: Partial<IExtensionManifest> = {}
	): IScannedExtension {
		const extension = aExtension(id, manifest);
		return {
			...extension,
			metadata: undefined,
			forceAutoUpdate: false
		};
	}
});
