/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { Promises, Queue } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { JSONPath, ParseError, parse } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { Edit, FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { deepClone, equals } from '../../../../base/common/objects.js';
import { distinct, equals as arrayEquals } from '../../../../base/common/arrays.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { IConfigurationChange, IConfigurationChangeEvent, IConfigurationData, IConfigurationOverrides, IConfigurationUpdateOptions, IConfigurationUpdateOverrides, IConfigurationValue, ConfigurationTarget, isConfigurationOverrides, isConfigurationUpdateOverrides } from '../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ConfigurationChangeEvent, ConfigurationModel, mergeChanges } from '../../../../platform/configuration/common/configurationModels.js';
import { DefaultConfiguration, IPolicyConfiguration, NullPolicyConfiguration, PolicyConfiguration } from '../../../../platform/configuration/common/configurations.js';
import { Extensions, IConfigurationRegistry, IRegisteredConfigurationPropertySchema, keyFromOverrideIdentifiers } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPolicyService, NullPolicyService } from '../../../../platform/policy/common/policy.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, IWorkspaceFolder, WorkbenchState, Workspace } from '../../../../platform/workspace/common/workspace.js';
import { FolderConfiguration, UserConfiguration, WorkspaceConfiguration } from '../../../../workbench/services/configuration/browser/configuration.js';
import { APPLICATION_SCOPES, APPLY_ALL_PROFILES_SETTING, FOLDER_CONFIG_FOLDER_NAME, FOLDER_SETTINGS_PATH, IWorkbenchConfigurationService, RestrictedSettings } from '../../../../workbench/services/configuration/common/configuration.js';
import { Configuration } from '../../../../workbench/services/configuration/common/configurationModels.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { localize } from '../../../../nls.js';

// Import to register configuration contributions
import '../../../../workbench/services/configuration/browser/configurationService.js';

export interface IOmniConfigurationOverride {
	readonly default?: unknown;
	readonly readOnly?: boolean;
}

export type OmniConfigurationOverrides =
	Readonly<Record<string, IOmniConfigurationOverride>>;

export const OMNI_CONFIGURATION_OVERRIDES: OmniConfigurationOverrides = {
	'diffEditor.renderSideBySide': { default: true },
	'diffEditor.useInlineViewWhenSpaceIsLimited': { default: true },
	'diffEditor.renderMarginRevertIcon': { default: false },
	'diffEditor.renderGutterMenu': { default: false },
	'diffEditor.renderIndicators': { default: false },
	'diffEditor.hideUnchangedRegions.enabled': { default: true },
	'extensions.ignoreRecommendations': { default: true, readOnly: true },
	'files.autoSave': { default: 'afterDelay' },
	'inlineChat.accessibleDiffView': { default: 'editor' },
	'task.notifyWindowOnTaskCompletion': { default: -1 },
	'terminal.integrated.defaultLocation': {
		default: 'view',
		readOnly: true
	},
	'update.showReleaseNotes': { default: false, readOnly: true },
	'window.commandCenter': { default: false, readOnly: true },
	'window.customMenuBarAltFocus': { default: false, readOnly: true },
	'window.dialogStyle': { default: 'native' },
	'window.menuStyle': { default: 'custom' },
	'window.title': { default: '${appName}', readOnly: true },
	'workbench.activityBar.autoHide': { default: false, readOnly: true },
	'workbench.activityBar.compact': { default: false, readOnly: true },
	'workbench.activityBar.iconClickBehavior': {
		default: 'toggle',
		readOnly: true
	},
	'workbench.activityBar.location': { default: 'default', readOnly: true },
	'workbench.editor.doubleClickTabToToggleEditorGroupSizes': {
		default: 'maximize',
		readOnly: true
	},
	'workbench.editor.editorActionsLocation': {
		default: 'default',
		readOnly: true
	},
	'workbench.editor.restoreEditors': { default: false, readOnly: true },
	'workbench.editor.useModal': { default: 'all' },
	'workbench.layoutControl.enabled': { default: true, readOnly: true },
	'workbench.layoutControl.type': { default: 'both', readOnly: true },
	'workbench.navigationControl.enabled': { default: false, readOnly: true },
	'workbench.panel.defaultLocation': { default: 'bottom', readOnly: true },
	'workbench.panel.opensMaximized': { default: 'never', readOnly: true },
	'workbench.secondarySideBar.defaultVisibility': {
		default: 'visibleInWorkspace',
		readOnly: true
	},
	'workbench.secondarySideBar.forceMaximized': {
		default: false,
		readOnly: true
	},
	'workbench.secondarySideBar.showLabels': { default: true, readOnly: true },
	'workbench.sideBar.location': { default: 'left', readOnly: true },
	'workbench.startupEditor': { default: 'none', readOnly: true },
	'workbench.statusBar.visible': { default: false, readOnly: true },
	'workbench.tips.enabled': { default: false },
};

