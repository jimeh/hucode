/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import product from '../../platform/product/common/product.js';
import {
	INativeWindowConfiguration,
	IWindowsConfiguration,
	hasNativeMenu,
} from '../../platform/window/common/window.js';
import { NativeWindow } from '../../workbench/electron-browser/window.js';
import { setFullscreen } from '../../base/browser/browser.js';
import { domContentLoaded } from '../../base/browser/dom.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import {
	INativeWorkbenchEnvironmentService,
	NativeWorkbenchEnvironmentService,
} from '../../workbench/services/environment/electron-browser/environmentService.js';
import { ServiceCollection } from
	'../../platform/instantiation/common/serviceCollection.js';
import { ILoggerService, ILogService, LogLevel } from
	'../../platform/log/common/log.js';
import { NativeWorkbenchStorageService } from
	'../../workbench/services/storage/electron-browser/storageService.js';
import {
	IWorkspaceContextService,
	isSingleFolderWorkspaceIdentifier,
	isWorkspaceIdentifier,
	IAnyWorkspaceIdentifier,
	reviveIdentifier,
} from '../../platform/workspace/common/workspace.js';
import { IWorkbenchConfigurationService } from
	'../../workbench/services/configuration/common/configuration.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ISharedProcessService } from
	'../../platform/ipc/electron-browser/services.js';
import { IMainProcessService } from
	'../../platform/ipc/common/mainProcessService.js';
import { SharedProcessService } from
	'../../workbench/services/sharedProcess/electron-browser/sharedProcessService.js';
import { RemoteAuthorityResolverService } from
	'../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import {
	IRemoteAuthorityResolverService,
	RemoteConnectionType,
} from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAgentService } from
	'../../workbench/services/remote/electron-browser/remoteAgentService.js';
import { IRemoteAgentService } from
	'../../workbench/services/remote/common/remoteAgentService.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { RemoteFileSystemProviderClient } from
	'../../workbench/services/remote/common/remoteFileSystemProviderClient.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { IProductService } from
	'../../platform/product/common/productService.js';
import { IUriIdentityService } from
	'../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from
	'../../platform/uriIdentity/common/uriIdentityService.js';
import {
	INativeKeyboardLayoutService,
	NativeKeyboardLayoutService,
} from '../../workbench/services/keybinding/electron-browser/nativeKeyboardLayoutService.js';
import { ElectronIPCMainProcessService } from
	'../../platform/ipc/electron-browser/mainProcessService.js';
import { LoggerChannelClient } from
	'../../platform/log/common/logIpc.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { NativeLogService } from
	'../../workbench/services/log/electron-browser/logService.js';
import {
	WorkspaceTrustEnablementService,
	WorkspaceTrustManagementService,
} from '../../workbench/services/workspaces/common/workspaceTrust.js';
import {
	IWorkspaceTrustEnablementService,
	IWorkspaceTrustManagementService,
} from '../../platform/workspace/common/workspaceTrust.js';
import { safeStringify } from '../../base/common/objects.js';
import {
	IUtilityProcessWorkerWorkbenchService,
	UtilityProcessWorkerWorkbenchService,
} from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { isCI, isMacintosh, isTahoeOrNewer } from
	'../../base/common/platform.js';
import { Schemas } from '../../base/common/network.js';
import { DiskFileSystemProvider } from
	'../../workbench/services/files/electron-browser/diskFileSystemProvider.js';
import { FileUserDataProvider } from
	'../../platform/userData/common/fileUserDataProvider.js';
import {
	IUserDataProfilesService,
	reviveProfile,
} from '../../platform/userDataProfile/common/userDataProfile.js';
import { UserDataProfilesService } from
	'../../platform/userDataProfile/common/userDataProfileIpc.js';
import { PolicyChannelClient } from
	'../../platform/policy/common/policyIpc.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { UserDataProfileService } from
	'../../workbench/services/userDataProfile/common/userDataProfileService.js';
import { IUserDataProfileService } from
	'../../workbench/services/userDataProfile/common/userDataProfile.js';
import { BrowserSocketFactory } from
	'../../platform/remote/browser/browserSocketFactory.js';
import {
	RemoteSocketFactoryService,
	IRemoteSocketFactoryService,
} from '../../platform/remote/common/remoteSocketFactoryService.js';
import { ElectronRemoteResourceLoader } from
	'../../platform/remote/electron-browser/electronRemoteResourceLoader.js';
import { IConfigurationService } from
	'../../platform/configuration/common/configuration.js';
import { applyZoom } from '../../platform/window/electron-browser/window.js';
import { mainWindow } from '../../base/browser/window.js';
import { IDefaultAccountService } from
	'../../platform/defaultAccount/common/defaultAccount.js';
