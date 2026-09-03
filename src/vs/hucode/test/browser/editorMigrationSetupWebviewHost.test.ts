/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { timeout } from '../../../base/common/async.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IWebviewElement, IWebviewService, WebviewInitInfo, WebviewMessageReceivedEvent } from '../../../workbench/contrib/webview/browser/webview.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import {
	EDITOR_MIGRATION_SETUP_ASSETS,
	EditorMigrationSetupWebviewHost,
	isProgressOnlyChange,
} from '../../browser/migration/editorMigrationSetupWebviewHost.js';
import { EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, EditorMigrationSetupIntent } from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationApplyProgress } from '../../common/migration/editorMigrationApply.js';

const MEDIA_ROOT = URI.file('/builtin/hucode-setup-ui/media');

suite('EditorMigrationSetupWebviewHost', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('probes both renderer assets and offers retry instead of a blank modal', async () => {
		const parent = testParent();
		const probed: string[] = [];
		let present = false;
		const webviews = new StubWebviewService();
		const host = disposables.add(new EditorMigrationSetupWebviewHost(
			parent,
			sessionStub({ phase: 'application' }),
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(resource => {
				probed.push(resource.path);
				return present;
			}),
			new NullLogService(),
		));
		await settle();

		assert.deepStrictEqual(probed.map(path => path.split('/').pop()), [...EDITOR_MIGRATION_SETUP_ASSETS]);
		assert.strictEqual(webviews.created.length, 0, 'nothing mounts while an asset is missing');
		const status = parent.querySelector('.hucode-setup-webview-status');
		assert.ok(status, 'a core-owned failure surface replaces the blank modal');
		assert.strictEqual(status!.getAttribute('role'), 'alert');
		const retry = [...parent.getElementsByTagName('button')][0];
		assert.ok(retry);

		present = true;
		retry.click();
		await settle();
		assert.strictEqual(webviews.created.length, 1, 'the bounded retry mounts once the assets exist');
		host.dispose();
	});

	test('locks the webview to a strict CSP, one local root, and an empty theme variable map', async () => {
		const webviews = new StubWebviewService();
		const parent = testParent();
		disposables.add(new EditorMigrationSetupWebviewHost(
			parent,
			sessionStub({ phase: 'application' }),
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();

		const [webview] = webviews.created;
		assert.ok(webview);
		assert.strictEqual(webview.init.contentOptions.allowScripts, true);
		assert.strictEqual(webview.init.contentOptions.allowForms, false);
		assert.strictEqual(webview.init.contentOptions.enableCommandUris, false);
		assert.deepStrictEqual(webview.init.contentOptions.localResourceRoots?.map(root => root.toString()), [MEDIA_ROOT.toString()]);
		assert.deepStrictEqual(webview.init.options.transformCssVariables?.({ '--vscode-foreground': '#fff' }), {});

		const html = webview.html ?? '';
		assert.match(html, /default-src 'none'/);
		assert.doesNotMatch(html, /connect-src/);
		const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
		assert.ok(nonce, 'the module script must be nonce-gated');
		assert.match(html, new RegExp(`<script type="module" nonce="${nonce}"`));
		assert.doesNotMatch(html, /http:\/\/|https:\/\/(?!\*\.vscode-cdn\.net|file\+)/);
	});

	test('answers ready with the current snapshot and refuses input outside the protocol', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'application', applications: [application('cursor')] });
		disposables.add(new EditorMigrationSetupWebviewHost(
			testParent(),
			session,
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;

		webview.receive({ protocolVersion: 999, revision: 0, intent: { type: 'ready' } });
		assert.strictEqual(webview.posted.length, 0, 'a foreign protocol version never reaches the session');
		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });
		assert.strictEqual(webview.posted.length, 1);
		assert.strictEqual(webview.posted[0].type, 'state');
		assert.strictEqual(webview.posted[0].presentation.phase, 'application');

		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 1, intent: { type: 'runCommand', id: 'workbench.action.quit' } });
		webview.receive('startImport');
		assert.deepStrictEqual(session.calls, []);
	});

	test('refuses identifiers absent from the current state and stale revision-bound actions', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'application', applications: [application('cursor')] });
		disposables.add(new EditorMigrationSetupWebviewHost(
			testParent(),
			session,
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;
		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });
		const revision = webview.posted[0].revision;

		send(webview, revision, { type: 'selectApplication', applicationId: 'unknown-editor' });
		assert.deepStrictEqual(session.calls, [], 'an identifier the state does not offer is refused');

		send(webview, revision - 1, { type: 'selectApplication', applicationId: 'cursor' });
		assert.deepStrictEqual(session.calls, [], 'a revision-bound action from a superseded snapshot is refused');

		send(webview, revision, { type: 'selectApplication', applicationId: 'cursor' });
		assert.deepStrictEqual(session.calls, [['selectApplication', 'cursor']]);
		assert.strictEqual(webview.posted.at(-1)?.type, 'accepted');

		// A non-revision-bound action stays available regardless of the snapshot it was formed on.
		send(webview, 0, { type: 'refreshDiscovery' });
		assert.deepStrictEqual(session.calls.at(-1), ['refreshDiscovery']);
	});

	test('coalesces progress-only snapshots and delivers boundaries immediately', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'apply', progress: progress('applying', 1) });
		disposables.add(new EditorMigrationSetupWebviewHost(
			testParent(),
			session,
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;
		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });
		const baseline = webview.posted.length;

		session.publish({ progress: progress('applying', 2) });
		session.publish({ progress: progress('applying', 3) });
		session.publish({ progress: progress('applying', 4) });
		assert.strictEqual(webview.posted.length, baseline, 'progress-only snapshots wait for the next frame');
		await animationFrame();
		assert.strictEqual(webview.posted.length, baseline + 1, 'the frame delivers only the latest progress');
		assert.match(webview.posted.at(-1)!.presentation.footer.lines[0], /4 of 10/);

		session.publish({ progress: progress('settled', 10) });
		assert.strictEqual(webview.posted.length, baseline + 2, 'a stage boundary crosses immediately');
		session.publish({ error: 'apply failed' });
		assert.strictEqual(webview.posted.at(-1)?.presentation.error, 'apply failed');
	});

	test('treats renderer loss as presentation loss, never migration loss', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'apply', progress: progress('applying', 1) });
		const host = disposables.add(new EditorMigrationSetupWebviewHost(
			testParent(),
			session,
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;
		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });
		webview.failPosts = true;

		session.publish({ progress: progress('settled', 10) });
		assert.deepStrictEqual(session.calls, [], 'a refused post must not cancel or alter the admitted operation');
		host.dispose();
		assert.deepStrictEqual(session.calls, []);
	});

	test('classifies only Apply progress and its announcement as coalescable', () => {
		const base = flowState({ phase: 'apply', progress: progress('applying', 1) });
		assert.strictEqual(isProgressOnlyChange(base, { ...base, progress: progress('applying', 2), announcement: '2 of 10' }), true);
		assert.strictEqual(isProgressOnlyChange(base, { ...base, progress: progress('snapshotting', 2) }), false);
		assert.strictEqual(isProgressOnlyChange(base, { ...base, canceling: true }), false);
		assert.strictEqual(isProgressOnlyChange(base, { ...base, error: 'failed' }), false);
		assert.strictEqual(isProgressOnlyChange(base, { ...base, phase: 'results' }), false);
		assert.strictEqual(isProgressOnlyChange(undefined, base), false);
	});
});

