/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { joinPath } from '../../../base/common/resources.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../base/test/common/timeTravelScheduler.js';
import { Event } from '../../../base/common/event.js';
import { Schemas } from '../../../base/common/network.js';
import { ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { IConfigurationNode, IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../platform/configuration/common/configurationRegistry.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileUserDataProvider } from '../../../platform/userData/common/fileUserDataProvider.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { NullPolicyService } from '../../../platform/policy/common/policy.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { UserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../workbench/services/userDataProfile/common/userDataProfileService.js';
import { TestEnvironmentService } from '../../../workbench/test/browser/workbenchTestServices.js';
import { getWorkspaceIdentifier } from '../../../platform/workspaces/common/workspaceIdentifier.js';
import { IUserDataProfileService } from '../../../workbench/services/userDataProfile/common/userDataProfile.js';
import {
	OMNI_CONFIGURATION_OVERRIDES,
	OmniConfigurationOverrides,
	OmniConfigurationService,
} from '../../browser/services/configuration/omniConfigurationService.js';
import { OmniWorkspaceContextService } from '../../browser/services/workspace/omniWorkspaceContextService.js';

const ROOT = URI.file('tests').with({ scheme: 'vscode-tests' });

suite('OmniConfigurationService', () => {
	let testObject: OmniConfigurationService;
	let workspaceService: OmniWorkspaceContextService;
	let fileService: FileService;
	let userDataProfileService: IUserDataProfileService;
	let workspaceConfigResource: URI;
	const configurationRegistry =
		Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let testConfigurationRegistration: IConfigurationNode | undefined;

	const testOverrides: OmniConfigurationOverrides = {
		...OMNI_CONFIGURATION_OVERRIDES,
		'hucodeOmniConfigurationService.omniDefault': {
			default: 'omniDefault'
		},
		'hucodeOmniConfigurationService.omniReadOnly': {
			default: 'omniReadOnlyDefault',
			readOnly: true
		},
	};

	suiteSetup(() => {
		testConfigurationRegistration = configurationRegistry.registerConfiguration({
			id: '_test_hucode_omni',
			type: 'object',
			properties: {
				'hucodeOmniConfigurationService.testSetting': {
					type: 'string',
					default: 'defaultValue',
					scope: ConfigurationScope.RESOURCE
				},
				'hucodeOmniConfigurationService.agentsWindowDefault': {
					type: 'string',
					default: 'originalDefault',
					scope: ConfigurationScope.RESOURCE,
					agentsWindow: { default: 'agentsDefault' }
				},
				'hucodeOmniConfigurationService.omniDefault': {
					type: 'string',
					default: 'originalDefault',
					scope: ConfigurationScope.RESOURCE
				},
				'hucodeOmniConfigurationService.omniReadOnly': {
					type: 'string',
					default: 'originalDefault',
					scope: ConfigurationScope.RESOURCE
				},
			}
		});
	});

	suiteTeardown(() => {
		if (testConfigurationRegistration) {
			configurationRegistry.deregisterConfigurations([
				testConfigurationRegistration
			]);
		}
		testConfigurationRegistration = undefined;
	});

	setup(async () => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		const fileSystemProvider =
			disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(
			ROOT.scheme,
			fileSystemProvider
		));

		const uriIdentityService =
			disposables.add(new UriIdentityService(fileService));
		const userDataProfilesService = disposables.add(
			new UserDataProfilesService(
				TestEnvironmentService,
				fileService,
				uriIdentityService,
				logService
			)
		);
		disposables.add(fileService.registerProvider(
			Schemas.vscodeUserData,
			disposables.add(new FileUserDataProvider(
				ROOT.scheme,
				fileSystemProvider,
				Schemas.vscodeUserData,
				userDataProfilesService,
				uriIdentityService,
				logService
			))
		));
		userDataProfileService = disposables.add(
			new UserDataProfileService(userDataProfilesService.defaultProfile)
		);

		workspaceConfigResource = joinPath(ROOT, 'hucode-omni.code-workspace');
		await fileService.writeFile(
			workspaceConfigResource,
			VSBuffer.fromString(JSON.stringify({ folders: [] }))
		);

		workspaceService = disposables.add(new OmniWorkspaceContextService(
			getWorkspaceIdentifier(workspaceConfigResource),
			uriIdentityService
		));
		testObject = disposables.add(new OmniConfigurationService(
			userDataProfileService,
			workspaceService,
			uriIdentityService,
			fileService,
			new NullPolicyService(),
			logService,
			testOverrides
		));
		await testObject.initialize();
	});

	test('does not apply agentsWindow defaults', () => {
		assert.strictEqual(
			testObject.getValue(
				'hucodeOmniConfigurationService.agentsWindowDefault'
			),
			'originalDefault'
		);
	});

	test('applies explicit Omni defaults', () => {
		assert.strictEqual(
			testObject.getValue('hucodeOmniConfigurationService.omniDefault'),
			'omniDefault'
		);
		assert.deepStrictEqual(
			OMNI_CONFIGURATION_OVERRIDES['window.dialogStyle'],
			{ default: 'native' }
		);
		assert.deepStrictEqual(
			OMNI_CONFIGURATION_OVERRIDES['window.menuStyle'],
			{ default: 'custom' }
		);
	});

	test('explicit Omni defaults can be overridden when writable',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			await fileService.writeFile(
				userDataProfileService.currentProfile.settingsResource,
				VSBuffer.fromString(
					'{ "hucodeOmniConfigurationService.omniDefault": "userValue" }'
				)
			);
			await testObject.reloadConfiguration();

			assert.strictEqual(
				testObject.getValue('hucodeOmniConfigurationService.omniDefault'),
				'userValue'
			);
		}));

	test('fires configuration changes when folders with settings are added',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const folder = joinPath(ROOT, 'folderWithSettings');
			await fileService.createFolder(joinPath(folder, '.vscode'));
			await fileService.writeFile(
				joinPath(folder, '.vscode', 'settings.json'),
				VSBuffer.fromString(JSON.stringify({
					'hucodeOmniConfigurationService.testSetting': 'folderValue'
				}))
			);

			const eventPromise = Event.toPromise(testObject.onDidChangeConfiguration);
			await workspaceService.addFolders([{ uri: folder }]);
			const event = await eventPromise;

			assert.ok(event.affectsConfiguration(
				'hucodeOmniConfigurationService.testSetting',
				{ resource: folder }
			));
			assert.strictEqual(
				testObject.getValue(
					'hucodeOmniConfigurationService.testSetting',
					{ resource: folder }
				),
				'folderValue'
			);
		}));

	test('fires configuration changes for override-only updates',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const eventPromise = Event.toPromise(testObject.onDidChangeConfiguration);
			await fileService.writeFile(
				userDataProfileService.currentProfile.settingsResource,
				VSBuffer.fromString(JSON.stringify({
					'[jsonc]': {
						'hucodeOmniConfigurationService.testSetting': 'jsonValue'
					}
				}))
			);
			await testObject.reloadConfiguration();
			const event = await eventPromise;

			assert.ok(event.affectsConfiguration(
				'hucodeOmniConfigurationService.testSetting',
				{ overrideIdentifier: 'jsonc' }
			));
			assert.strictEqual(
				testObject.getValue(
					'hucodeOmniConfigurationService.testSetting',
					{ overrideIdentifier: 'jsonc' }
				),
				'jsonValue'
			);
		}));

	test('explicit Omni read-only settings ignore persisted values',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			await fileService.writeFile(
				workspaceConfigResource,
				VSBuffer.fromString(JSON.stringify({
					folders: [],
					settings: {
						'hucodeOmniConfigurationService.omniReadOnly':
							'workspaceValue'
					}
				}))
			);
			await fileService.writeFile(
				userDataProfileService.currentProfile.settingsResource,
				VSBuffer.fromString(
					'{ "hucodeOmniConfigurationService.omniReadOnly": "userValue" }'
				)
			);
			await testObject.reloadConfiguration();

			assert.strictEqual(
				testObject.getValue('hucodeOmniConfigurationService.omniReadOnly'),
				'omniReadOnlyDefault'
			);
		}));

	test('explicit Omni read-only settings reject writes',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			await assert.rejects(
				() => testObject.updateValue(
					'hucodeOmniConfigurationService.omniReadOnly',
					'newValue',
					ConfigurationTarget.USER
				),
				/Hucode Omni window/
			);
		}));

	test('workspace folder settings require a matching folder resource',
		() => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			await fileService.writeFile(
				userDataProfileService.currentProfile.settingsResource,
				VSBuffer.fromString('{}')
			);

			await assert.rejects(
				() => testObject.updateValue(
					'hucodeOmniConfigurationService.testSetting',
					'folderValue',
					ConfigurationTarget.WORKSPACE_FOLDER
				),
				/folder resource/
			);
			await assert.rejects(
				() => testObject.updateValue(
					'hucodeOmniConfigurationService.testSetting',
					'folderValue',
					{ resource: joinPath(ROOT, 'outsideFolder') },
					ConfigurationTarget.WORKSPACE_FOLDER
				),
				/Unable to resolve workspace folder/
			);

			const userSettings = await fileService.readFile(
				userDataProfileService.currentProfile.settingsResource
			);
			assert.strictEqual(userSettings.value.toString(), '{}');
		}));
});