import { DefaultAccountService } from
	'../../workbench/services/accounts/browser/defaultAccount.js';
import { AccountPolicyService } from
	'../../workbench/services/policies/common/accountPolicyService.js';
import { MultiplexPolicyService } from
	'../../platform/policy/common/multiplexPolicyService.js';
import { Workbench as OmniWorkbench } from '../browser/workbench.js';
import { NativeMenubarControl } from
	'../../workbench/electron-browser/parts/titlebar/menubarControl.js';
import { IWorkspaceEditingService } from
	'../../workbench/services/workspaces/common/workspaceEditing.js';
import { OmniConfigurationService } from
	'../browser/services/configuration/omniConfigurationService.js';
import { OmniWorkspaceContextService } from
	'../browser/services/workspace/omniWorkspaceContextService.js';
import { getWorkspaceIdentifier } from
	'../../platform/workspaces/common/workspaceIdentifier.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';
import {
	HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
	HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS,
	type HucodeExtensionEnablementPolicy,
} from '../../workbench/services/extensions/common/hucodeExtensionEnablementPolicy.js';

export class HucodeOmniWorkbenchEnvironmentService
	extends NativeWorkbenchEnvironmentService {

	get hucodeExtensionEnablementPolicy(): HucodeExtensionEnablementPolicy {
		return HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY;
	}

	override get skipBuiltinExtensions(): readonly string[] {
		return [
			...super.skipBuiltinExtensions,
			...HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS,
		];
	}
}

export class OmniMain extends Disposable {

	constructor(
		private readonly configuration: INativeWindowConfiguration
	) {
		super();

		this.init();
	}

	private init(): void {
		this.reviveUris();
		setFullscreen(!!this.configuration.fullscreen, mainWindow);
	}

	private reviveUris(): void {
		const workspace = reviveIdentifier(this.configuration.workspace);
		if (isWorkspaceIdentifier(workspace)
			|| isSingleFolderWorkspaceIdentifier(workspace)) {
			this.configuration.workspace = workspace;
		}

		const filesToWait = this.configuration.filesToWait;
		const filesToWaitPaths = filesToWait?.paths;
		for (const paths of [
			filesToWaitPaths,
			this.configuration.filesToOpenOrCreate,
			this.configuration.filesToDiff,
			this.configuration.filesToMerge,
		]) {
			if (Array.isArray(paths)) {
				for (const path of paths) {
					if (path.fileUri) {
						path.fileUri = URI.revive(path.fileUri);
					}
				}
			}
		}

		if (filesToWait) {
			filesToWait.waitMarkerFileUri =
				URI.revive(filesToWait.waitMarkerFileUri);
		}
	}

	async open(): Promise<void> {
		const [services] = await Promise.all([
			this.initServices(),
			domContentLoaded(mainWindow),
		]);

		this.applyWindowZoomLevel(services.configurationService);

		const workbench = new OmniWorkbench(mainWindow.document.body, {
			extraClasses: this.getExtraClasses(),
		}, services.serviceCollection, services.logService);

		const instantiationService = workbench.startup();
		const shellService = instantiationService.invokeFunction(accessor =>
			accessor.get(IHucodeShellControllerService)
		);
		this.registerListeners(
			workbench,
			services.storageService,
			shellService
		);

		this._register(instantiationService.createInstance(NativeWindow));

		if (isMacintosh || hasNativeMenu(services.configurationService)) {
			this._register(
				instantiationService.createInstance(NativeMenubarControl)
			);
		}
	}

	private applyWindowZoomLevel(configurationService: IConfigurationService) {
		let zoomLevel: number | undefined;
		if (this.configuration.isCustomZoomLevel
			&& typeof this.configuration.zoomLevel === 'number') {
			zoomLevel = this.configuration.zoomLevel;
		} else {
			const windowConfig = configurationService.getValue<IWindowsConfiguration>();
			zoomLevel = typeof windowConfig.window?.zoomLevel === 'number'
				? windowConfig.window.zoomLevel
				: 0;
		}

		applyZoom(zoomLevel, mainWindow);
	}

	private getExtraClasses(): string[] {
		const extraClasses = ['hucode-omni-window'];

		if (isMacintosh && isTahoeOrNewer(this.configuration.os.release)) {
			extraClasses.push('macos-tahoe');
		}

		return extraClasses;
	}

