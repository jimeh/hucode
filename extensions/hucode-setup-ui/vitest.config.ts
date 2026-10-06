/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: { '@': path.join(import.meta.dirname, 'src') },
	},
	test: {
		environment: 'jsdom',
		include: ['src/test/**/*.test.tsx', 'src/test/**/*.test.ts'],
		setupFiles: ['src/test/setup.ts'],
	},
});
