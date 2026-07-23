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
	hucodeIsExtensionDisabledByPolicy,
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