suite('OmniWorkspaceContextService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('uses Hucode-owned workspace identity label', () => {
		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		const uriIdentityService =
			disposables.add(new UriIdentityService(fileService));
		const workspaceResource = joinPath(ROOT, 'hucode-omni.code-workspace');
		const service = disposables.add(new OmniWorkspaceContextService(
			getWorkspaceIdentifier(workspaceResource),
			uriIdentityService
		));

		assert.strictEqual(service.getWorkspace().name, 'Hucode Omni Window');
	});

	test('matches current workspace and contained folders', async () => {
		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		const uriIdentityService =
			disposables.add(new UriIdentityService(fileService));
		const workspaceResource = joinPath(ROOT, 'hucode-omni.code-workspace');
		const workspaceIdentifier = getWorkspaceIdentifier(workspaceResource);
		const service = disposables.add(new OmniWorkspaceContextService(
			workspaceIdentifier,
			uriIdentityService
		));
		const folder = joinPath(ROOT, 'currentWorkspaceFolder');

		await service.addFolders([{ uri: folder }]);

		assert.deepStrictEqual({
			workspaceIdentifier: service.isCurrentWorkspace(workspaceIdentifier),
			folder: service.isCurrentWorkspace(folder),
			singleFolderIdentifier: service.isCurrentWorkspace({
				id: 'single-folder',
				uri: folder
			}),
			outsideFolder: service.isCurrentWorkspace(
				joinPath(ROOT, 'outsideFolder')
			)
		}, {
			workspaceIdentifier: true,
			folder: true,
			singleFolderIdentifier: true,
			outsideFolder: false
		});
	});
});