class OmniDefaultConfiguration extends DefaultConfiguration {

	constructor(
		logService: ILogService,
		private readonly overrides: OmniConfigurationOverrides
	) {
		super(logService);
	}

	protected override getDefaultValue(_key: string, propertySchema: IRegisteredConfigurationPropertySchema): unknown {
		const override = this.overrides[_key];
		if (override && Object.hasOwn(override, 'default')) {
			return deepClone(override.default);
		}
		return super.getDefaultValue(_key, propertySchema);
	}

}

export class OmniConfigurationService extends Disposable implements IWorkbenchConfigurationService {

	declare readonly _serviceBrand: undefined;

	private _configuration: Configuration;
	private readonly defaultConfiguration: DefaultConfiguration;
	private readonly policyConfiguration: IPolicyConfiguration;
	private readonly userConfiguration: UserConfiguration;
	private readonly workspaceConfiguration: WorkspaceConfiguration;
	private readonly cachedFolderConfigs = this._register(new DisposableMap<URI, FolderConfiguration>(new ResourceMap()));
	private readonly omniReadOnlyKeys = new Set<string>();
	private readonly pendingFolderConfigurationChanges: Array<{
		previousData: IConfigurationData;
		change: IConfigurationChange;
	}> = [];

	private readonly _onDidChangeConfiguration = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

	readonly onDidChangeRestrictedSettings = Event.None;
	readonly restrictedSettings: RestrictedSettings = { default: [] };

	private readonly configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

	private readonly settingsResource: URI;
	private readonly configurationEditing: ConfigurationEditing;

