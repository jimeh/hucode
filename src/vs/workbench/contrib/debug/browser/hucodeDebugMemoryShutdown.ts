/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { DEBUG_MEMORY_SCHEME } from '../common/debug.js';

interface IDebugMemoryEditorService {
	readonly editors: readonly {
		readonly resource?: URI;
		dispose(): void;
	}[];
}

/**
 * Disposes debug-memory editors when their workbench shuts down.
 */
export function registerDebugMemoryEditorShutdown(
	lifecycleService: ILifecycleService,
	editorService: IDebugMemoryEditorService,
	disposeDebugService: () => void
): IDisposable {
	return lifecycleService.onWillShutdown(() => {
		for (const editor of editorService.editors) {
			// Editors will not be valid on window reload, so close them.
			if (editor.resource?.scheme === DEBUG_MEMORY_SCHEME) {
				editor.dispose();
			}
		}

		disposeDebugService();
	});
}
