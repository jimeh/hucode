/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditorMigrationSetupPanel } from '@/generated/editorMigrationSetupProtocol';
import { Lead, PanelHeading } from '@/components/primitives';

/**
 * First onboarding stage.
 *
 * A placeholder until the route choices land: it draws the copy the host supplies and nothing
 * else. The footer actions belong to the shell, so Skip and Do This Later are not rendered here.
 */
export function BringPanel({ panel }: { readonly panel: Extract<EditorMigrationSetupPanel, { kind: 'bring' }> }) {
	return (
		<div className="flex flex-col gap-4 pb-6">
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			{panel.paragraphs.map(paragraph => (
				<p key={paragraph} className="text-foreground max-w-2xl text-sm">{paragraph}</p>
			))}
		</div>
	);
}