	constructor(
		userDataProfileService: IUserDataProfileService,
		private readonly workspaceService: IWorkspaceContextService,
		private readonly uriIdentityService: IUriIdentityService,
		private readonly fileService: IFileService,
		policyService: IPolicyService,
		private readonly logService: ILogService,
		private readonly overrides: OmniConfigurationOverrides =
			OMNI_CONFIGURATION_OVERRIDES
	) {
		super();

		this.settingsResource = userDataProfileService.currentProfile.settingsResource;
		this.defaultConfiguration = this._register(
			new OmniDefaultConfiguration(logService, overrides)
		);
		this.policyConfiguration = policyService instanceof NullPolicyService ? new NullPolicyConfiguration() : this._register(new PolicyConfiguration(this.defaultConfiguration, policyService, logService));
		this.initOmniReadOnlyKeys();
		this.userConfiguration = this._register(new UserConfiguration(userDataProfileService.currentProfile.settingsResource, userDataProfileService.currentProfile.tasksResource, userDataProfileService.currentProfile.mcpResource, { exclude: [...this.omniReadOnlyKeys] }, fileService, uriIdentityService, logService));
		this.workspaceConfiguration = this._register(new WorkspaceConfiguration({ needsCaching: () => false, read: async () => '', write: async () => { }, remove: async () => { } }, fileService, uriIdentityService, logService));
		this.configurationEditing = new ConfigurationEditing(fileService, this);

		this._configuration = new Configuration(
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			new ResourceMap(),
			ConfigurationModel.createEmptyModel(logService),
			new ResourceMap<ConfigurationModel>(),
			this.workspaceService.getWorkspace() as Workspace,
			this.logService
		);

		this._register(this.defaultConfiguration.onDidChangeConfiguration(({ defaults, properties }) => this.onDefaultConfigurationChanged(defaults, properties)));
		this._register(this.policyConfiguration.onDidChangeConfiguration(configurationModel => this.onPolicyConfigurationChanged(configurationModel)));
		this._register(this.userConfiguration.onDidChangeConfiguration(userConfiguration => this.onUserConfigurationChanged(userConfiguration)));
		this._register(this.workspaceConfiguration.onDidUpdateConfiguration(() => this.onWorkspaceConfigurationChanged()));
		this._register(this.workspaceService.onWillChangeWorkspaceFolders(e => {
			const previousData = this._configuration.toData();
			e.join(this.loadFolderConfigurations(e.changes.added).then(change => {
				if (change.keys.length || change.overrides.length) {
					this.pendingFolderConfigurationChanges.push({ previousData, change });
				}
			}));
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(e => this.onWorkspaceFoldersChanged(e)));
	}

	async initialize(): Promise<void> {
		const workspace = this.workspaceService.getWorkspace() as Workspace;
		const workspaceIdentifier = { id: workspace.id, configPath: workspace.configuration! };
		const [defaultModel, policyModel, userModel] = await Promise.all([
			this.defaultConfiguration.initialize(),
			this.policyConfiguration.initialize(),
			this.userConfiguration.initialize(),
			this.workspaceConfiguration.initialize(workspaceIdentifier, true),
		]);
		this.workspaceConfiguration.reparseWorkspaceSettings({ exclude: [...this.omniReadOnlyKeys] });
		this._configuration = new Configuration(
			defaultModel,
			policyModel,
			ConfigurationModel.createEmptyModel(this.logService),
			userModel,
			ConfigurationModel.createEmptyModel(this.logService),
			this.workspaceConfiguration.getConfiguration(),
			new ResourceMap(),
			ConfigurationModel.createEmptyModel(this.logService),
			new ResourceMap<ConfigurationModel>(),
			workspace,
			this.logService
		);
		await this.loadFolderConfigurations(workspace.folders);
	}

	// #region IWorkbenchConfigurationService

	getConfigurationData(): IConfigurationData {
		return this._configuration.toData();
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue(arg1?: unknown, arg2?: unknown): unknown {
		const section = typeof arg1 === 'string' ? arg1 : undefined;
		const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : undefined;
		return this._configuration.getValue(section, overrides);
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	async updateValue(key: string, value: unknown, arg3?: unknown, arg4?: unknown, _options?: IConfigurationUpdateOptions): Promise<void> {
		const overrides: IConfigurationUpdateOverrides | undefined = isConfigurationUpdateOverrides(arg3) ? arg3
			: isConfigurationOverrides(arg3) ? { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifier ? [arg3.overrideIdentifier] : undefined } : undefined;
		let target: ConfigurationTarget | undefined = (overrides ? arg4 : arg3) as ConfigurationTarget | undefined;

		// Always update chat.disableAIFeatures at workspace scope in the shell.
		if (key === ChatConfiguration.AIDisabled) {
			target = ConfigurationTarget.WORKSPACE;
		}

		const targets: ConfigurationTarget[] = target ? [target] : [];

		if (overrides?.overrideIdentifiers) {
			overrides.overrideIdentifiers = distinct(overrides.overrideIdentifiers);
			overrides.overrideIdentifiers = overrides.overrideIdentifiers.length ? overrides.overrideIdentifiers : undefined;
		}

		const inspect = this.inspect(key, { resource: overrides?.resource, overrideIdentifier: overrides?.overrideIdentifiers ? overrides.overrideIdentifiers[0] : undefined });
		if (inspect.policyValue !== undefined) {
			throw new Error(localize(
				'omniConfigurationPolicyWriteError',
				"Unable to write {0} because it is configured in system policy.",
				key
			));
		}

		if (this.omniReadOnlyKeys.has(key)) {
			throw new Error(localize(
				'omniConfigurationReadOnlyWriteError',
				"Unable to write {0} because it is read-only in the Hucode Omni window.",
				key
			));
		}

		if (!targets.length) {
			targets.push(...this.deriveConfigurationTargets(key, value, inspect));

			// Remove the setting, if the value is same as default value and is updated only in user target
			if (equals(value, inspect.defaultValue) && targets.length === 1 && targets[0] === ConfigurationTarget.USER) {
				value = undefined;
			}
		}

		if (overrides?.overrideIdentifiers?.length && overrides.overrideIdentifiers.length > 1) {
			const overrideIdentifiers = overrides.overrideIdentifiers.sort();
			const existingOverrides = this._configuration.localUserConfiguration.overrides.find(override => arrayEquals([...override.identifiers].sort(), overrideIdentifiers));
			if (existingOverrides) {
				overrides.overrideIdentifiers = existingOverrides.identifiers;
			}
		}

		await Promises.settled(targets.map(t => this.writeConfigurationValue(key, value, t, overrides)));
	}

	private async writeConfigurationValue(key: string, value: unknown, target: ConfigurationTarget, overrides: IConfigurationUpdateOverrides | undefined): Promise<void> {
		let path = overrides?.overrideIdentifiers?.length ? [keyFromOverrideIdentifiers(overrides.overrideIdentifiers), key] : [key];

		const settingsResource = this.getSettingsResource(target, overrides?.resource ?? undefined);

		// When writing to the workspace configuration file, settings go under the "settings" key
		if (this.isWorkspaceConfigurationResource(settingsResource)) {
			path = ['settings', ...path];
		}

		await this.configurationEditing.write(settingsResource, path, value);
		await this.reloadConfiguration();
	}

	private deriveConfigurationTargets(_key: string, value: unknown, inspect: IConfigurationValue<unknown>): ConfigurationTarget[] {
		if (equals(value, inspect.value)) {
			return [];
		}

		const definedTargets: ConfigurationTarget[] = [];
		if (inspect.workspaceFolderValue !== undefined) {
			definedTargets.push(ConfigurationTarget.WORKSPACE_FOLDER);
		}
		if (inspect.workspaceValue !== undefined) {
			definedTargets.push(ConfigurationTarget.WORKSPACE);
		}
		if (inspect.userValue !== undefined) {
			definedTargets.push(ConfigurationTarget.USER);
		}

		if (value === undefined) {
			// Remove the setting in all defined targets
			return definedTargets;
		}

		return [definedTargets[0] || ConfigurationTarget.USER];
	}

	private isWorkspaceConfigurationResource(resource: URI): boolean {
		const workspace = this.workspaceService.getWorkspace();
		return !!(workspace.configuration && this.uriIdentityService.extUri.isEqual(workspace.configuration, resource));
	}

	private getSettingsResource(target: ConfigurationTarget | undefined, resource: URI | undefined): URI {
		if (target === ConfigurationTarget.WORKSPACE_FOLDER) {
			if (!resource) {
				throw new Error(localize(
					'omniConfigurationFolderResourceMissing',
					"Unable to write workspace folder setting without a folder resource."
				));
			}
			const folder = this.workspaceService.getWorkspaceFolder(resource);
			if (!folder) {
				throw new Error(localize(
					'omniConfigurationFolderResourceNotFound',
					"Unable to resolve workspace folder for resource: {0}",
					resource.toString()
				));
			}
			return this.uriIdentityService.extUri.joinPath(folder.uri, FOLDER_SETTINGS_PATH);
		}
		if (target === ConfigurationTarget.WORKSPACE) {
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.configuration) {
				return workspace.configuration;
			}
		}
		return this.settingsResource;
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
		return this._configuration.inspect<T>(key, overrides);
	}

	keys(): { default: string[]; policy: string[]; user: string[]; workspace: string[]; workspaceFolder: string[] } {
		return this._configuration.keys();
	}

	async reloadConfiguration(_target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		const userModel = await this.userConfiguration.initialize();
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateLocalUserConfiguration(userModel);

		// Reload workspace configuration
		const workspaceChange = await this.loadWorkspaceConfiguration();
		change.keys.push(...workspaceChange.keys);
		change.overrides.push(...workspaceChange.overrides);

		// Reload folder configurations
		for (const folder of this.workspaceService.getWorkspace().folders) {
			const folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
			if (folderConfiguration) {
				const folderModel = await folderConfiguration.loadConfiguration();
				const folderChange = this._configuration.compareAndUpdateFolderConfiguration(folder.uri, folderModel);
				change.keys.push(...folderChange.keys);
				change.overrides.push(...folderChange.overrides);
			}
		}

		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.USER);
	}

	hasCachedConfigurationDefaultsOverrides(): boolean {
		return false;
	}

	async whenRemoteConfigurationLoaded(): Promise<void> { }

	isSettingAppliedForAllProfiles(key: string): boolean {
		const scope = this.configurationRegistry.getConfigurationProperties()[key]?.scope;
		if (scope && APPLICATION_SCOPES.includes(scope)) {
			return true;
		}
		const allProfilesSettings = this.getValue<string[]>(APPLY_ALL_PROFILES_SETTING) ?? [];
		return Array.isArray(allProfilesSettings) && allProfilesSettings.includes(key);
	}

	// #endregion

	private initOmniReadOnlyKeys(): void {
		const properties = this.configurationRegistry.getConfigurationProperties();
		for (const key in properties) {
			if (this.overrides[key]?.readOnly) {
				this.omniReadOnlyKeys.add(key);
			}
		}
	}

	private updateOmniReadOnlyKeys(changedProperties: string[]): void {
		const properties = this.configurationRegistry.getConfigurationProperties();
		for (const key of changedProperties) {
			if (properties[key] && this.overrides[key]?.readOnly) {
				this.omniReadOnlyKeys.add(key);
			} else {
				this.omniReadOnlyKeys.delete(key);
			}
		}
	}

	// #region Configuration change handlers

	private onDefaultConfigurationChanged(defaults: ConfigurationModel, properties?: string[]): void {
		if (properties) {
			this.updateOmniReadOnlyKeys(properties);
		}
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateDefaultConfiguration(defaults, properties);
		this._configuration.updateLocalUserConfiguration(this.userConfiguration.reparse({ exclude: [...this.omniReadOnlyKeys] }));
		this._configuration.updateWorkspaceConfiguration(this.workspaceConfiguration.reparseWorkspaceSettings({ exclude: [...this.omniReadOnlyKeys] }));
		for (const folder of this.workspaceService.getWorkspace().folders) {
			const folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
			if (folderConfiguration) {
				this._configuration.updateFolderConfiguration(folder.uri, folderConfiguration.reparse());
			}
		}
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.DEFAULT);
	}

	private onPolicyConfigurationChanged(policyConfiguration: ConfigurationModel): void {
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdatePolicyConfiguration(policyConfiguration);
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.DEFAULT);
	}