	private registerListeners(
		workbench: OmniWorkbench,
		storageService: NativeWorkbenchStorageService,
		shellService?: IHucodeShellControllerService
	): void {
		if (shellService) {
			this._register(workbench.onWillShutdown(event => event.join(
				shellService.shutdownWindowWorkspaces(
					event.reason as ShutdownReason
				),
				{
					id: 'join.shutdownHostedOmniWorkspaces',
					label: localize(
						'join.shutdownHostedOmniWorkspaces',
						'Saving hosted workspace state'
					),
				}
			)));
		}

		this._register(workbench.onWillShutdown(event => event.join(
			storageService.close(),
			{
				id: 'join.closeStorage',
				label: localize('join.closeStorage', 'Saving UI state'),
			}
		)));
		this._register(workbench.onDidShutdown(() => this.dispose()));
	}

	private async initServices(): Promise<{
		serviceCollection: ServiceCollection;
		logService: ILogService;
		storageService: NativeWorkbenchStorageService;
		configurationService: OmniConfigurationService;
	}> {
		const serviceCollection = new ServiceCollection();

		const mainProcessService = this._register(
			new ElectronIPCMainProcessService(this.configuration.windowId)
		);
		serviceCollection.set(IMainProcessService, mainProcessService);

		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
		};
		serviceCollection.set(IProductService, productService);

		const environmentService = new HucodeOmniWorkbenchEnvironmentService(
			this.configuration,
			productService
		);
		serviceCollection.set(
			INativeWorkbenchEnvironmentService,
			environmentService
		);

		const loggers = this.configuration.loggers.map(loggerResource => ({
			...loggerResource,
			resource: URI.revive(loggerResource.resource),
		}));
		const loggerService = new LoggerChannelClient(
			this.configuration.windowId,
			this.configuration.logLevel,
			environmentService.windowLogsPath,
			loggers,
			mainProcessService.getChannel('logger')
		);
		serviceCollection.set(ILoggerService, loggerService);

		const logService = this._register(
			new NativeLogService(loggerService, environmentService)
		);
		serviceCollection.set(ILogService, logService);
		if (isCI) {
			logService.info('workbench#open()');
		}
		if (logService.getLevel() === LogLevel.Trace) {
			logService.trace(
				'workbench#open(): with configuration',
				safeStringify({
					...this.configuration,
					nls: undefined,
				})
			);
		}

		const defaultAccountService = this._register(
			new DefaultAccountService(productService)
		);
		serviceCollection.set(IDefaultAccountService, defaultAccountService);

		let policyService: IPolicyService;
		const accountPolicy = new AccountPolicyService(
			logService,
			defaultAccountService
		);
		if (this.configuration.policiesData) {
			const policyChannel = new PolicyChannelClient(
				this.configuration.policiesData,
				mainProcessService.getChannel('policy')
			);
			policyService = new MultiplexPolicyService(
				[policyChannel, accountPolicy],
				logService
			);
		} else {
			policyService = accountPolicy;
		}
		serviceCollection.set(IPolicyService, policyService);

		const sharedProcessService = new SharedProcessService(
			this.configuration.windowId,
			logService
		);
		serviceCollection.set(ISharedProcessService, sharedProcessService);

		const utilityProcessWorkerWorkbenchService =
			new UtilityProcessWorkerWorkbenchService(
				{
					kind: 'window',
					windowId: this.configuration.windowId
				},
				logService,
				mainProcessService
			);
		serviceCollection.set(
			IUtilityProcessWorkerWorkbenchService,
			utilityProcessWorkerWorkbenchService
		);

		const signService = ProxyChannel.toService<ISignService>(
			mainProcessService.getChannel('sign')
		);
		serviceCollection.set(ISignService, signService);

		const fileService = this._register(new FileService(logService));
		serviceCollection.set(IFileService, fileService);

		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(
			productService,
			new ElectronRemoteResourceLoader(
				environmentService.window.id,
				mainProcessService,
				fileService
			)
		);
		serviceCollection.set(
			IRemoteAuthorityResolverService,
			remoteAuthorityResolverService
		);

		const diskFileSystemProvider = this._register(
			new DiskFileSystemProvider(
				mainProcessService,
				utilityProcessWorkerWorkbenchService,
				logService,
				loggerService
			)
		);
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		const uriIdentityService = new UriIdentityService(fileService);
		serviceCollection.set(IUriIdentityService, uriIdentityService);

		const userDataProfilesService = new UserDataProfilesService(
			this.configuration.profiles.all,
			URI.revive(this.configuration.profiles.home).with({
				scheme: environmentService.userRoamingDataHome.scheme,
			}),
			mainProcessService.getChannel('userDataProfiles')
		);
		serviceCollection.set(
			IUserDataProfilesService,
			userDataProfilesService
		);
		const userDataProfileService = new UserDataProfileService(
			reviveProfile(
				this.configuration.profiles.profile,
				userDataProfilesService.profilesHome.scheme
			)
		);
		serviceCollection.set(IUserDataProfileService, userDataProfileService);

