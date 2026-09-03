/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, scheduleAtNextAnimationFrame } from '../../../base/browser/dom.js';
import { CodeWindow } from '../../../base/browser/window.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWebviewElement, IWebviewService } from '../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri, webviewGenericCspSource } from '../../../workbench/contrib/webview/common/webview.js';
import {
	EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID,
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	EditorMigrationSetupHostMessage,
	EditorMigrationSetupIntent,
	editorMigrationSetupPhaseAdmits,
	isEditorMigrationSetupRevisionBound,
	parseEditorMigrationSetupIntentMessage,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from './editorMigrationFlow.js';
import { editorMigrationSetupPresentation } from './editorMigrationSetupPresentation.js';
import { editorMigrationRollbackEligibleCategories } from './editorMigrationFlowSections.js';

/** Renderer assets the host requires before it mounts anything. */
export const EDITOR_MIGRATION_SETUP_ASSETS = ['index.js', 'style.css'] as const;

/** Stable view type of the setup webview. */
export const EDITOR_MIGRATION_SETUP_VIEW_TYPE = 'hucode.setupUi';

/**
 * How long the host waits for the renderer's `ready` before treating the bootstrap as failed.
 *
 * Present-but-broken assets are the case this exists for: probing succeeds, the document loads,
 * and nothing ever runs. Without a deadline that leaves an empty modal with no way out.
 */
export const EDITOR_MIGRATION_SETUP_READY_TIMEOUT = 10_000;

export interface EditorMigrationSetupWebviewHostOptions {
	/** Directory holding the built renderer assets, resolved by the native host. */
	readonly mediaRoot: URI;
	/** Closes the surface framing this host. */
	readonly onDone: () => void;
	/** Overridable only so tests do not have to wait out the real deadline. */
	readonly readyTimeout?: number;
}

/**
 * Owns the setup webview end to end: asset probing, CSP, protocol validation, state delivery,
 * and disposal.
 *
 * Callers supply a migration session and host framing only. Every privileged action still runs
 * through the session, and the renderer can express nothing outside the protocol's closed intent
 * union.
 */
export class EditorMigrationSetupWebviewHost extends Disposable {
	private readonly mountDisposables = this._register(new DisposableStore());
	private readonly pendingDelivery = this._register(new MutableDisposable<IDisposable>());
	private readonly readyDeadline = this._register(new MutableDisposable<IDisposable>());
	private readonly container: HTMLElement;
	private webview: IWebviewElement | undefined;
	private ready = false;
	private revision = 0;
	private delivered: EditorMigrationFlowState | undefined;
	private statusFocusTarget: HTMLElement | undefined;
	private disposedHost = false;

	constructor(
		parent: HTMLElement,
		private readonly session: EditorMigrationFlowSession,
		private readonly options: EditorMigrationSetupWebviewHostOptions,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.container = document.createElement('div');
		this.container.className = 'hucode-setup-webview-host';
		parent.appendChild(this.container);
		this._register({ dispose: () => this.container.remove() });
		void this.mount();
	}

	/** Moves keyboard focus into the webview, or onto the failure surface that replaced it. */
	focus(): void {
		if (this.webview) {
			this.webview.focus();
			return;
		}
		this.statusFocusTarget?.focus();
	}

	/** Probes the renderer assets, then mounts the webview. Failure stays recoverable. */
	private async mount(): Promise<void> {
		this.mountDisposables.clear();
		this.readyDeadline.clear();
		this.ready = false;
		this.container.textContent = '';
		this.renderStatus(localize('editorMigration.setup.loading', "Preparing the import view..."), false);
		const missing = await this.probeAssets();
		if (this.disposedHost) {
			return;
		}
		if (missing.length) {
			this.logService.error(`[hucode] setup renderer assets missing: ${missing.join(', ')}`);
			this.renderStatus(localize('editorMigration.setup.assetsMissing', "Hucode could not load the import view because its renderer files are missing."), true);
			return;
		}
		this.container.textContent = '';
		const webview = this.mountDisposables.add(this.webviewService.createWebviewElement({
			providedViewType: EDITOR_MIGRATION_SETUP_VIEW_TYPE,
			title: localize('editorMigration.editorName', "Import Editor Setup"),
			options: {
				// The renderer owns its palette; the injected workbench variable map is removed so a
				// component cannot reach a `--vscode-*` token by accident.
				transformCssVariables: () => ({}),
			},
			contentOptions: {
				allowScripts: true,
				allowForms: false,
				enableCommandUris: false,
				localResourceRoots: [this.options.mediaRoot],
			},
			extension: undefined,
		}));
		this.webview = webview;
		this.mountDisposables.add(webview.onMessage(event => this.handleMessage(event.message)));
		this.mountDisposables.add(webview.onFatalError(error => {
			this.logService.error(`[hucode] setup webview failed: ${error.message}`);
			this.failBootstrap(localize('editorMigration.setup.rendererFailed', "The import view stopped responding. Your import is still recorded."));
		}));
		webview.setHtml(this.html());
		webview.mountTo(this.container, getWindow(this.container) as CodeWindow);
		this.mountDisposables.add(this.session.onDidChangeState(state => this.scheduleDelivery(state)));
		this.startReadyDeadline();
		webview.focus();
	}

	/**
	 * Bounds the wait for `ready`.
	 *
	 * Assets can exist and still never run — a truncated bundle, a CSP rejection, or a module-level
	 * throw all look identical from here. The deadline turns that into the same recoverable failure
	 * surface as a missing file instead of an empty modal.
	 */
	private startReadyDeadline(): void {
		const timeout = this.options.readyTimeout ?? EDITOR_MIGRATION_SETUP_READY_TIMEOUT;
		const window = getWindow(this.container);
		const handle = window.setTimeout(() => {
			this.readyDeadline.clear();
			if (this.ready || this.disposedHost) {
				return;
			}
			this.logService.error('[hucode] setup renderer did not report ready before the deadline.');
			this.failBootstrap(localize('editorMigration.setup.rendererUnresponsive', "Hucode loaded the import view's files, but the view never started."));
		}, timeout);
		this.readyDeadline.value = { dispose: () => window.clearTimeout(handle) };
	}

	/** Tears the webview down and offers the core-owned retry and close. */
	private failBootstrap(message: string): void {
		this.readyDeadline.clear();
		this.pendingDelivery.clear();
		this.mountDisposables.clear();
		this.webview = undefined;
		this.ready = false;
		this.delivered = undefined;
		this.renderStatus(message, true);
	}

	private async probeAssets(): Promise<readonly string[]> {
		const missing: string[] = [];
		for (const asset of EDITOR_MIGRATION_SETUP_ASSETS) {
			const exists = await this.fileService.exists(URI.joinPath(this.options.mediaRoot, asset)).catch(() => false);
			if (!exists) {
				missing.push(asset);
			}
		}
		return missing;
	}

	/**
	 * Core-owned status surface.
	 *
	 * A blank modal gives the user nothing to do, so probing and renderer failures always land on
	 * a message with a bounded retry and a close.
	 */
	private renderStatus(message: string, retryable: boolean): void {
		this.container.textContent = '';
		this.statusFocusTarget = undefined;
		const panel = document.createElement('div');
		panel.className = 'hucode-setup-webview-status';
		panel.setAttribute('role', retryable ? 'alert' : 'status');
		const text = document.createElement('p');
		text.textContent = message;
		panel.appendChild(text);
		if (retryable) {
			const actions = document.createElement('div');
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.textContent = localize('editorMigration.setup.retry', "Try Again");
			retry.addEventListener('click', () => void this.mount());
			const close = document.createElement('button');
			close.type = 'button';
			close.textContent = localize('editorMigration.setup.close', "Close");
			close.addEventListener('click', () => this.options.onDone());
			actions.append(retry, close);
			panel.appendChild(actions);
			this.statusFocusTarget = retry;
			this.mountDisposables.add({ dispose: () => panel.remove() });
		}
		this.container.appendChild(panel);
	}

	/**
	 * Strict-CSP document. Only the two local assets load, and only the module script runs.
	 *
	 * The body carries a localized fallback that React replaces on mount. It is the only
	 * user-visible copy the renderer document owns, and it exists so a bundle that never runs still
	 * says something while the ready deadline is counting down.
	 */
	private html(): string {
		const nonce = generateUuid();
		const script = asWebviewUri(URI.joinPath(this.options.mediaRoot, 'index.js')).toString(true);
		const style = asWebviewUri(URI.joinPath(this.options.mediaRoot, 'style.css')).toString(true);
		const csp = [
			`default-src 'none'`,
			`img-src ${webviewGenericCspSource} data:`,
			`style-src ${webviewGenericCspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${webviewGenericCspSource}`,
		].join('; ');
		const fallback = escapeHtml(localize('editorMigration.setup.bootstrap', "Starting the editor setup import..."));
		const title = escapeHtml(localize('editorMigration.editorName', "Import Editor Setup"));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="root"><p class="hucode-setup-bootstrap" role="status">${fallback}</p></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	// #region protocol

	private handleMessage(raw: unknown): void {
		const message = parseEditorMigrationSetupIntentMessage(raw);
		if (!message) {
			this.logService.warn('[hucode] setup webview sent a message outside the protocol; ignoring it.');
			return;
		}
		const { intent } = message;
		if (intent.type === 'ready') {
			this.ready = true;
			this.readyDeadline.clear();
			this.deliver(this.session.state, true);
			// The modal has just opened, so the first thing a keyboard user needs is a landing
			// point inside the webview rather than the document body.
			this.post({
				protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
				type: 'focus',
				revision: this.revision,
				focusId: EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID,
			});
			return;
		}
		if (intent.type === 'close') {
			this.options.onDone();
			return;
		}
		/*
		 * A gesture the session has already moved past is a duplicate, not a mistake.
		 *
		 * Rapidly confirming publishers twice is the case that matters: the first click starts the
		 * import, and the second must neither start a second one nor cancel the first. Answering it
		 * with the current snapshot and no error keeps the user on the screen they are already
		 * looking at, because the phase change is the explanation.
		 */
		const state = this.session.state;
		if (!editorMigrationSetupPhaseAdmits(intent.type, state.phase, state.busy)) {
			this.logService.trace(`[hucode] setup webview intent superseded: ${intent.type} in phase ${state.phase}.`);
			this.deliver(state, true);
			return;
		}
		if (isEditorMigrationSetupRevisionBound(intent.type) && message.revision !== this.revision) {
			this.logService.trace('[hucode] setup webview intent refused: stale revision.');
			this.refuse(localize('editorMigration.setup.staleGesture', "That choice was made against an earlier version of this screen and was not applied. The screen has been refreshed; try again."));
			return;
		}
		if (!this.dispatch(intent)) {
			this.logService.warn(`[hucode] setup webview intent refused: ${intent.type} does not resolve against current state.`);
			this.refuse(localize('editorMigration.setup.unavailableChoice', "That choice is no longer available. The screen has been refreshed with the current options."));
			return;
		}
		this.post({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'accepted', revision: this.revision, intentType: intent.type });
	}

	/**
	 * Answers a refused gesture with a localized reason and the authoritative state behind it.
	 *
	 * Silently dropping the gesture leaves the user looking at a control that appears to have done
	 * nothing. Resending the snapshot advances the revision, which also retires whatever stale
	 * revision the renderer was still holding.
	 */
	private refuse(message: string): void {
		this.deliver(this.session.state, true);
		this.post({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'error', revision: this.revision, message });
	}

	/**
	 * Resolves an intent against current state and calls the matching session method.
	 *
	 * Returns false when the intent names something the current state does not offer. Nothing here
	 * accepts a command ID, path, URI, or service method from the webview.
	 */
	private dispatch(intent: Exclude<EditorMigrationSetupIntent, { type: 'ready' } | { type: 'close' }>): boolean {
		const state = this.session.state;
		switch (intent.type) {
			case 'startImport':
				void this.session.startImport();
				return true;
			case 'refreshDiscovery':
				void this.session.refreshDiscovery();
				return true;
			case 'selectApplication': {
				if (!state.applications.some(application => application.id === intent.applicationId)) {
					return false;
				}
				this.session.selectApplication(intent.applicationId);
				return true;
			}
			case 'selectSourceProfile': {
				const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
				const source = application?.profiles.find(profile => profile.ref.value === intent.sourceRef);
				if (!source) {
					return false;
				}
				this.session.selectSourceProfile(source.ref);
				return true;
			}
			case 'continueFromProfile':
				void this.session.continueFromProfile();
				return true;
			case 'selectTarget': {
				const requested = intent.target;
				if (requested.kind === 'existing') {
					const target = state.targets.find(candidate => candidate.selection.profileId === requested.profileId);
					if (!target) {
						return false;
					}
					this.session.selectTarget(target.selection);
					return true;
				}
				const name = requested.name.trim();
				if (!name) {
					return false;
				}
				this.session.selectTarget({ kind: 'proposed', name });
				return true;
			}
			case 'continueFromTarget':
				void this.session.continueFromTarget();
				return true;
			case 'rebuildReview':
				void this.session.rebuildReview();
				return true;
			case 'toggleCategory': {
				if (!state.draft?.target.requestedCategories.includes(intent.category)) {
					return false;
				}
				this.session.toggleCategory(intent.category, intent.selected);
				return true;
			}
			case 'chooseDecision': {
				if (!state.draft?.decisions.some(decision => decision.id === intent.decisionId && decision.kind === 'conflict')) {
					return false;
				}
				this.session.chooseDecision(intent.decisionId, intent.choice);
				return true;
			}
			case 'chooseAllSettingDifferences':
				this.session.chooseAllSettingDifferences(intent.choice);
				return true;
			case 'acceptReview':
				void this.session.acceptReview();
				return true;
			case 'confirmPublishers':
				void this.session.confirmPublishers();
				return true;
			case 'requestCancellation':
				this.session.requestCancellation();
				return true;
			case 'showRecovery': {
				if (!state.recoveries.some(recovery => recovery.id === intent.operationId && recovery.unsupportedSchemaVersion === undefined)) {
					return false;
				}
				void this.session.showRecovery(intent.operationId);
				return true;
			}
			case 'resume':
			case 'retry': {
				if (state.operation?.id !== intent.operationId) {
					return false;
				}
				void (intent.type === 'resume' ? this.session.resume(intent.operationId) : this.session.retry(intent.operationId));
				return true;
			}
			case 'inspectRollback': {
				const eligible = this.rollbackEligible(state);
				if (!intent.categories.length || !intent.categories.every(category => eligible.includes(category))) {
					return false;
				}
				void this.session.inspectRollback(intent.categories);
				return true;
			}
			case 'clearRollbackInspection':
				this.session.clearRollbackInspection();
				return true;
			case 'rollback': {
				const eligible = this.rollbackEligible(state);
				const drifted = state.rollbackInspection?.driftedCategories ?? [];
				if (!intent.categories.length || !intent.categories.every(category => eligible.includes(category))) {
					return false;
				}
				// Forcing past drift is only ever authorized for the categories the current
				// inspection actually reported as drifted.
				if (!intent.forceCategories.every(category => drifted.includes(category) && intent.categories.includes(category))) {
					return false;
				}
				void this.session.rollback(intent.categories, intent.forceCategories);
				return true;
			}
			case 'copyReport':
				void this.session.copyReport();
				return true;
			case 'acknowledge':
				void this.session.acknowledge();
				return true;
			case 'back':
				this.session.back();
				return true;
		}
	}

	private rollbackEligible(state: EditorMigrationFlowState): readonly Exclude<import('../../common/migration/editorMigrationSource.js').EditorMigrationCategory, 'extensions'>[] {
		return state.operation ? editorMigrationRollbackEligibleCategories(state.operation) : [];
	}

	// #endregion

	// #region state delivery

	/**
	 * Progress-only snapshots are coalesced latest-wins to at most one delivery per animation
	 * frame. Phase changes, admitted operation identity, errors, cancellation, and terminal states
	 * cross immediately. Skipping an intermediate snapshot never skips a durable journal update,
	 * because the journal is written by the session, not by this delivery.
	 */
	private scheduleDelivery(state: EditorMigrationFlowState): void {
		if (!this.ready || !this.webview) {
			return;
		}
		if (!isProgressOnlyChange(this.delivered, state)) {
			this.pendingDelivery.clear();
			this.deliver(state, true);
			return;
		}
		if (this.pendingDelivery.value) {
			return;
		}
		this.pendingDelivery.value = scheduleAtNextAnimationFrame(getWindow(this.container), () => {
			this.pendingDelivery.clear();
			this.deliver(this.session.state, true);
		});
	}

	private deliver(state: EditorMigrationFlowState, advanceRevision: boolean): void {
		if (!this.webview) {
			return;
		}
		if (advanceRevision) {
			this.revision += 1;
		}
		this.delivered = state;
		this.post({
			protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
			type: 'state',
			revision: this.revision,
			presentation: editorMigrationSetupPresentation(state, this.revision),
		});
	}

	private post(message: EditorMigrationSetupHostMessage): void {
		// A disposed webview or a refused post is renderer loss, not migration loss: the session
		// and journal keep the admitted operation, and reopening rebuilds the view from them.
		this.webview?.postMessage(message).catch(error => this.logService.trace(`[hucode] setup webview post failed: ${error}`));
	}

	// #endregion

	override dispose(): void {
		this.disposedHost = true;
		this.readyDeadline.clear();
		this.post({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'disposed' });
		this.webview = undefined;
		this.ready = false;
		super.dispose();
	}
}

/** Minimal escaping for the two localized strings the bootstrap document embeds. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		'\'': '&#39;',
	}[character] ?? character));
}

/** True when nothing but Apply progress and its announcement changed. */
export function isProgressOnlyChange(previous: EditorMigrationFlowState | undefined, next: EditorMigrationFlowState): boolean {
	if (!previous || !previous.progress || !next.progress) {
		return false;
	}
	return previous.phase === next.phase
		&& previous.busy === next.busy
		&& previous.canceling === next.canceling
		&& previous.error === next.error
		&& previous.operation === next.operation
		&& previous.reviewedPlan === next.reviewedPlan
		&& previous.rollbackInspection === next.rollbackInspection
		&& previous.progress.operationId === next.progress.operationId
		&& previous.progress.stage === next.progress.stage;
}