// #region stubs

function testParent(): HTMLElement {
	const parent = mainWindow.document.createElement('div');
	mainWindow.document.body.appendChild(parent);
	return parent;
}

function send(webview: StubWebview, revision: number, intent: EditorMigrationSetupIntent): void {
	webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision, intent });
}

/** Waits for the host's asset probing microtasks to settle. */
async function settle(): Promise<void> {
	await timeout(0);
	await timeout(0);
}

function animationFrame(): Promise<void> {
	return new Promise(resolve => mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(() => resolve())));
}

function flowState(overrides: Partial<EditorMigrationFlowState>): EditorMigrationFlowState {
	return {
		phase: 'loading',
		busy: false,
		canceling: false,
		recoveries: [],
		applications: [],
		discoveryDiagnostics: [],
		targets: [],
		selectedCategories: [],
		decisions: {},
		publishers: [],
		reviewNeedsRebuild: false,
		...overrides,
	};
}

function progress(stage: EditorMigrationApplyProgress['stage'], recorded: number): EditorMigrationApplyProgress {
	return {
		operationId: 'operation',
		revision: recorded,
		stage,
		target: { profileId: 'work', name: 'Work' },
		selectedItemCount: 10,
		results: Array.from({ length: recorded }, (_, index) => ({ id: `item-${index}`, category: 'settings' as const, outcome: 'completed' as const, attempts: 1 })),
		cancellationRequested: false,
	} as unknown as EditorMigrationApplyProgress;
}

