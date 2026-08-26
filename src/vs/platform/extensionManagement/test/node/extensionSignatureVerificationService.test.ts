/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { ExtensionSignatureVerificationCode } from '../../common/extensionManagement.js';
import { HucodeOpenVsxExtensionSignatureVerifier, IHucodeExtensionSignatureVerificationResult } from '../../node/hucodeOpenVsxExtensionSignatureVerifier.js';
import { ExtensionSignatureVerificationResult, ExtensionSignatureVerificationService } from '../../node/extensionSignatureVerificationService.js';

type VsceVerify = (vsixFilePath: string, signatureArchiveFilePath: string, verbose: boolean) => Promise<ExtensionSignatureVerificationResult>;

suite('ExtensionSignatureVerificationService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses node-ovsx-sign for OpenVSX gallery signatures', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://open-vsx.org/vscode/gallery', {
			vsceVerify: async () => {
				throw new Error('vsce-sign should not be used for OpenVSX');
			}
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.Success);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.loaded, true);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.verified, true);
		assert.strictEqual(testObject.vsceSignLoaded, false);
	});

	test('uses vsce-sign for non-OpenVSX gallery signatures', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://marketplace.visualstudio.com/_apis/public/gallery', {
			vsceVerify: async (vsixFilePath, signatureArchiveFilePath, verbose) => {
				assert.strictEqual(vsixFilePath, 'extension.vsix');
				assert.strictEqual(signatureArchiveFilePath, 'extension.sigzip');
				assert.strictEqual(verbose, false);
				return {
					code: ExtensionSignatureVerificationCode.Success,
					didExecute: true
				};
			}
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.Success);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.loaded, false);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.verified, false);
		assert.strictEqual(testObject.vsceSignLoaded, true);
	});

	test('uses node-ovsx-sign for a configured mirror host', async () => {
		const testObject = new TestExtensionSignatureVerificationService(
			'https://signatures.example.test/vscode/gallery',
			{
				openVsxSignatureVerificationHosts: [
					' signatures.example.test ',
				],
			}
		);

		const result = await testObject.verify(
			'pub.name',
			'1.0.0',
			'extension.vsix',
			'extension.sigzip'
		);

		assert.strictEqual(
			result?.code,
			ExtensionSignatureVerificationCode.Success
		);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.verified, true);
		assert.strictEqual(testObject.vsceSignLoaded, false);
	});

	test('uses vsce-sign when OpenVSX verifier hosts are explicitly disabled', async () => {
		const testObject = new TestExtensionSignatureVerificationService(
			'https://open-vsx.org/vscode/gallery',
			{
				openVsxSignatureVerificationHosts: [],
			}
		);

		const result = await testObject.verify(
			'pub.name',
			'1.0.0',
			'extension.vsix',
			'extension.sigzip'
		);

		assert.strictEqual(
			result?.code,
			ExtensionSignatureVerificationCode.Success
		);
		assert.strictEqual(testObject.hucodeOpenVsxVerifier.verified, false);
		assert.strictEqual(testObject.vsceSignLoaded, true);
	});
});

class TestExtensionSignatureVerificationService extends ExtensionSignatureVerificationService {

	public vsceSignLoaded = false;
	public hucodeOpenVsxVerifier =
		new TestHucodeOpenVsxExtensionSignatureVerifier();

	constructor(
		serviceUrl: string,
		private readonly options: {
			readonly vsceVerify?: VsceVerify;
			readonly openVsxSignatureVerificationHosts?: string[];
		}
	) {
		super(
			new NullLogService(),
			NullTelemetryService,
			{
				extensionsGallery: {
					serviceUrl,
					openVsxSignatureVerificationHosts:
						options.openVsxSignatureVerificationHosts,
				},
			} as IProductService
		);
	}

	protected override async resolveVsceSign() {
		this.vsceSignLoaded = true;
		return {
			verify: this.options.vsceVerify ?? (async () => ({
				code: ExtensionSignatureVerificationCode.Success,
				didExecute: true
			}))
		};
	}

	protected override createHucodeOpenVsxSignatureVerifier():
		HucodeOpenVsxExtensionSignatureVerifier {
		return this.hucodeOpenVsxVerifier;
	}
}

class TestHucodeOpenVsxExtensionSignatureVerifier
	extends HucodeOpenVsxExtensionSignatureVerifier {

	public loaded = false;
	public verified = false;

	override async load(): Promise<void> {
		this.loaded = true;
	}

	override async verify(
		vsixFilePath: string,
		signatureArchiveFilePath: string,
		verbose: boolean
	): Promise<IHucodeExtensionSignatureVerificationResult> {
		assert.strictEqual(vsixFilePath, 'extension.vsix');
		assert.strictEqual(signatureArchiveFilePath, 'extension.sigzip');
		assert.strictEqual(verbose, false);
		this.verified = true;

		return {
			code: ExtensionSignatureVerificationCode.Success,
			didExecute: true,
		};
	}
}
