/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../base/common/async.js';
import { mainWindow } from '../../base/browser/window.js';
import { getDelayedChannel, IChannel } from '../../base/parts/ipc/common/ipc.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IndexedDBFileSystemProvider } from '../../platform/files/browser/indexedDBFileSystemProvider.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IRemoteService } from '../../platform/ipc/common/services.js';
import { RemoteStorageService } from '../../platform/storage/common/storageService.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { HucodeWebUserDataStorageService } from './hucodeWebUserDataStorageService.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { UserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfileIpc.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IBrowserWorkbenchEnvironmentService } from '../services/environment/browser/environmentService.js';
import { IRemoteAgentService } from '../services/remote/common/remoteAgentService.js';
import { IUserDataProfileService } from '../services/userDataProfile/common/userDataProfile.js';
import { BrowserStorageService } from '../services/storage/browser/storageService.js';
import { BrowserMain, IBrowserUserDataProfilesService } from './web.main.js';
import { IWorkbenchConstructionOptions } from './web.api.js';
import { getHucodeWebUserDataBootstrapResult } from '../../platform/environment/browser/hucodeWebUserDataBootstrapState.js';
import { IHucodeWebWorkbenchConfiguration } from '../../platform/environment/common/hucodeWebConfiguration.js';
import { localize } from '../../nls.js';

/** BrowserMain backend that uses the serve-web server as the sole non-secret authority. */
export class HucodeWebUserDataBrowserMain extends BrowserMain {
	private readonly profilesChannel = new DeferredPromise<IChannel>();

	constructor(domElement: HTMLElement, configuration: IWorkbenchConstructionOptions) {
		super(domElement, configuration);
	}

	protected override async createUserDataProfilesService(
		_environmentService: IBrowserWorkbenchEnvironmentService,
		_fileService: IFileService,
		_uriIdentityService: IUriIdentityService,
		_logService: ILogService,
	): Promise<IBrowserUserDataProfilesService> {
		const bootstrap = getHucodeWebUserDataBootstrapResult();
		return new HucodeWebUserDataProfilesClient(
			bootstrap.profiles,
			bootstrap.profilesHome,
			getDelayedChannel(this.profilesChannel.p),
		);
	}

	protected override async connectUserDataProfilesService(remoteAgentService: IRemoteAgentService): Promise<void> {
		const connection = remoteAgentService.getConnection();
		if (!connection) {
			throw new Error('Server user-data mode requires a remote serve-web connection.');
		}
		await this.profilesChannel.complete(connection.getChannel('hucodeWebUserDataProfiles'));
	}

	protected override async createStorageService(
		workspace: IAnyWorkspaceIdentifier,
		logService: ILogService,
		userDataProfileService: IUserDataProfileService,
		userDataProfilesService: IUserDataProfilesService,
		remoteAgentService: IRemoteAgentService,
		environmentService: IBrowserWorkbenchEnvironmentService,
	): Promise<IStorageService> {
		const connection = remoteAgentService.getConnection();
		if (!connection) {
			throw new Error('Server user-data storage channel is unavailable.');
		}
		const remoteService: IRemoteService = {
			_serviceBrand: undefined,
			getChannel: name => connection.getChannel(name),
			registerChannel: () => { throw new Error('Registering client channels is unsupported.'); },
		};
		const remoteStorage = new RemoteStorageService(workspace, {
			defaultProfile: userDataProfilesService.defaultProfile,
			currentProfile: userDataProfileService.currentProfile,
		}, remoteService, environmentService);
		const browserStorage = new BrowserStorageService(workspace, userDataProfileService, logService);
		const storage = new HucodeWebUserDataStorageService(remoteStorage, browserStorage);
		try {
			await Promise.all([remoteStorage.initialize(), browserStorage.initialize()]);
		} catch (error) {
			storage.dispose();
			throw error;
		}
		this.onWillShutdownDisposables.add(toDisposable(() => { void storage.close(); }));
		return storage;
	}

	protected override getResetUserDataMessage(): string {
		return localize('reset server user data message', "Reset server user data for every connected browser and reload? Settings, keybindings, profiles, extensions, snippets, and UI state will be erased from this server. Browser secrets and sign-ins are not affected.");
	}

	protected override async resetUserData(_provider: IndexedDBFileSystemProvider, _storageService: IStorageService): Promise<void> {
		const api = (this.configuration as IWorkbenchConstructionOptions & IHucodeWebWorkbenchConfiguration).hucodeWebUserDataApi;
		if (!api) {
			throw new Error('Server user-data reset endpoint is unavailable.');
		}
		const response = await mainWindow.fetch(`${api}/reset`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		if (!response.ok) {
			const body = await response.json() as { error?: string };
			throw new Error(body.error ?? `Unable to reset server user data (HTTP ${response.status}).`);
		}
	}
}

class HucodeWebUserDataProfilesClient extends UserDataProfilesService implements IBrowserUserDataProfilesService {
	getProfileForWorkspace(workspace: IAnyWorkspaceIdentifier): IUserDataProfile | undefined {
		const resource = isSingleFolderWorkspaceIdentifier(workspace)
			? workspace.uri
			: isWorkspaceIdentifier(workspace) ? workspace.configPath : undefined;
		if (!resource) {
			return undefined;
		}
		return this.profiles.find(profile => profile.workspaces?.some(candidate => candidate.toString() === resource.toString()));
	}
}
