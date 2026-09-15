/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../platform/ipc/electron-browser/services.js';
import {
	EDITOR_MIGRATION_SOURCE_CHANNEL_NAME,
	IEditorMigrationSourceService,
} from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationSourceChannelClient } from '../../common/migration/editorMigrationSourceIpc.js';

registerMainProcessRemoteService(
	IEditorMigrationSourceService,
	EDITOR_MIGRATION_SOURCE_CHANNEL_NAME,
	{ channelClientCtor: EditorMigrationSourceChannelClient }
);
