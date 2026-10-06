/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Main's current exact-folder association and optional eligible import profile. */
export interface HucodeOnboardingTarget {
	readonly worktreePath: string;
	readonly alreadyOpen: boolean;
	readonly associatedProfileId?: string;
	readonly associatedProfileName?: string;
	readonly importedProfile?: { readonly id: string; readonly name: string };
}

/** A user-approved exact-folder handoff, revalidated under the owner reservation. */
export interface HucodeOnboardingOpenRequest {
	readonly worktreePath: string;
	readonly projectId?: string;
	readonly profileId?: string;
	readonly expectedProfileId?: string;
}

/** Reports whether opening succeeded and whether an association was saved first. */
export type HucodeOnboardingOpenResult =
	| { readonly kind: 'opened' | 'alreadyOpen'; readonly associationSaved: boolean }
	| { readonly kind: 'conflict' }
	| { readonly kind: 'failed'; readonly associationSaved: boolean; readonly message: string };
