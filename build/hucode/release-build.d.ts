/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Release target options for Hucode packaging.
 *
 * @property platform Release platform identifier.
 * @property arch Release architecture identifier.
 */
export interface HucodeReleaseTargetOptions {
	readonly platform: string;
	readonly arch: string;
}

/**
 * Validates that an extracted Copilot VSIX has no bundled target binaries.
 */
export function validateExtractedCopilotVsix(outputDir: string): Promise<void>;

/**
 * Finds the built-in Copilot extension inside a packaged app output.
 */
export function findBuiltInCopilotExtension(
	buildOutput: string
): Promise<string | undefined>;

/**
 * Validates the packaged Copilot extension for a release target.
 */
export function validatePackagedCopilot(
	options: HucodeReleaseTargetOptions,
	buildOutput: string
): Promise<void>;
