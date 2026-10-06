/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { updateHostedOmniProjectsSeam } from
	'../../browser/hostedOmniProjectsSeam.js';

suite('HostedOmniProjectsSeam', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('continues the compact seam down the status bar only beside a visible Projects card', () => {
		const workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench floating-panels modern-ui-compact';
		workbench.style.setProperty('--vscode-strokeThickness', '1px');
		workbench.style.setProperty('--vscode-surface-border', 'rgb(1, 2, 3)');
		workbench.style.setProperty('--vscode-modernActivityBar-border', 'rgb(4, 5, 6)');
		const statusBar = mainWindow.document.createElement('div');
		statusBar.className = 'part statusbar';
		workbench.appendChild(statusBar);
		mainWindow.document.body.appendChild(workbench);
		disposables.add(toDisposable(() => workbench.remove()));

		const seam = () => {
			const style = mainWindow.getComputedStyle(statusBar);
			return style.backgroundImage === 'none'
				? 'none'
				: `${style.backgroundImage} ${style.backgroundSize} ${style.backgroundPosition} ${style.backgroundRepeat}`;
		};

		const initial = seam();
		updateHostedOmniProjectsSeam(workbench, true);
		const activityBarLeads = seam();
		workbench.classList.add('noactivitybar');
		const activityBarHidden = seam();
		workbench.classList.remove('modern-ui-compact');
		const defaultDensity = seam();
		workbench.classList.add('modern-ui-compact');
		updateHostedOmniProjectsSeam(workbench, false);
		const projectsHidden = seam();

		assert.deepStrictEqual({
			initial,
			activityBarLeads,
			activityBarHidden,
			defaultDensity,
			projectsHidden,
		}, {
			initial: 'none',
			activityBarLeads: 'linear-gradient(rgb(4, 5, 6), rgb(4, 5, 6)) 1px 100% 0% 0% no-repeat',
			activityBarHidden: 'linear-gradient(rgb(1, 2, 3), rgb(1, 2, 3)) 1px 100% 0% 0% no-repeat',
			defaultDensity: 'none',
			projectsHidden: 'none',
		});
	});
});
