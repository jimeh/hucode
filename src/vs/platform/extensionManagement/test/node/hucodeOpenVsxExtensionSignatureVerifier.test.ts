/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionSignatureVerificationCode } from '../../common/extensionManagement.js';
import {
	HucodeOpenVsxExtensionSignatureVerifier,
	IHucodeOpenVsxSignModule,
	IHucodeOpenVsxSignOptions,
	useHucodeOpenVsxSignatureVerifier
} from '../../node/hucodeOpenVsxExtensionSignatureVerifier.js';

type OvsxVerify = (
	vsixFilePath: string,
	signatureArchiveFilePath: string,
	verbose?: boolean,
	options?: IHucodeOpenVsxSignOptions
) => Promise<boolean>;

suite('HucodeOpenVsxExtensionSignatureVerifier', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses node-ovsx-sign with signature manifest verification', async () => {
		let ovsxVerifyOptions: IHucodeOpenVsxSignOptions | undefined;
		const testObject = new TestHucodeOpenVsxExtensionSignatureVerifier(
			async (vsixFilePath, signatureArchiveFilePath, verbose, options) => {
				assert.strictEqual(vsixFilePath, 'extension.vsix');
				assert.strictEqual(signatureArchiveFilePath, 'extension.sigzip');
				assert.strictEqual(verbose, false);
				ovsxVerifyOptions = options;
				return true;
			}
		);

		const result = await testObject.verify(
			'extension.vsix',
			'extension.sigzip',
			false
		);

		assert.strictEqual(result.code, ExtensionSignatureVerificationCode.Success);
		assert.deepStrictEqual(
			ovsxVerifyOptions,
			{ verifySignatureManifest: true }
		);
	});

	test('maps OpenVSX false verification results to invalid signatures', async () => {
		const testObject = new TestHucodeOpenVsxExtensionSignatureVerifier(
			async () => false
		);

		const result = await testObject.verify(
			'extension.vsix',
			'extension.sigzip',
			false
		);

		assert.strictEqual(
			result.code,
			ExtensionSignatureVerificationCode.SignatureIsInvalid
		);
	});

	test('preserves structured signature manifest errors independently of prose', () => {
		const testObject = new TestHucodeOpenVsxExtensionSignatureVerifier();

		for (const output of [
			'The signature is not valid',
			'Unrelated diagnostic prose',
		]) {
			const result = testObject.toVerificationResult(
				new TestOvsxSignError(
					'SignatureManifestIsInvalid',
					true,
					output
				)
			);

			assert.strictEqual(
				result.code,
				ExtensionSignatureVerificationCode.SignatureManifestIsInvalid
			);
			assert.strictEqual(result.didExecute, true);
		}
	});

	test('maps OpenVSX extension manifest errors to package integrity failures', () => {
		const testObject = new TestHucodeOpenVsxExtensionSignatureVerifier();

		const result = testObject.toVerificationResult(
			new TestOvsxSignError(
				'ExtensionManifestIsInvalid',
				false,
				'The extension manifest is not valid'
			)
		);

		assert.strictEqual(
			result.code,
			ExtensionSignatureVerificationCode.PackageIntegrityCheckFailed
		);
		assert.strictEqual(result.didExecute, false);
	});

	test('passes through VS Code signature verification codes', () => {
		const testObject = new TestHucodeOpenVsxExtensionSignatureVerifier();

		const result = testObject.toVerificationResult(
			new TestOvsxSignError(
				ExtensionSignatureVerificationCode.SignatureArchiveIsInvalidZip,
				true,
				'The signature archive is not valid'
			)
		);

		assert.strictEqual(
			result.code,
			ExtensionSignatureVerificationCode.SignatureArchiveIsInvalidZip
		);
	});

	test('uses the canonical OpenVSX host by default', () => {
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://open-vsx.org/vscode/gallery'
			),
			true
		);
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://marketplace.visualstudio.com/_apis/public/gallery'
			),
			false
		);
	});

	test('uses configured mirror hosts case-insensitively with whitespace', () => {
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://signatures.example.test/vscode/gallery',
				['  SIGNATURES.EXAMPLE.TEST  ']
			),
			true
		);
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://OPEN-VSX.ORG/vscode/gallery',
				['  OPEN-VSX.ORG  ']
			),
			true
		);
	});

	test('supports disabling and rejects nonmatching or malformed URLs', () => {
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://open-vsx.org/vscode/gallery',
				[]
			),
			false
		);
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'https://other.example.test/vscode/gallery',
				['signatures.example.test']
			),
			false
		);
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(
				'not a url',
				['not a url']
			),
			false
		);
		assert.strictEqual(
			useHucodeOpenVsxSignatureVerifier(undefined, ['open-vsx.org']),
			false
		);
	});
});

class TestHucodeOpenVsxExtensionSignatureVerifier
	extends HucodeOpenVsxExtensionSignatureVerifier {

	constructor(private readonly ovsxVerify?: OvsxVerify) {
		super();
	}

	protected override async resolveOvsxSign():
		Promise<IHucodeOpenVsxSignModule> {
		return {
			verify: this.ovsxVerify ?? (async () => true)
		};
	}
}

class TestOvsxSignError extends Error {

	constructor(
		readonly code: string,
		readonly didExecute: boolean,
		readonly output: string
	) {
		super(output);
	}
}
