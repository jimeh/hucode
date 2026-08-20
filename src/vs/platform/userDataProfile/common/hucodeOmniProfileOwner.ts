/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	getHucodeOmniWebProfileId,
	isHucodeHostedOmniWebConfiguration,
	isHucodeOmniWebConfiguration,
} from '../../environment/common/hucodeWebConfiguration.js';
import { IUserDataProfile } from './userDataProfile.js';

/** Stable identity of the regular profile that owns one Omni session. */
export interface IHucodeOmniProfileOwner {
	readonly profileId: string;
}

/** Error raised when an Omni session cannot resolve its required owner. */
export class HucodeOmniProfileOwnerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HucodeOmniProfileOwnerError';
	}
}

/** Returns whether a profile may own an Omni session. */
export function isHucodeOmniOwnerProfile(
	profile: IUserDataProfile
): boolean {
	return !profile.isTransient && !profile.isAgentsWindowProfile;
}

/** Resolves an existing regular profile by stable ID. */
export function resolveHucodeOmniProfileOwner(
	profiles: readonly IUserDataProfile[],
	profileId: string
): IUserDataProfile {
	const profile = profiles.find(candidate =>
		candidate.id === profileId && isHucodeOmniOwnerProfile(candidate)
	);
	if (!profile) {
		throw new HucodeOmniProfileOwnerError(
			`The Hucode Omni owner profile "${profileId}" is unavailable.`
		);
	}
	return profile;
}

/** Resolves the desktop owner without creating a profile from legacy input. */
export function resolveHucodeOmniDesktopProfileOwner(
	profiles: readonly IUserDataProfile[],
	options: {
		readonly profileId?: string;
		readonly forceProfile?: string;
		readonly fallbackProfile: IUserDataProfile;
		readonly defaultProfile: IUserDataProfile;
	}
): IUserDataProfile {
	if (options.profileId) {
		return resolveHucodeOmniProfileOwner(profiles, options.profileId);
	}
	if (options.forceProfile) {
		const profile = profiles.find(candidate =>
			candidate.name === options.forceProfile &&
			isHucodeOmniOwnerProfile(candidate)
		);
		if (!profile) {
			throw new HucodeOmniProfileOwnerError(
				`The Hucode Omni profile "${options.forceProfile}" is unavailable.`
			);
		}
		return profile;
	}
	return isHucodeOmniOwnerProfile(options.fallbackProfile)
		? options.fallbackProfile
		: options.defaultProfile;
}

/** Verifies that a live profile is the fixed owner of an Omni session. */
export function assertHucodeOmniProfileOwner(
	ownerProfileId: string,
	profile: Pick<IUserDataProfile, 'id'>
): void {
	if (profile.id !== ownerProfileId) {
		throw new HucodeOmniProfileOwnerError(
			`The hosted workbench profile "${profile.id}" does not match ` +
			`its Omni owner profile "${ownerProfileId}".`
		);
	}
}

/** Resolves the trusted-route owner selection for BrowserMain startup. */
export function resolveHucodeOmniWebProfileOwner(
	profiles: readonly IUserDataProfile[],
	configuration: object | undefined
): IUserDataProfile | undefined {
	const isShell = isHucodeOmniWebConfiguration(configuration);
	const isHosted = isHucodeHostedOmniWebConfiguration(configuration);
	if (!isShell && !isHosted) {
		return undefined;
	}

	const profileId = getHucodeOmniWebProfileId(configuration);
	if (!profileId) {
		if (isHosted) {
			throw new HucodeOmniProfileOwnerError(
				'A hosted Hucode Omni workbench requires an owner profile.'
			);
		}
		return undefined;
	}
	return resolveHucodeOmniProfileOwner(profiles, profileId);
}
