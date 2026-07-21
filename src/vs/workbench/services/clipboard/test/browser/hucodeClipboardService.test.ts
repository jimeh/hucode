/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, IPromptChoice, IPromptOptions, NoOpNotification, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService as BaseTestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';
import { TestLayoutService } from '../../../../test/browser/workbenchTestServices.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { BrowserClipboardService as WorkbenchBrowserClipboardService } from '../../browser/clipboardService.js';

class TestNotificationHandle extends NoOpNotification {
	private readonly closeEmitter = new Emitter<void>();
	override readonly onDidClose = this.closeEmitter.event;
	closed = false;

	override close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.closeEmitter.fire();
	}

	dispose(): void {
		this.closeEmitter.dispose();
	}
}

class TestNotificationService extends BaseTestNotificationService {
	readonly prompts: { choices: IPromptChoice[]; handle: TestNotificationHandle }[] = [];

	override prompt(
		_severity: Severity,
		_message: string,
		choices: IPromptChoice[],
		_options?: IPromptOptions
	): INotificationHandle {
		const handle = new TestNotificationHandle();
		this.prompts.push({ choices, handle });
		return handle;
	}

	dispose(): void {
		for (const prompt of this.prompts) {
			prompt.handle.dispose();
		}
	}
}

class TestWorkbenchClipboardService extends WorkbenchBrowserClipboardService {

	readonly systemWrites: string[] = [];
	systemText = '';
	systemReads = 0;
	failSystemReads = false;
	pendingSystemRead: Promise<string> | undefined;

	constructor(
		environmentService: IWorkbenchEnvironmentService,
		notificationService = new BaseTestNotificationService()
	) {
		super(
			notificationService,
			NullOpenerService,
			environmentService,
			new NullLogService(),
			new TestLayoutService()
		);
	}

	protected override async writeTextToSystemClipboard(text: string): Promise<void> {
		this.systemWrites.push(text);
		this.systemText = text;
	}

	protected override async readTextFromSystemClipboard(): Promise<string> {
		this.systemReads++;
		if (this.pendingSystemRead) {
			return this.pendingSystemRead;
		}
		if (this.failSystemReads) {
			throw new Error('Clipboard read denied');
		}
		return this.systemText;
	}
}

function createEnvironment(
	extensionTestsLocationURI?: URI
): IWorkbenchEnvironmentService {
	return new class extends mock<IWorkbenchEnvironmentService>() {
		override readonly extensionTestsLocationURI = extensionTestsLocationURI;
	};
}

function runPromptChoice(choice: IPromptChoice): Promise<void> {
	return Promise.resolve(
		(choice.run as () => void | Promise<void>)()
	);
}

suite('Hucode Web Clipboard Service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('routes default and typed workbench clipboards', async () => {
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment()
		));

		await service.writeText('implicit');
		const implicit = await service.readText();
		await service.writeText('system', 'clipboard');
		await service.writeText('selection', 'selection');
		await service.writeText('custom', 'custom');

		assert.deepStrictEqual({
			implicit,
			system: await service.readText('clipboard'),
			selection: await service.readText('selection'),
			custom: await service.readText('custom'),
			systemReads: service.systemReads,
			systemWrites: service.systemWrites,
		}, {
			implicit: 'implicit',
			system: 'system',
			selection: 'selection',
			custom: 'custom',
			systemReads: 2,
			systemWrites: ['implicit', 'system'],
		});
	});

	test('keeps default workbench clipboards isolated in extension tests', async () => {
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment(URI.file('/extension-tests'))
		));
		const selectors = [undefined, '', 'clipboard'] as const;
		const values: string[] = [];

		for (const [index, selector] of selectors.entries()) {
			await service.writeText(`test-${index}`, selector);
			values.push(await service.readText(selector));
		}
		await service.writeText('selection', 'selection');
		await service.writeText('custom', 'custom');

		assert.deepStrictEqual({
			values,
			defaultAfterTyped: await service.readText('clipboard'),
			selection: await service.readText('selection'),
			custom: await service.readText('custom'),
			systemReads: service.systemReads,
			systemWrites: service.systemWrites,
		}, {
			values: ['test-0', 'test-1', 'test-2'],
			defaultAfterTyped: 'test-2',
			selection: 'selection',
			custom: 'custom',
			systemReads: 0,
			systemWrites: [],
		});
	});

	test('deduplicates and dismisses clipboard permission prompts', async () => {
		const notifications = store.add(new TestNotificationService());
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment(),
			notifications
		));
		service.failSystemReads = true;

		const firstRead = service.readText('clipboard');
		const secondRead = service.readText('clipboard');
		await timeout(0);
		notifications.prompts[0].handle.close();
		const values = await Promise.all([firstRead, secondRead]);

		const laterRead = service.readText('clipboard');
		await timeout(0);
		notifications.prompts[1].handle.close();

		assert.deepStrictEqual({
			values,
			laterValue: await laterRead,
			prompts: notifications.prompts.length,
		}, {
			values: ['', ''],
			laterValue: '',
			prompts: 2,
		});
	});

	test('resolves clipboard permission waiters when disposed', async () => {
		const notifications = store.add(new TestNotificationService());
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment(),
			notifications
		));
		service.failSystemReads = true;

		const firstRead = service.readText('clipboard');
		const secondRead = service.readText('clipboard');
		await timeout(0);
		service.dispose();

		assert.deepStrictEqual({
			values: await Promise.all([firstRead, secondRead]),
			prompts: notifications.prompts.length,
			promptClosed: notifications.prompts[0].handle.closed,
		}, {
			values: ['', ''],
			prompts: 1,
			promptClosed: true,
		});
	});

	test('does not prompt when disposed during a system clipboard read', async () => {
		const notifications = store.add(new TestNotificationService());
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment(),
			notifications
		));
		const pendingSystemRead = new DeferredPromise<string>();
		service.pendingSystemRead = pendingSystemRead.p;

		const read = service.readText('clipboard');
		service.dispose();
		await pendingSystemRead.error(new Error('Clipboard read denied'));

		assert.deepStrictEqual({
			value: await read,
			prompts: notifications.prompts.length,
		}, {
			value: '',
			prompts: 0,
		});
	});

	test('replaces a denied clipboard permission prompt on retry', async () => {
		const notifications = store.add(new TestNotificationService());
		const service = store.add(new TestWorkbenchClipboardService(
			createEnvironment(),
			notifications
		));
		service.failSystemReads = true;

		const firstRead = service.readText('clipboard');
		const secondRead = service.readText('clipboard');
		await timeout(0);
		const firstRetry = runPromptChoice(notifications.prompts[0].choices[0]);
		await timeout(0);

		service.failSystemReads = false;
		service.systemText = 'allowed';
		const secondRetry = runPromptChoice(notifications.prompts[1].choices[0]);
		const values = await Promise.all([firstRead, secondRead]);
		await Promise.all([firstRetry, secondRetry]);

		assert.deepStrictEqual({
			values,
			prompts: notifications.prompts.length,
			promptsClosed: notifications.prompts.map(prompt => prompt.handle.closed),
			systemReads: service.systemReads,
		}, {
			values: ['allowed', 'allowed'],
			prompts: 2,
			promptsClosed: [true, true],
			systemReads: 4,
		});
	});
});
