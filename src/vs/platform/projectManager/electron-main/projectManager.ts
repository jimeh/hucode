/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../instantiation/common/instantiation.js';
import {
	IProjectManagerService
} from '../common/projectManager.js';

export const IProjectManagerMainService = refineServiceDecorator<
	IProjectManagerService,
	IProjectManagerMainService
>(IProjectManagerService);

export interface IProjectManagerMainService extends IProjectManagerService {
}