function application(id: string) {
	return { id, productName: 'Cursor', channel: 'stable' as const, profiles: [] };
}

interface SessionStub extends EditorMigrationFlowSession {
	readonly calls: (readonly unknown[])[];
	publish(overrides: Partial<EditorMigrationFlowState>): void;
}

/**
 * Stands in for the migration session.
 *
 * The host must never do anything but call a public session method, so the stub records the call
 * rather than running any migration behaviour.
 */
function sessionStub(initial: Partial<EditorMigrationFlowState>): SessionStub {
	const emitter = new Emitter<EditorMigrationFlowState>();
	const calls: (readonly unknown[])[] = [];
	let current = flowState(initial);
	const record = (name: string) => (...args: unknown[]) => {
		calls.push([name, ...args]);
		return Promise.resolve();
	};
	return {
		calls,
		get state() { return current; },
		onDidChangeState: emitter.event as Event<EditorMigrationFlowState>,
		publish(overrides: Partial<EditorMigrationFlowState>) {
			current = { ...current, ...overrides };
			emitter.fire(current);
		},
		startImport: record('startImport'),
		refreshDiscovery: record('refreshDiscovery'),
		selectApplication: record('selectApplication'),
		selectSourceProfile: record('selectSourceProfile'),
		continueFromProfile: record('continueFromProfile'),
		selectTarget: record('selectTarget'),
		continueFromTarget: record('continueFromTarget'),
		rebuildReview: record('rebuildReview'),
		toggleCategory: record('toggleCategory'),
		chooseDecision: record('chooseDecision'),
		chooseAllSettingDifferences: record('chooseAllSettingDifferences'),
		acceptReview: record('acceptReview'),
		confirmPublishers: record('confirmPublishers'),
		requestCancellation: record('requestCancellation'),
		showRecovery: record('showRecovery'),
		resume: record('resume'),
		retry: record('retry'),
		inspectRollback: record('inspectRollback'),
		clearRollbackInspection: record('clearRollbackInspection'),
		rollback: record('rollback'),
		copyReport: record('copyReport'),
		acknowledge: record('acknowledge'),
		back: record('back'),
	} as unknown as SessionStub;
}

class StubWebview {
	html: string | undefined;
	failPosts = false;
	readonly posted: any[] = [];
	private readonly messageEmitter = new Emitter<WebviewMessageReceivedEvent>();
	private readonly fatalEmitter = new Emitter<{ readonly message: string }>();

	constructor(readonly init: WebviewInitInfo) { }

	readonly onMessage = this.messageEmitter.event;
	readonly onFatalError = this.fatalEmitter.event;

	setHtml(html: string): void {
		this.html = html;
	}

	mountTo(): void { }

	postMessage(message: any): Promise<boolean> {
		if (this.failPosts) {
			return Promise.reject(new Error('webview disposed'));
		}
		this.posted.push(message);
		return Promise.resolve(true);
	}

	receive(message: unknown): void {
		this.messageEmitter.fire({ message });
	}

	dispose(): void {
		this.messageEmitter.dispose();
		this.fatalEmitter.dispose();
	}
}

class StubWebviewService implements Partial<IWebviewService> {
	readonly created: StubWebview[] = [];

	createWebviewElement(init: WebviewInitInfo): IWebviewElement {
		const webview = new StubWebview(init);
		this.created.push(webview);
		return webview as unknown as IWebviewElement;
	}
}

function fileServiceStub(exists: (resource: URI) => boolean): IFileService {
	return { exists: async (resource: URI) => exists(resource) } as unknown as IFileService;
}

// #endregion
