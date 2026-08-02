/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { URI, UriDto } from '../../../base/common/uri.js';
import { shouldMigrateWebUserDataFile, shouldMigrateWebUserDataState } from '../../../platform/environment/common/hucodeWebUserDataMigration.js';
import { IUserDataProfile } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { IHucodeWebWorkbenchConfiguration } from '../../../platform/environment/common/hucodeWebConfiguration.js';
import { setHucodeWebUserDataBootstrapResult } from '../../../platform/environment/browser/hucodeWebUserDataBootstrapState.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../../../platform/workspaces/common/workspaceIdentifier.js';

const STATE_DATABASE_PREFIX = 'vscode-web-state-db-';
const STATE_STORE = 'ItemTable';
const USER_DATA_DATABASE = 'vscode-web-db';
const USER_DATA_STORE = 'vscode-userdata-store';

/**
 * Initializes or migrates the authoritative server namespace before normal workbench services start.
 */
export async function bootstrapHucodeWebUserData(
	config: IHucodeWebWorkbenchConfiguration,
): Promise<boolean> {
	const api = config.hucodeWebUserDataApi;
	const configuredUserHome = config.hucodeWebUserDataHome;
	if (!api || !configuredUserHome) {
		throw new Error('Server user-data configuration is incomplete.');
	}
	const userHome = URI.revive(configuredUserHome);
	if (!userHome.scheme || !userHome.authority) {
		throw new Error('Server user-data configuration is incomplete.');
	}

	for (; ;) {
		try {
			let status = await requestJson<BootstrapStatus>(`${api}/bootstrap`);
			if (status.state === 'ready') {
				setResult(status.profiles ?? [], userHome);
				return true;
			}
			if (status.state === 'staging') {
				await new Promise(resolve => setTimeout(resolve, 750));
				continue;
			}

			const migration = await collectBrowserMigration(config);
			if (!hasMeaningfulData(migration)) {
				status = await requestJson<BootstrapStatus>(`${api}/initialize-empty`, { method: 'POST', body: '{}' });
				if (status.profiles) {
					setResult(status.profiles, userHome);
					return true;
				}
				continue;
			}

			const choice = await showMigrationPrompt(migration.workspaceInventoryComplete);
			if (choice === 'cancel') {
				return false;
			}
			if (choice === 'fresh') {
				status = await requestJson<BootstrapStatus>(`${api}/initialize-empty`, { method: 'POST', body: '{}' });
				if (status.profiles) {
					setResult(status.profiles, userHome);
					return true;
				}
				continue;
			}

			const claim = await requestJson<ClaimResult>(`${api}/claim`, { method: 'POST', body: '{}' }, true);
			if (!claim.claimed || !claim.owner) {
				continue;
			}
			await uploadWithLeaseRenewal(api, claim.owner, claim.generation, migration);
			const committed = await requestJson<BootstrapStatus>(`${api}/commit`, {
				method: 'POST',
				body: JSON.stringify({ owner: claim.owner, generation: claim.generation }),
			}, true);
			if (committed.profiles) {
				setResult(committed.profiles, userHome);
				return true;
			}
		} catch (error) {
			const retry = await showBootstrapError(error);
			if (!retry) {
				return false;
			}
		}
	}
}

async function uploadWithLeaseRenewal(api: string, owner: string, generation: number, migration: BrowserMigration): Promise<void> {
	const controller = new AbortController();
	let renewalError: unknown;
	let renewal = Promise.resolve();
	const renew = () => {
		renewal = renewal.then(async () => {
			await requestJson(`${api}/renew`, {
				method: 'POST',
				body: JSON.stringify({ owner, generation }),
			});
		}).catch(error => {
			renewalError = error;
			controller.abort();
		});
	};
	const timer = mainWindow.setInterval(renew, 20_000);
	try {
		await requestJson(`${api}/upload`, {
			method: 'POST',
			body: JSON.stringify({ owner, generation, migration }),
			signal: controller.signal,
		});
		await renewal;
		if (renewalError) {
			throw renewalError;
		}
	} finally {
		mainWindow.clearInterval(timer);
	}
}

interface BootstrapStatus {
	readonly state?: 'uninitialized' | 'staging' | 'ready';
	readonly generation: number;
	readonly profiles?: readonly UriDto<IUserDataProfile>[];
}

interface ClaimResult {
	readonly claimed: boolean;
	readonly owner?: string;
	readonly generation: number;
}

interface BrowserMigration {
	readonly files: readonly { readonly path: string; readonly contents: string }[];
	readonly profiles: readonly { readonly id: string; readonly name: string; readonly icon?: string; readonly useDefaultFlags?: object }[];
	readonly associations: object;
	readonly state: readonly { readonly id: string; readonly items: readonly [string, string][] }[];
	readonly workspaceInventoryComplete: boolean;
}