	private onUserConfigurationChanged(userConfiguration: ConfigurationModel): void {
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateLocalUserConfiguration(userConfiguration);
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.USER);
	}

	private async onWorkspaceConfigurationChanged(): Promise<void> {
		const previousData = this._configuration.toData();
		const change = await this.loadWorkspaceConfiguration();
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.WORKSPACE);
	}

	private async loadWorkspaceConfiguration(): Promise<IConfigurationChange> {
		await this.workspaceConfiguration.reload();
		this.workspaceConfiguration.reparseWorkspaceSettings({ exclude: [...this.omniReadOnlyKeys] });
		return this._configuration.compareAndUpdateWorkspaceConfiguration(this.workspaceConfiguration.getConfiguration());
	}

	private onWorkspaceFoldersChanged(e: IWorkspaceFoldersChangeEvent): void {
		const pending = this.pendingFolderConfigurationChanges.shift();
		const previousData = pending?.previousData ?? this._configuration.toData();
		const changes: IConfigurationChange[] = pending ? [pending.change] : [];
		for (const folder of e.removed) {
			const change = this._configuration.compareAndDeleteFolderConfiguration(folder.uri);
			changes.push(change);
			this.cachedFolderConfigs.deleteAndDispose(folder.uri);
		}
		this.triggerConfigurationChange(mergeChanges(...changes), previousData, ConfigurationTarget.WORKSPACE_FOLDER);
	}

	private onWorkspaceFolderConfigurationChanged(folder: IWorkspaceFolder): void {
		const folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
		if (folderConfiguration) {
			folderConfiguration.loadConfiguration().then(configurationModel => {
				const previousData = this._configuration.toData();
				const change = this._configuration.compareAndUpdateFolderConfiguration(folder.uri, configurationModel);
				this.triggerConfigurationChange(change, previousData, ConfigurationTarget.WORKSPACE_FOLDER);
			}, onUnexpectedError);
		}
	}

	private async loadFolderConfigurations(folders: readonly IWorkspaceFolder[]): Promise<IConfigurationChange> {
		const changes: IConfigurationChange[] = [];
		for (const folder of folders) {
			let folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
			if (!folderConfiguration) {
				folderConfiguration = new FolderConfiguration(false, folder, FOLDER_CONFIG_FOLDER_NAME, WorkbenchState.WORKSPACE, true, this.fileService, this.uriIdentityService, this.logService, { needsCaching: () => false, read: async () => '', write: async () => { }, remove: async () => { } });
				folderConfiguration.addRelated(folderConfiguration.onDidChange(() => this.onWorkspaceFolderConfigurationChanged(folder)));
				this.cachedFolderConfigs.set(folder.uri, folderConfiguration);
			}
			const configurationModel = await folderConfiguration.loadConfiguration();
			changes.push(this._configuration.compareAndUpdateFolderConfiguration(folder.uri, configurationModel));
		}
		return mergeChanges(...changes);
	}

	private triggerConfigurationChange(change: IConfigurationChange, previousData: IConfigurationData, target: ConfigurationTarget): void {
		if (change.keys.length || change.overrides.length) {
			const workspace = this.workspaceService.getWorkspace() as Workspace;
			const event = new ConfigurationChangeEvent(change, { data: previousData, workspace }, this._configuration, workspace, this.logService);
			event.source = target;
			this._onDidChangeConfiguration.fire(event);
		}
	}

	// #endregion
}

