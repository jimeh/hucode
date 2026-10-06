/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Import route entry point.
 *
 * The host framing lives outside this module, so the future full-window onboarding route in #204
 * can mount the same setup components from `src/onboarding/` without changing anything here.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupShell } from '@/components/SetupShell';
import { createSetupHost } from '@/lib/host';
import { TooltipProvider } from '@/vendor/shadcn/tooltip';

const container = document.getElementById('root');
if (container) {
	const host = createSetupHost();
	createRoot(container).render(
		<StrictMode>
			<TooltipProvider>
				<SetupShell host={host} />
			</TooltipProvider>
		</StrictMode>,
	);
	// Core replaces the static bootstrap fallback with the first localized snapshot.
	host.ready();
}