async function collectBrowserMigration(config: IHucodeWebWorkbenchConfiguration): Promise<BrowserMigration> {
	const [files, stateResult] = await Promise.all([collectUserDataFiles(), collectStateDatabases(currentWorkspaceStorageId(config))]);
	const profiles = parseStoredProfiles();
	const associations = parseLocalStorageObject('profileAssociations');
	return { files, profiles, associations, state: stateResult.state, workspaceInventoryComplete: stateResult.workspaceInventoryComplete };
}

function hasMeaningfulData(migration: BrowserMigration): boolean {
	return migration.files.length > 0 || migration.profiles.length > 0 || migration.state.some(database => database.items.length > 0) || hasNestedValue(migration.associations);
}

function hasNestedValue(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	return Object.values(value).some(entry => typeof entry === 'object' ? hasNestedValue(entry) : entry !== undefined);
}

async function collectUserDataFiles(): Promise<{ path: string; contents: string }[]> {
	const names = await databaseNames();
	if (names && !names.includes(USER_DATA_DATABASE)) {
		return [];
	}
	const database = await openExistingDatabase(USER_DATA_DATABASE);
	if (!database) {
		return [];
	}
	try {
		if (!database.objectStoreNames.contains(USER_DATA_STORE)) {
			return [];
		}
		const transaction = database.transaction(USER_DATA_STORE, 'readonly');
		const store = transaction.objectStore(USER_DATA_STORE);
		const keys = await idbRequest<IDBValidKey[]>(store.getAllKeys());
		const values = await Promise.all(keys.map(key => idbRequest(store.get(key))));
		const files: { path: string; contents: string }[] = [];
		for (let index = 0; index < keys.length; index++) {
			const path = String(keys[index]);
			if (!shouldMigrateWebUserDataFile(path)) {
				continue;
			}
			const value = values[index];
			const bytes = value instanceof Uint8Array ? value : typeof value === 'string' ? new TextEncoder().encode(value) : undefined;
			if (bytes) {
				files.push({ path, contents: bytesToBase64(bytes) });
			}
		}
		return files;
	} finally {
		database.close();
	}
}

async function collectStateDatabases(currentWorkspaceId: string | undefined): Promise<{
	state: { id: string; items: [string, string][] }[];
	workspaceInventoryComplete: boolean;
}> {
	const names = await databaseNames();
	const candidates = names?.filter(name => name.startsWith(STATE_DATABASE_PREFIX)) ?? [
		`${STATE_DATABASE_PREFIX}global`,
		`${STATE_DATABASE_PREFIX}global-shared`,
		...parseStoredProfiles().map(profile => `${STATE_DATABASE_PREFIX}global-${profile.id}`),
		...(currentWorkspaceId ? [`${STATE_DATABASE_PREFIX}${currentWorkspaceId}`] : []),
	];
	const result: { id: string; items: [string, string][] }[] = [];
	for (const name of candidates) {
		const database = await openExistingDatabase(name);
		if (!database) {
			continue;
		}
		try {
			if (!database.objectStoreNames.contains(STATE_STORE)) {
				continue;
			}
			const store = database.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE);
			const keys = await idbRequest<IDBValidKey[]>(store.getAllKeys());
			const values = await Promise.all(keys.map(key => idbRequest(store.get(key))));
			const items: [string, string][] = [];
			for (let index = 0; index < keys.length; index++) {
				const key = String(keys[index]);
				const value = values[index];
				if (shouldMigrateWebUserDataState(key, value)) {
					items.push([key, value]);
				}
			}
			result.push({ id: name.slice(STATE_DATABASE_PREFIX.length), items });
		} finally {
			database.close();
		}
	}
	return { state: result, workspaceInventoryComplete: names !== undefined };
}

function currentWorkspaceStorageId(config: IHucodeWebWorkbenchConfiguration): string | undefined {
	const workbenchConfig = config as IHucodeWebWorkbenchConfiguration & {
		readonly folderUri?: UriDto<URI>;
		readonly workspaceUri?: UriDto<URI>;
	};
	if (workbenchConfig.folderUri) {
		return getSingleFolderWorkspaceIdentifier(URI.revive(workbenchConfig.folderUri)).id;
	}
	if (workbenchConfig.workspaceUri) {
		return getWorkspaceIdentifier(URI.revive(workbenchConfig.workspaceUri)).id;
	}
	return undefined;
}

function parseStoredProfiles(): { id: string; name: string; icon?: string; useDefaultFlags?: object }[] {
	const profiles = parseLocalStorageArray('userDataProfiles');
	return profiles.flatMap(profile => {
		try {
			const rawLocation = (profile as { location?: UriDto<URI> }).location;
			if (!rawLocation) {
				return [];
			}
			const location = URI.revive(rawLocation);
			const id = location.path.split('/').filter(Boolean).at(-1);
			const name = (profile as { name?: unknown }).name;
			return id && typeof name === 'string' ? [{
				id,
				name,
				icon: typeof (profile as { icon?: unknown }).icon === 'string' ? (profile as { icon: string }).icon : undefined,
				useDefaultFlags: (profile as { useDefaultFlags?: object }).useDefaultFlags,
			}] : [];
		} catch {
			return [];
		}
	});
}

