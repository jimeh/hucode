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
import { bindEditorMigrationCloseCancellation, shouldCancelEditorMigrationOnClose } from '../../browser/migration/editorMigrationSetupClose.js';
import {
	EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID,
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	EditorMigrationSetupIntent,
} from '../../common/migration/editorMigrationSetupProtocol.js';
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
		assert.deepStrictEqual(webview.posted.map(message => message.type), ['state', 'focus']);
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
		// Each refusal answers with a fresh snapshot, so the current revision has to be re-read.
		const currentRevision = () => webview.posted.filter(message => message.type === 'state').at(-1)!.revision;

		send(webview, currentRevision(), { type: 'selectApplication', applicationId: 'unknown-editor' });
		assert.deepStrictEqual(session.calls, [], 'an identifier the state does not offer is refused');

		send(webview, currentRevision() - 1, { type: 'selectApplication', applicationId: 'cursor' });
		assert.deepStrictEqual(session.calls, [], 'a revision-bound action from a superseded snapshot is refused');

		send(webview, currentRevision(), { type: 'selectApplication', applicationId: 'cursor' });
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

	test('gives up on a bundle that never reports ready and offers the same retry path', async () => {
		const webviews = new StubWebviewService();
		const parent = testParent();
		const session = sessionStub({ phase: 'application', applications: [application('cursor')] });
		const host = disposables.add(new EditorMigrationSetupWebviewHost(
			parent,
			session,
			// A short deadline keeps this a behaviour test rather than a ten-second wait.
			{ mediaRoot: MEDIA_ROOT, onDone: () => { }, readyTimeout: 10 },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		assert.strictEqual(webviews.created.length, 1, 'present assets still mount');
		assert.strictEqual(parent.querySelector('.hucode-setup-webview-status'), null);

		await timeout(40);

		const status = parent.querySelector('.hucode-setup-webview-status');
		assert.ok(status, 'an existing but silent bundle must not leave an empty modal');
		assert.strictEqual(status!.getAttribute('role'), 'alert');
		assert.deepStrictEqual([...parent.getElementsByTagName('button')].length, 2, 'retry and close');
		assert.deepStrictEqual(session.calls, [], 'a dead renderer must not disturb the migration');

		[...parent.getElementsByTagName('button')][0].click();
		await settle();
		assert.strictEqual(webviews.created.length, 2, 'the retry remounts');
		host.dispose();
	});

	test('clears the ready deadline once the renderer answers', async () => {
		const webviews = new StubWebviewService();
		const parent = testParent();
		disposables.add(new EditorMigrationSetupWebviewHost(
			parent,
			sessionStub({ phase: 'application' }),
			{ mediaRoot: MEDIA_ROOT, onDone: () => { }, readyTimeout: 10 },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;
		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });

		await timeout(40);

		assert.strictEqual(parent.querySelector('.hucode-setup-webview-status'), null, 'a ready renderer must not be torn down');
		assert.ok(webview.posted.some(message => message.type === 'state'));
	});

	test('ships a localized bootstrap fallback and asks for the first heading after ready', async () => {
		const webviews = new StubWebviewService();
		disposables.add(new EditorMigrationSetupWebviewHost(
			testParent(),
			sessionStub({ phase: 'application', applications: [application('cursor')] }),
			{ mediaRoot: MEDIA_ROOT, onDone: () => { } },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		const [webview] = webviews.created;

		assert.match(webview.html ?? '', /<div id="root"><p class="hucode-setup-bootstrap" role="status">[^<]+<\/p><\/div>/);
		assert.doesNotMatch(webview.html ?? '', /<div id="root"><\/div>/);
		assert.strictEqual(webview.focused, true, 'mounting moves focus into the webview');

		webview.receive({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });

		const focusMessage = webview.posted.find(message => message.type === 'focus');
		assert.ok(focusMessage, 'the renderer needs a landing point once it has a snapshot');
		assert.strictEqual(focusMessage.focusId, EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID);
		assert.strictEqual(focusMessage.revision, webview.posted.find(message => message.type === 'state').revision);
	});

	test('answers a refused gesture with the current state and a localized reason', async () => {
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
		webview.posted.length = 0;

		send(webview, revision - 1, { type: 'selectApplication', applicationId: 'cursor' });

		assert.deepStrictEqual(session.calls, [], 'a stale gesture still runs no session method');
		const answer = webview.posted.map(message => message.type);
		assert.deepStrictEqual(answer, ['state', 'error'], 'the user gets the authoritative state and a reason');
		assert.ok(webview.posted[1].message.length > 0);
		assert.strictEqual(webview.posted[1].revision, webview.posted[0].revision, 'the reason describes the state alongside it');

		// The refreshed revision is the one the renderer must now use.
		send(webview, webview.posted[0].revision, { type: 'selectApplication', applicationId: 'cursor' });
		assert.deepStrictEqual(session.calls, [['selectApplication', 'cursor']]);
	});

	test('refuses an unresolvable identifier with the same recoverable answer', async () => {
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
		webview.posted.length = 0;

		send(webview, revision, { type: 'selectApplication', applicationId: 'unknown-editor' });

		assert.deepStrictEqual(session.calls, []);
		assert.deepStrictEqual(webview.posted.map(message => message.type), ['state', 'error']);
	});

	test('cancels an in-flight Apply when the input closes, and only then', () => {
		const applying = sessionStub({ phase: 'apply', progress: progress('applying', 1) });
		const closing = new Emitter<void>();
		disposables.add(bindEditorMigrationCloseCancellation(applying, closing.event));
		closing.fire();
		assert.deepStrictEqual(applying.calls, [['requestCancellation']], 'Escape and outside-click reach this path, not the renderer');
		closing.dispose();

		const reviewing = sessionStub({ phase: 'review' });
		const reviewClosing = new Emitter<void>();
		disposables.add(bindEditorMigrationCloseCancellation(reviewing, reviewClosing.event));
		reviewClosing.fire();
		assert.deepStrictEqual(reviewing.calls, [], 'a choice screen has nothing to cancel');
		reviewClosing.dispose();

		assert.strictEqual(shouldCancelEditorMigrationOnClose(flowState({ phase: 'apply' })), true);
		for (const phase of ['loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'results'] as const) {
			assert.strictEqual(shouldCancelEditorMigrationOnClose(flowState({ phase })), false, `${phase} must not cancel`);
		}
	});

	test('does not treat renderer loss or a remount as a close', async () => {
		const webviews = new StubWebviewService();
		const parent = testParent();
		const session = sessionStub({ phase: 'apply', progress: progress('applying', 1) });
		const host = disposables.add(new EditorMigrationSetupWebviewHost(
			parent,
			session,
			{ mediaRoot: MEDIA_ROOT, onDone: () => { }, readyTimeout: 10 },
			webviews as unknown as IWebviewService,
			fileServiceStub(() => true),
			new NullLogService(),
		));
		await settle();
		webviews.created[0].fail('renderer crashed');
		await timeout(40);

		assert.deepStrictEqual(session.calls, [], 'a dead webview during Apply is presentation loss, not cancellation');
		[...parent.getElementsByTagName('button')][0].click();
		await settle();
		assert.strictEqual(webviews.created.length, 2);
		assert.deepStrictEqual(session.calls, [], 'remounting the view must not cancel either');
		host.dispose();
		assert.deepStrictEqual(session.calls, [], 'host disposal alone is not a close of the import');
	});

	test('starts one import for a rapid duplicate publisher confirmation and cancels nothing', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'publishers', publishers: ['acme'] });
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
		const shownRevision = webview.posted.find(message => message.type === 'state').revision;

		// The first click is admitted, and the session immediately reports the phase it moved to.
		send(webview, shownRevision, { type: 'confirmPublishers' });
		assert.deepStrictEqual(session.calls, [['confirmPublishers']]);
		session.publish({ phase: 'apply', busy: true, progress: progress('applying', 0) });

		// The second click was formed against the screen the user was still looking at.
		webview.posted.length = 0;
		send(webview, shownRevision, { type: 'confirmPublishers' });

		assert.deepStrictEqual(session.calls, [['confirmPublishers']], 'only one import may start');
		assert.ok(!session.calls.some(call => call[0] === 'requestCancellation'), 'the duplicate must not cancel the first generation');
		// A superseded duplicate is answered with the current screen and no error: the phase change
		// is the whole explanation, and an alert would only be noise.
		assert.deepStrictEqual(webview.posted.map(message => message.type), ['state']);
		assert.strictEqual(webview.posted[0].presentation.phase, 'apply');
	});

	test('refuses phase-advancing and bulk actions the session has already moved past', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'publishers' });
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
		const currentRevision = () => webview.posted.filter(message => message.type === 'state').at(-1)!.revision;

		// Review is behind us: neither accepting it again nor rewriting its decisions is legal.
		send(webview, currentRevision(), { type: 'acceptReview' });
		send(webview, currentRevision(), { type: 'chooseAllSettingDifferences', choice: 'import' });
		send(webview, currentRevision(), { type: 'rebuildReview' });
		assert.deepStrictEqual(session.calls, []);

		// Confirming publishers is the one phase-advancing action this screen offers.
		send(webview, currentRevision(), { type: 'confirmPublishers' });
		assert.deepStrictEqual(session.calls, [['confirmPublishers']]);
	});

	test('refuses an accepted review while the session is still working', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'review', busy: true });
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
		const revision = webview.posted.find(message => message.type === 'state').revision;

		send(webview, revision, { type: 'acceptReview' });
		assert.deepStrictEqual(session.calls, [], 'a busy session admits no second review acceptance');

		session.publish({ busy: false });
		send(webview, webview.posted.filter(message => message.type === 'state').at(-1)!.revision, { type: 'acceptReview' });
		assert.deepStrictEqual(session.calls, [['acceptReview']]);
	});

	test('starts one source read for a rapid duplicate profile Continue', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'profile', selectedSourceRef: { value: 'cursor-default' } });
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
		const shown = webview.posted.find(message => message.type === 'state').revision;

		send(webview, shown, { type: 'continueFromProfile' });
		assert.deepStrictEqual(session.calls, [['continueFromProfile']]);
		// The session publishes `busy` before its first await, which is what the guard reads.
		session.publish({ busy: true });

		send(webview, shown, { type: 'continueFromProfile' });
		assert.deepStrictEqual(session.calls, [['continueFromProfile']], 'a working session reads the source once');

		// And once it has landed on Target, Continue no longer belongs to this screen at all.
		session.publish({ phase: 'target', busy: false });
		send(webview, shown, { type: 'continueFromProfile' });
		assert.deepStrictEqual(session.calls, [['continueFromProfile']]);
	});

	test('moves exactly one phase for a rapid duplicate Back', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'review' });
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
		const shown = webview.posted.find(message => message.type === 'state').revision;

		send(webview, shown, { type: 'back' });
		assert.deepStrictEqual(session.calls, [['back']]);
		// Back is still legal in the phase it lands on, so only the revision binding stops the
		// second press from skipping Target entirely.
		session.publish({ phase: 'target' });

		send(webview, shown, { type: 'back' });
		assert.deepStrictEqual(session.calls, [['back']], 'a double press must not skip two phases');
	});

	test('restarts discovery once for a rapid duplicate Start Another Import', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'recovery' });
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
		const revision = () => webview.posted.filter(message => message.type === 'state').at(-1)!.revision;

		send(webview, revision(), { type: 'startImport' });
		assert.deepStrictEqual(session.calls, [['startImport']]);
		session.publish({ phase: 'loading', busy: true });

		send(webview, revision(), { type: 'startImport' });
		assert.deepStrictEqual(session.calls, [['startImport']], 'the second press would discard the first discovery');
	});

	test('deletes recovery data once and never outside Results', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'results', operation: settledOperation() });
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
		const revision = () => webview.posted.filter(message => message.type === 'state').at(-1)!.revision;

		send(webview, revision(), { type: 'acknowledge' });
		assert.deepStrictEqual(session.calls, [['acknowledge']]);

		// Acknowledgement reaches the durable journal before publishing anything, so the host guard
		// cannot see a duplicate inside that window; the session's own one-shot closes it. Once the
		// deletion has restarted discovery, the phase guard takes over.
		session.publish({ phase: 'loading', busy: true });
		send(webview, revision(), { type: 'acknowledge' });
		assert.deepStrictEqual(session.calls, [['acknowledge']]);
	});

	test('keeps read-only Results gestures usable while the session is working', async () => {
		const webviews = new StubWebviewService();
		const session = sessionStub({ phase: 'results', busy: true, operation: settledOperation() });
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
		const revision = webview.posted.find(message => message.type === 'state').revision;

		send(webview, revision, { type: 'copyReport' });
		send(webview, revision, { type: 'clearRollbackInspection' });
		assert.deepStrictEqual(session.calls, [['copyReport'], ['clearRollbackInspection']], 'changing nothing must not become a dead control');

		// Anything that starts work still waits.
		send(webview, revision, { type: 'rollback', categories: ['settings'], forceCategories: [] });
		assert.deepStrictEqual(session.calls, [['copyReport'], ['clearRollbackInspection']]);
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

/** The smallest settled operation the Results presenter can describe. */
function settledOperation(): NonNullable<EditorMigrationFlowState['operation']> {
	return {
		id: 'operation',
		stage: 'settled',
		aggregateOutcome: 'completed',
		results: [{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 }],
		snapshots: [],
		extensionInstallIntents: [],
		plan: {
			choices: { selectedCategories: ['settings'], decisions: [] },
			operations: [],
			exclusions: [],
			source: { categories: [{ category: 'settings', state: 'present', value: { 'editor.fontSize': 13 } }] },
			target: { requestedCategories: ['settings'], categories: [], selection: { kind: 'existing', profileId: 'default' }, profile: { id: 'default', name: 'Default', kind: 'default' } },
			prerequisites: [],
			warnings: [],
			decisions: [],
		},
	} as unknown as NonNullable<EditorMigrationFlowState['operation']>;
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
	focused = false;
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

	focus(): void {
		this.focused = true;
	}

	fail(message: string): void {
		this.fatalEmitter.fire({ message });
	}

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
