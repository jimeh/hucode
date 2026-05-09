/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { ExtensionSignatureVerificationCode } from '../../common/extensionManagement.js';
import { ExtensionSignatureVerificationResult, ExtensionSignatureVerificationService } from '../../node/extensionSignatureVerificationService.js';

type OvsxVerifyOptions = {
	readonly verifySignatureManifest?: boolean;
};

type OvsxVerify = (vsixFilePath: string, signatureArchiveFilePath: string, verbose?: boolean, options?: OvsxVerifyOptions) => Promise<boolean>;
type VsceVerify = (vsixFilePath: string, signatureArchiveFilePath: string, verbose: boolean) => Promise<ExtensionSignatureVerificationResult>;

suite('ExtensionSignatureVerificationService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses node-ovsx-sign for OpenVSX gallery signatures', async () => {
		let ovsxVerifyOptions: OvsxVerifyOptions | undefined;
		const testObject = new TestExtensionSignatureVerificationService('https://open-vsx.org/vscode/gallery', {
			ovsxVerify: async (vsixFilePath, signatureArchiveFilePath, verbose, options) => {
				assert.strictEqual(vsixFilePath, 'extension.vsix');
				assert.strictEqual(signatureArchiveFilePath, 'extension.sigzip');
				assert.strictEqual(verbose, false);
				ovsxVerifyOptions = options;
				return true;
			},
			vsceVerify: async () => {
				throw new Error('vsce-sign should not be used for OpenVSX');
			}
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.Success);
		assert.strictEqual(testObject.ovsxSignLoaded, true);
		assert.strictEqual(testObject.vsceSignLoaded, false);
		assert.deepStrictEqual(ovsxVerifyOptions, { verifySignatureManifest: true });
	});

	test('uses vsce-sign for non-OpenVSX gallery signatures', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://marketplace.visualstudio.com/_apis/public/gallery', {
			ovsxVerify: async () => {
				throw new Error('node-ovsx-sign should not be used for marketplace');
			},
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
		assert.strictEqual(testObject.ovsxSignLoaded, false);
		assert.strictEqual(testObject.vsceSignLoaded, true);
	});

	test('maps OpenVSX invalid signature errors', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://open-vsx.org/vscode/gallery', {
			ovsxVerify: async () => {
				throw new TestOvsxSignError(
					'SignatureManifestIsInvalid',
					true,
					'The signature is not valid'
				);
			}
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.SignatureIsInvalid);
	});

	test('maps OpenVSX false verification results to invalid signatures', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://open-vsx.org/vscode/gallery', {
			ovsxVerify: async () => false
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.SignatureIsInvalid);
	});

	test('maps OpenVSX extension manifest errors to package integrity failures', async () => {
		const testObject = new TestExtensionSignatureVerificationService('https://open-vsx.org/vscode/gallery', {
			ovsxVerify: async () => {
				throw new TestOvsxSignError(
					'ExtensionManifestIsInvalid',
					false,
					'The extension manifest is not valid'
				);
			}
		});

		const result = await testObject.verify('pub.name', '1.0.0', 'extension.vsix', 'extension.sigzip');

		assert.strictEqual(result?.code, ExtensionSignatureVerificationCode.PackageIntegrityCheckFailed);
	});
});

class TestOvsxSignError extends Error {

	constructor(
		readonly code: string,
		readonly didExecute: boolean,
		readonly output: string
	) {
		super(output);
	}
}

class TestExtensionSignatureVerificationService extends ExtensionSignatureVerificationService {

	public ovsxSignLoaded = false;
	public vsceSignLoaded = false;

	constructor(
		serviceUrl: string,
		private readonly options: {
			readonly ovsxVerify?: OvsxVerify;
			readonly vsceVerify?: VsceVerify;
		}
	) {
		super(
			new NullLogService(),
			NullTelemetryService,
			{ extensionsGallery: { serviceUrl } } as IProductService
		);
	}

	protected override async resolveOvsxSign() {
		this.ovsxSignLoaded = true;
		return {
			verify: this.options.ovsxVerify ?? (async () => true)
		};
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
}
