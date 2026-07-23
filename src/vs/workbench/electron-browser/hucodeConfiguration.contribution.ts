/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh } from '../../base/common/platform.js';
import {
	Extensions as ConfigurationExtensions,
	IConfigurationRegistry,
} from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';

if (isMacintosh) {
	Registry.as<IConfigurationRegistry>(
		ConfigurationExtensions.Configuration
	).registerDefaultConfigurations([{
		overrides: {
			'window.menuStyle': 'native',
		},
		source: 'hucodeDefaults',
	}]);
}
