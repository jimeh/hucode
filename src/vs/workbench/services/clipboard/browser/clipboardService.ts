/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IClipboardService, isDefaultClipboardType } from '../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService as BaseBrowserClipboardService } from '../../../../platform/clipboard/browser/clipboardService.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

interface PendingReadTextPrompt {
	readonly promise: Promise<string>;
	readonly finish: (value: string) => void;
}

export class BrowserClipboardService extends BaseBrowserClipboardService {
	private pendingReadTextPrompt: PendingReadTextPrompt | undefined;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService logService: ILogService,
		@ILayoutService layoutService: ILayoutService
	) {
		super(layoutService, logService);
		this._register({
			dispose: () => this.pendingReadTextPrompt?.finish('')
		});
	}

	override async writeText(text: string, type?: string): Promise<void> {
		this.logService.trace('BrowserClipboardService#writeText called with type:', type, ' with text.length:', text.length);
		if (!!this.environmentService.extensionTestsLocationURI && isDefaultClipboardType(type)) {
			type = 'vscode-tests'; // force in-memory clipboard for tests to avoid permission issues
		}
		this.logService.trace('BrowserClipboardService#super.writeText');
		return super.writeText(text, type);
	}

	override async readText(type?: string): Promise<string> {
		this.logService.trace('BrowserClipboardService#readText called with type:', type);
		if (!!this.environmentService.extensionTestsLocationURI && isDefaultClipboardType(type)) {
			type = 'vscode-tests'; // force in-memory clipboard for tests to avoid permission issues
		}

		if (!isDefaultClipboardType(type)) {
			this.logService.trace('BrowserClipboardService#super.readText');
			return super.readText(type);
		}

		try {
			const readText = await this.readTextFromSystemClipboard();
			this.logService.trace('BrowserClipboardService#readText with readText.length:', readText.length);
			return readText;
		} catch (error) {
			if (this._store.isDisposed) {
				return '';
			}
			return this.promptForReadTextPermission();
		}
	}

	private promptForReadTextPermission(): Promise<string> {
		if (this._store.isDisposed) {
			return Promise.resolve('');
		}

		if (this.pendingReadTextPrompt) {
			return this.pendingReadTextPrompt.promise;
		}

		let resolvePrompt!: (value: string) => void;
		const pendingPromise = new Promise<string>(resolve => resolvePrompt = resolve);

		const listener = new DisposableStore();
		let settled = false;
		let retrying = false;
		const prompt: { handle: INotificationHandle | undefined } = { handle: undefined };
		const finish = (value: string) => {
			if (settled) {
				return;
			}

			settled = true;
			listener.dispose();
			prompt.handle?.close();
			if (this.pendingReadTextPrompt?.promise === pendingPromise) {
				this.pendingReadTextPrompt = undefined;
			}
			resolvePrompt(value);
		};
		this.pendingReadTextPrompt = { promise: pendingPromise, finish };

		// Inform user about permissions problem (https://github.com/microsoft/vscode/issues/112089)
		const handle = this.notificationService.prompt(
			Severity.Error,
			localize('clipboardError', "Unable to read from the browser's clipboard. Please make sure you have granted access for this website to read from the clipboard."),
			[{
				label: localize('retry', "Retry"),
				run: async () => {
					if (settled || retrying) {
						return;
					}

					retrying = true;
					listener.dispose();
					prompt.handle?.close();
					try {
						const readText = await this.readTextFromSystemClipboard();
						this.logService.trace('BrowserClipboardService#readText with readText.length:', readText.length);
						finish(readText);
					} catch {
						if (settled) {
							return;
						}

						if (this.pendingReadTextPrompt?.promise === pendingPromise) {
							this.pendingReadTextPrompt = undefined;
						}
						finish(await this.promptForReadTextPermission());
					}
				}
			}, {
				label: localize('learnMore', "Learn More"),
				run: () => this.openerService.open('https://go.microsoft.com/fwlink/?linkid=2151362')
			}],
			{
				sticky: true
			}
		);
		prompt.handle = handle;

		if (settled) {
			handle.close();
		} else {
			// Always resolve all waiters once the notification closes.
			listener.add(Event.once(handle.onDidClose)(() => finish('')));
		}
		return pendingPromise;
	}
}

registerSingleton(IClipboardService, BrowserClipboardService, InstantiationType.Delayed);