class ConfigurationEditing {

	private readonly queue = new Queue<void>();

	constructor(
		private readonly fileService: IFileService,
		private readonly configurationService: OmniConfigurationService,
	) { }

	write(settingsResource: URI, path: JSONPath, value: unknown): Promise<void> {
		return this.queue.queue(() => this.doWriteConfiguration(settingsResource, path, value));
	}

	private async doWriteConfiguration(settingsResource: URI, path: JSONPath, value: unknown): Promise<void> {
		let content: string;
		try {
			const fileContent = await this.fileService.readFile(settingsResource);
			content = fileContent.value.toString();
		} catch (error) {
			if ((error as FileOperationError).fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				content = '{}';
			} else {
				throw error;
			}
		}

		const parseErrors: ParseError[] = [];
		parse(content, parseErrors, { allowTrailingComma: true, allowEmptyContent: true });
		if (parseErrors.length > 0) {
			throw new Error(localize(
				'omniConfigurationInvalidSettings',
				"Unable to write into the settings file. Please open the file to correct errors/warnings in the file and try again."
			));
		}

		const edits = this.getEdits(content, path, value);
		content = applyEdits(content, edits);

		await this.fileService.writeFile(settingsResource, VSBuffer.fromString(content));
	}

	private getEdits(content: string, path: JSONPath, value: unknown): Edit[] {
		const { tabSize, insertSpaces, eol } = this.formattingOptions;

		if (!path.length) {
			const newContent = JSON.stringify(value, null, insertSpaces ? ' '.repeat(tabSize) : '\t');
			return [{
				content: newContent,
				length: content.length,
				offset: 0
			}];
		}

		return setProperty(content, path, value, { tabSize, insertSpaces, eol });
	}

	private _formattingOptions: Required<FormattingOptions> | undefined;
	private get formattingOptions(): Required<FormattingOptions> {
		if (!this._formattingOptions) {
			let eol = OS === OperatingSystem.Linux || OS === OperatingSystem.Macintosh ? '\n' : '\r\n';
			const configuredEol = this.configurationService.getValue<string>('files.eol', { overrideIdentifier: 'jsonc' });
			if (configuredEol && typeof configuredEol === 'string' && configuredEol !== 'auto') {
				eol = configuredEol;
			}
			this._formattingOptions = {
				eol,
				insertSpaces: !!this.configurationService.getValue('editor.insertSpaces', { overrideIdentifier: 'jsonc' }),
				tabSize: this.configurationService.getValue('editor.tabSize', { overrideIdentifier: 'jsonc' })
			};
		}
		return this._formattingOptions;
	}
}
