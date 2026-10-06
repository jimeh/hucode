/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Native Hucode owns automatic onboarding independently of its completion state. */
export function suppressHucodeUpstreamOnboarding(isWeb: boolean, hucodeVersion: string | undefined): boolean {
	return !isWeb && !!hucodeVersion;
}

/** First-process suppression remains active for children opened after onboarding completes. */
export function suppressHucodeStartupPage(isWeb: boolean, hucodeVersion: string | undefined, isNewApplication: boolean): boolean {
	return suppressHucodeUpstreamOnboarding(isWeb, hucodeVersion) && isNewApplication;
}
