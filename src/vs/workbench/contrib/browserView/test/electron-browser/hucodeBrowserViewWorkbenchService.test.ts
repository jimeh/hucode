/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewEvent, BrowserViewPresentation, BrowserViewStorageScope, browserZoomDefaultIndex, IBrowserViewCreateOptions, IBrowserViewHost, IBrowserViewInfo, serializeBrowserViewInfo } from '../../../../../platform/browserView/common/browserView.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { INativeWorkbenchEnvironmentService } from '../../../../services/environment/electron-browser/environmentService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { IBrowserZoomService } from '../../common/browserZoomService.js';
import { BrowserViewWorkbenchService } from '../../electron-browser/browserViewWorkbenchService.js';

suite('Hucode BrowserViewWorkbenchService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const windowId = 1;
	const hostedWebContentsId = 7;

	function createHostedService() {
		const disposables = store.add(new DisposableStore());
		const events = store.add(new Emitter<BrowserViewEvent>());
		const creationHosts: IBrowserViewHost[] = [];
		class Source {
			onDynamicBrowserViewEvent(): Event<BrowserViewEvent> { return events.event; }
			async updateWindowConfiguration(): Promise<void> { }
			async destroyBrowserView(): Promise<void> { }
			async setBrowserZoomIndex(): Promise<void> { }
			async getOrCreateBrowserView(id: string, options: IBrowserViewCreateOptions): Promise<IBrowserViewInfo> {
				creationHosts.push(options.host);
				return info(id, options.host, options.presentation);
			}
			async loadURL(): Promise<void> { }
		}
		const channel = ProxyChannel.fromService(new Source(), disposables);
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IWorkspaceTrustManagementService, 'getTrustedUris', () => []);
		instantiationService.stub(IMainProcessService, upcastPartial<IMainProcessService>({
			getChannel: () => ({
				call: (command, args) => channel.call(undefined, command, args),
				listen: (event, args) => channel.listen(undefined, event, args),
			}),
		}));
		instantiationService.stub(INativeWorkbenchEnvironmentService, upcastPartial<INativeWorkbenchEnvironmentService>({
			userHome: URI.file('/home/test'),
			isHostedOmniWorkspace: true,
			hostedWebContentsId,
		}));
		instantiationService.stub(IWorkspaceTrustEnablementService, upcastPartial<IWorkspaceTrustEnablementService>({
			isWorkspaceTrustEnabled: () => false,
		}));
		instantiationService.stub(IBrowserZoomService, upcastPartial<IBrowserZoomService>({
			getEffectiveZoomIndex: () => browserZoomDefaultIndex,
			onDidChangeZoom: Event.None,
		}));
		instantiationService.stub(IAgentNetworkFilterService, upcastPartial<IAgentNetworkFilterService>({
			isEnabled: () => false,
			onDidChange: Event.None,
		}));
		const service = store.add(instantiationService.createInstance(BrowserViewWorkbenchService));
		instantiationService.stub(IBrowserViewWorkbenchService, service);
		return { service, events, creationHosts };
	}

	function info(id: string, host: IBrowserViewHost, presentation = BrowserViewPresentation.Listed): IBrowserViewInfo {
		return {
			id, host, owner: { type: 'user' }, presentation,
			state: {
				url: '', title: '', canGoBack: false, canGoForward: false,
				loading: false, focused: false, visible: false, isDevToolsOpen: false,
				lastScreenshot: undefined, lastFavicon: undefined, lastError: undefined, certificateError: undefined,
				storageScope: BrowserViewStorageScope.Global, storageKeys: {},
				permissions: { origins: {} }, browserZoomIndex: browserZoomDefaultIndex,
				elementSelectionState: { active: false, options: {} },
				isRemoteSession: false, isAreaSelectionActive: false, device: undefined, audiences: [],
			}
		};
	}

	test('a hosted workbench only discovers its own views on the shared window event stream', async () => {
		const { service, events, creationHosts } = createHostedService();
		const ownHost: IBrowserViewHost = { windowId, hostedWebContentsId };
		const siblingHost: IBrowserViewHost = { windowId, hostedWebContentsId: hostedWebContentsId + 1 };
		const shellHost: IBrowserViewHost = { windowId };

		const snapshot = [
			info('snapshot-own', ownHost),
			info('snapshot-sibling', siblingHost),
			info('snapshot-shell', shellHost),
		].map(serializeBrowserViewInfo);
		events.fire([{ type: 'snapshot', windowId, views: snapshot.map(([view]) => view) }, snapshot.map(([, screenshot]) => screenshot)]);
		for (const view of [info('created-sibling', siblingHost), info('created-shell', shellHost), info('created-own', ownHost)]) {
			const [serialized, screenshot] = serializeBrowserViewInfo(view);
			events.fire([{ type: 'created', windowId, data: { info: serialized } }, [screenshot]]);
		}
		const externalModel = await service.createExternalBrowserView('https://example.test/preview');
		const known = [...service.getKnownBrowserViews().values()];

		try {
			assert.deepStrictEqual({
				knownIds: known.map(input => input.id),
				creationHosts,
			}, {
				knownIds: ['snapshot-own', 'created-own'],
				creationHosts: [ownHost],
			});
		} finally {
			for (const input of known) {
				input.dispose();
			}
			externalModel.dispose();
		}
	});
});
