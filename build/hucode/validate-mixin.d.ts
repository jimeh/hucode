/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Validates the generated Hucode product mixin output for one quality.
 */
export function validateMixin(quality?: string): Promise<void>;

/**
 * Asserts that a package script does not manage package sources or keys.
 */
export function assertNoPackageSourceManagement(
	contents: string,
	label: string
): void;

/**
 * Asserts that product metadata does not contain upstream identity.
 */
export function assertNoUpstreamIdentity(
	contents: string,
	label: string
): void;
