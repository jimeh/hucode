/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../base/common/errors.js';
import { ExtensionSignatureVerificationCode } from '../common/extensionManagement.js';

/**
 * Result returned by Hucode extension signature verifiers.
 */
export interface IHucodeExtensionSignatureVerificationResult {
	readonly code: ExtensionSignatureVerificationCode;
	readonly didExecute: boolean;
	readonly internalCode?: number;
	readonly output?: string;
}

/**
 * Options accepted by node-ovsx-sign when verifying a signature archive.
 */
export interface IHucodeOpenVsxSignOptions {
	readonly verifySignatureManifest?: boolean;
}

/**
 * Runtime shape of the node-ovsx-sign module.
 */
export interface IHucodeOpenVsxSignModule {
	verify(
		vsixFilePath: string,
		signatureArchiveFilePath: string,
		verbose?: boolean,
		options?: IHucodeOpenVsxSignOptions
	): Promise<boolean>;
}

type OvsxSignError = {
	readonly code?: unknown;
	readonly didExecute?: unknown;
	readonly output?: unknown;
};

/**
 * Verifies OpenVSX VsixSignature archives with node-ovsx-sign.
 */
export class HucodeOpenVsxExtensionSignatureVerifier {

	readonly name = 'node-ovsx-sign';

	private moduleLoadingPromise:
		Promise<IHucodeOpenVsxSignModule> | undefined;

	/**
	 * Loads the OpenVSX verifier module before verification starts.
	 */
	async load(): Promise<void> {
		await this.ovsxSign();
	}

	/**
	 * Verifies an extension signature archive using OpenVSX semantics.
	 */
	async verify(
		vsixFilePath: string,
		signatureArchiveFilePath: string,
		verbose: boolean
	): Promise<IHucodeExtensionSignatureVerificationResult> {
		const valid = await (await this.ovsxSign()).verify(
			vsixFilePath,
			signatureArchiveFilePath,
			verbose,
			{ verifySignatureManifest: true }
		);

		return {
			code: valid
				? ExtensionSignatureVerificationCode.Success
				: ExtensionSignatureVerificationCode.SignatureIsInvalid,
			didExecute: true,
		};
	}

	/**
	 * Converts node-ovsx-sign verification errors to VS Code result codes.
	 */
	toVerificationResult(
		error: unknown
	): IHucodeExtensionSignatureVerificationResult {
		const ovsxSignError = this.getOvsxSignError(error);
		const didExecute = ovsxSignError
			? Boolean(ovsxSignError.didExecute)
			: false;

		return {
			code: this.toOvsxSignCode(error),
			didExecute,
			output: this.getOvsxSignOutput(error)
		};
	}

	/**
	 * Resolves the OpenVSX verifier module.
	 */
	protected async resolveOvsxSign():
		Promise<IHucodeOpenVsxSignModule> {
		const mod = 'node-ovsx-sign';
		return import(mod);
	}

	private ovsxSign(): Promise<IHucodeOpenVsxSignModule> {
		if (!this.moduleLoadingPromise) {
			this.moduleLoadingPromise = this.resolveOvsxSign();
		}

		return this.moduleLoadingPromise;
	}

	private toOvsxSignCode(
		error: unknown
	): ExtensionSignatureVerificationCode {
		const ovsxSignError = this.getOvsxSignError(error);
		const code = typeof ovsxSignError?.code === 'string'
			? ovsxSignError.code
			: undefined;
		const output = this.getOvsxSignOutput(error);

		if (
			code === ExtensionSignatureVerificationCode.SignatureManifestIsInvalid
			&& output.includes('signature is not valid')
		) {
			return ExtensionSignatureVerificationCode.SignatureIsInvalid;
		}

		if (code === 'ExtensionManifestIsInvalid') {
			return ExtensionSignatureVerificationCode.PackageIntegrityCheckFailed;
		}

		if (
			code
			&& Object.values(ExtensionSignatureVerificationCode).includes(
				code as ExtensionSignatureVerificationCode
			)
		) {
			return code as ExtensionSignatureVerificationCode;
		}

		return ExtensionSignatureVerificationCode.UnknownError;
	}

	private getOvsxSignOutput(error: unknown): string {
		const ovsxSignError = this.getOvsxSignError(error);
		if (typeof ovsxSignError?.output === 'string') {
			return ovsxSignError.output;
		}

		return getErrorMessage(error);
	}

	private getOvsxSignError(error: unknown): OvsxSignError | undefined {
		return typeof error === 'object' && error !== null
			? error as OvsxSignError
			: undefined;
	}
}

/**
 * Determines if the configured extension gallery uses OpenVSX signatures.
 */
export function useHucodeOpenVsxSignatureVerifier(
	serviceUrl: string | undefined
): boolean {
	if (!serviceUrl) {
		return false;
	}

	try {
		return new URL(serviceUrl).hostname === 'open-vsx.org';
	} catch {
		return false;
	}
}