function parseLocalStorageArray(key: string): unknown[] {
	try {
		const value = mainWindow.localStorage.getItem(key);
		const parsed = value ? JSON.parse(value) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseLocalStorageObject(key: string): Record<string, unknown> {
	try {
		const value = mainWindow.localStorage.getItem(key);
		const parsed = value ? JSON.parse(value) : {};
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function databaseNames(): Promise<string[] | undefined> {
	const factory = mainWindow.indexedDB as IDBFactory & { databases?: () => Promise<readonly { name?: string }[]> };
	return factory.databases ? (await factory.databases()).flatMap(database => database.name ? [database.name] : []) : undefined;
}

function openExistingDatabase(name: string): Promise<IDBDatabase | undefined> {
	return new Promise((resolve, reject) => {
		const request = mainWindow.indexedDB.open(name);
		let absent = false;
		request.onupgradeneeded = event => {
			if (event.oldVersion === 0) {
				absent = true;
				request.transaction?.abort();
			}
		};
		request.onerror = () => absent ? resolve(undefined) : reject(request.error);
		request.onsuccess = () => {
			if (absent) {
				request.result.close();
				resolve(undefined);
			} else {
				resolve(request.result);
			}
		};
	});
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
}

function bytesToBase64(value: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
	}
	return mainWindow.btoa(binary);
}

async function requestJson<T>(url: string, init?: RequestInit, allowConflict = false): Promise<T> {
	const response = await mainWindow.fetch(url, {
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
	const value = await response.json() as T & { error?: string };
	if (!response.ok && !(allowConflict && response.status === 409)) {
		throw new Error(value.error ?? `User-data server returned HTTP ${response.status}.`);
	}
	return value;
}

function setResult(profiles: readonly UriDto<IUserDataProfile>[], home: URI): void {
	setHucodeWebUserDataBootstrapResult({ profiles: profiles.map(profile => remoteProfile(profile, home)), profilesHome: home.with({ path: `${home.path}/profiles` }) });
}

function remoteProfile(profile: UriDto<IUserDataProfile>, home: URI): UriDto<IUserDataProfile> {
	const remote = (value: unknown) => URI.revive(value as never).with({ scheme: home.scheme, authority: home.authority });
	return {
		...profile,
		location: remote(profile.location),
		globalStorageHome: remote(profile.globalStorageHome),
		settingsResource: remote(profile.settingsResource),
		keybindingsResource: remote(profile.keybindingsResource),
		tasksResource: remote(profile.tasksResource),
		snippetsHome: remote(profile.snippetsHome),
		promptsHome: remote(profile.promptsHome),
		extensionsResource: remote(profile.extensionsResource),
		mcpResource: remote(profile.mcpResource),
		languageModelsResource: remote(profile.languageModelsResource),
		cacheHome: remote(profile.cacheHome),
		agentPluginsHome: remote(profile.agentPluginsHome),
	};
}

function showMigrationPrompt(workspaceInventoryComplete: boolean): Promise<'migrate' | 'fresh' | 'cancel'> {
	return showBootstrapDialog(
		'Move browser data to this Hucode server?',
		`Your settings, keybindings, profiles, and workbench state can be copied to the server. Secrets and sign-ins stay in this browser, and the browser copy is kept.${workspaceInventoryComplete ? '' : ' This browser cannot list older workspace databases, so inactive workspace state will remain only in this browser.'}`,
		[['Use Browser Data', 'migrate'], ['Start Fresh on Server', 'fresh'], ['Cancel', 'cancel']],
	);
}

async function showBootstrapError(error: unknown): Promise<boolean> {
	return (await showBootstrapDialog(
		'Unable to open server user data',
		`${error instanceof Error ? error.message : String(error)} Browser storage was not used as a fallback.`,
		[['Retry', true], ['Cancel', false]],
	)) as boolean;
}

function showBootstrapDialog<T>(title: string, message: string, choices: readonly (readonly [string, T])[]): Promise<T> {
	return new Promise(resolve => {
		const overlay = mainWindow.document.createElement('div');
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#fff;font:13px sans-serif;z-index:2147483647';
		const panel = mainWindow.document.createElement('div');
		panel.style.cssText = 'max-width:560px;padding:24px;border:1px solid #555;background:#252526';
		const heading = mainWindow.document.createElement('h1');
		heading.style.fontSize = '20px';
		heading.textContent = title;
		const paragraph = mainWindow.document.createElement('p');
		paragraph.textContent = message;
		panel.append(heading, paragraph);
		let firstButton: HTMLButtonElement | undefined;
		for (const [label, value] of choices) {
			const button = mainWindow.document.createElement('button');
			firstButton ??= button;
			button.textContent = label;
			button.style.cssText = 'margin:12px 8px 0 0;padding:7px 12px';
			button.onclick = () => { overlay.remove(); resolve(value); };
			panel.append(button);
		}
		overlay.append(panel);
		mainWindow.document.body.append(overlay);
		firstButton?.focus();
	});
}