		fileService.registerProvider(
			Schemas.vscodeUserData,
			this._register(new FileUserDataProvider(
				Schemas.file,
				diskFileSystemProvider,
				Schemas.vscodeUserData,
				userDataProfilesService,
				uriIdentityService,
				logService
			))
		);

		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		remoteSocketFactoryService.register(
			RemoteConnectionType.WebSocket,
			new BrowserSocketFactory(null)
		);
		serviceCollection.set(
			IRemoteSocketFactoryService,
			remoteSocketFactoryService
		);
		const remoteAgentService = this._register(new RemoteAgentService(
			remoteSocketFactoryService,
			userDataProfileService,
			environmentService,
			productService,
			remoteAuthorityResolverService,
			signService,
			logService
		));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		this._register(RemoteFileSystemProviderClient.register(
			remoteAgentService,
			fileService,
			logService
		));

		const workspaceIdentifier = getWorkspaceIdentifier(
			environmentService.agentSessionsWorkspace
		);
		const workspaceContextService = new OmniWorkspaceContextService(
			workspaceIdentifier,
			uriIdentityService
		);
		serviceCollection.set(IWorkspaceContextService, workspaceContextService);
		serviceCollection.set(IWorkspaceEditingService, workspaceContextService);

		const [configurationService, storageService] = await Promise.all([
			this.createConfigurationService(
				workspaceContextService,
				userDataProfileService,
				uriIdentityService,
				fileService,
				logService,
				policyService
			).then(service => {
				serviceCollection.set(IWorkbenchConfigurationService, service);
				return service;
			}),
			this.createStorageService(
				workspaceIdentifier,
				environmentService,
				userDataProfileService,
				userDataProfilesService,
				mainProcessService
			).then(service => {
				serviceCollection.set(IStorageService, service);
				return service;
			}),
			this.createKeyboardLayoutService(mainProcessService).then(service => {
				serviceCollection.set(INativeKeyboardLayoutService, service);
				return service;
			}),
		]);

		const workspaceTrustEnablementService =
			new WorkspaceTrustEnablementService(
				configurationService,
				environmentService
			);
		serviceCollection.set(
			IWorkspaceTrustEnablementService,
			workspaceTrustEnablementService
		);

		const workspaceTrustManagementService =
			new WorkspaceTrustManagementService(
				configurationService,
				remoteAuthorityResolverService,
				storageService,
				uriIdentityService,
				environmentService,
				workspaceContextService,
				workspaceTrustEnablementService,
				fileService
			);
		serviceCollection.set(
			IWorkspaceTrustManagementService,
			workspaceTrustManagementService
		);

		return {
			serviceCollection,
			logService,
			storageService,
			configurationService,
		};
	}

	private async createConfigurationService(
		workspaceContextService: OmniWorkspaceContextService,
		userDataProfileService: IUserDataProfileService,
		uriIdentityService: IUriIdentityService,
		fileService: FileService,
		logService: ILogService,
		policyService: IPolicyService
	): Promise<OmniConfigurationService> {
		const configurationService = new OmniConfigurationService(
			userDataProfileService,
			workspaceContextService,
			uriIdentityService,
			fileService,
			policyService,
			logService
		);

		try {
			await configurationService.initialize();
		} catch (error) {
			onUnexpectedError(error);
		}

		return configurationService;
	}

	private async createStorageService(
		workspace: IAnyWorkspaceIdentifier,
		environmentService: INativeWorkbenchEnvironmentService,
		userDataProfileService: IUserDataProfileService,
		userDataProfilesService: IUserDataProfilesService,
		mainProcessService: IMainProcessService
	): Promise<NativeWorkbenchStorageService> {
		const storageService = new NativeWorkbenchStorageService(
			workspace,
			userDataProfileService,
			userDataProfilesService,
			mainProcessService,
			environmentService
		);

		try {
			await storageService.initialize();
			return storageService;
		} catch (error) {
			onUnexpectedError(error);
			return storageService;
		}
	}

	private async createKeyboardLayoutService(
		mainProcessService: IMainProcessService
	): Promise<NativeKeyboardLayoutService> {
		const keyboardLayoutService = new NativeKeyboardLayoutService(
			mainProcessService
		);

		try {
			await keyboardLayoutService.initialize();
			return keyboardLayoutService;
		} catch (error) {
			onUnexpectedError(error);
			return keyboardLayoutService;
		}
	}
}

export interface IDesktopMain {
	main(configuration: INativeWindowConfiguration): Promise<void>;
}

export function main(
	configuration: INativeWindowConfiguration
): Promise<void> {
	const workbench = new OmniMain(configuration);
	return workbench.open();
}
