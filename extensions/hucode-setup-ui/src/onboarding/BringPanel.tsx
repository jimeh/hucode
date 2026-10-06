/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ArrowRightIcon } from 'lucide-react';
import type { EditorMigrationSetupIntent, EditorMigrationSetupPanel } from '@/generated/editorMigrationSetupProtocol';
import { Lead, PanelHeading } from '@/components/primitives';
import { Button } from '@/vendor/shadcn/button';

/**
 * First onboarding stage: the two routes out of it at equal prominence.
 *
 * Each choice posts `chooseRoute` with the identifier the host supplied. The footer actions belong
 * to the shell, so Skip and Do This Later are not rendered here.
 */
export function BringPanel({ panel, send }: {
	readonly panel: Extract<EditorMigrationSetupPanel, { kind: 'bring' }>;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
}) {
	return (
		<div className="flex flex-col gap-4 pb-6">
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<div className="grid max-w-3xl gap-3 md:grid-cols-2">
				{panel.choices.map(choice => (
					<Button
						key={choice.id}
						type="button"
						variant="outline"
						data-focus-id={`route-${choice.id}`}
						className="h-auto w-full items-start justify-between gap-3 px-4 py-3 text-left whitespace-normal"
						onClick={() => send({ type: 'chooseRoute', route: choice.id })}
					>
						<span className="flex min-w-0 flex-col gap-1">
							<span className="text-sm font-medium">{choice.label}</span>
							<span className="text-muted-foreground text-xs font-normal">{choice.detail}</span>
						</span>
						<ArrowRightIcon aria-hidden className="mt-0.5 shrink-0" />
					</Button>
				))}
			</div>
			{panel.paragraphs.map(paragraph => (
				<p key={paragraph} className="text-foreground max-w-2xl text-sm">{paragraph}</p>
			))}
		</div>
	);
}
