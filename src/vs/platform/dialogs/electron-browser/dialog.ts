/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { process } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { getHucodeApplicationVersion } from '../../product/common/hucodeProductVersion.js';

export function createNativeAboutDialogDetails(productService: IProductService, osProps: IOSProperties): { title: string; details: string; detailsToCopy: string } {
	let vscodeVersion = productService.version;
	if (productService.target) {
		vscodeVersion = `${vscodeVersion} (${productService.target} setup)`;
	} else if (productService.darwinUniversalAssetId) {
		vscodeVersion = `${vscodeVersion} (Universal)`;
	}

	const getDetails = (useAgo: boolean): string => {
		const commonDetails = [
			productService.commit || 'Unknown',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown',
			process.versions['electron'],
			process.versions['microsoft-build'],
			process.versions['chrome'],
			process.versions['node'],
			process.versions['v8'],
			`${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`
		] as const;

		if (productService.hucodeVersion) {
			return localize({ key: 'aboutDetailHucode', comment: ['Electron, Chromium, Node.js and V8 are product names that need no translation'] },
				"Version: {0}\nVSCode Version: {1}\nCommit: {2}\nDate: {3}\nElectron: {4}\nElectronBuildId: {5}\nChromium: {6}\nNode.js: {7}\nV8: {8}\nOS: {9}",
				getHucodeApplicationVersion(productService),
				vscodeVersion,
				...commonDetails
			);
		}

		return localize({ key: 'aboutDetail', comment: ['Electron, Chromium, Node.js and V8 are product names that need no translation'] },
			"Version: {0}\nCommit: {1}\nDate: {2}\nElectron: {3}\nElectronBuildId: {4}\nChromium: {5}\nNode.js: {6}\nV8: {7}\nOS: {8}",
			vscodeVersion,
			...commonDetails
		);
	};

	const details = getDetails(true);
	const detailsToCopy = getDetails(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
