/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import { hasKey } from '../../base/common/types.js';
import {
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';

const HUCODE_WEB_OMNI_INITIAL_INSTANCE_ID = 'initial';

/**
 * Builds the hosted workbench URL used by the Hucode Omni web shell.
 */
export function getHucodeWebOmniWorkbenchSrc(
	basePath: string,
	query: url.UrlWithParsedQuery['query'],
	instanceId: string = HUCODE_WEB_OMNI_INITIAL_INSTANCE_ID
): string {
	const nextQuery = { ...query };
	if (!hasKey(nextQuery, { folder: true }) &&
		!hasKey(nextQuery, { workspace: true }) &&
		!hasKey(nextQuery, { ew: true })) {
		nextQuery.ew = 'true';
	}
	nextQuery.payload = JSON.stringify([
		['isHostedOmniWorkspace', 'true'],
		['hostedInstanceId', instanceId],
	]);
	return toHucodeWebRouteLocation(
		basePath,
		HUCODE_WEB_WORKBENCH_PATH,
		nextQuery
	);
}

/**
 * Builds the canonical workbench route used by browser-hosted iframes.
 */
export function getHucodeWebOmniWorkbenchBase(basePath: string): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_WORKBENCH_PATH, {});
}

/**
 * Renders the first-pass Hucode Omni web shell.
 */
export function renderHucodeWebOmniShell(
	workbenchBase: string,
	initialWorkbenchSrc: string
): string {
	const base = escapeAttribute(workbenchBase);
	const src = escapeAttribute(initialWorkbenchSrc);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Hucode Omni</title>
	<style>
		html,
		body {
			width: 100%;
			height: 100%;
			margin: 0;
			overflow: hidden;
			background: #181818;
			color: #cccccc;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		.hucode-omni-shell {
			display: grid;
			grid-template-columns: 280px minmax(0, 1fr);
			width: 100%;
			height: 100%;
		}

		.hucode-omni-projects {
			box-sizing: border-box;
			border-right: 1px solid #2d2d2d;
			background: #202020;
			min-width: 0;
			padding: 16px;
		}

		.hucode-omni-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 12px;
		}

		.hucode-omni-title {
			margin: 0 0 16px;
			font-size: 13px;
			font-weight: 600;
			letter-spacing: 0;
			color: #f0f0f0;
		}

		.hucode-omni-header .hucode-omni-title {
			margin: 0;
		}

		.hucode-omni-button,
		.hucode-omni-input {
			box-sizing: border-box;
			height: 28px;
			border-radius: 4px;
			border: 1px solid #3c3c3c;
			background: #2a2a2a;
			color: #cccccc;
			font: inherit;
		}

		.hucode-omni-button {
			padding: 0 10px;
			cursor: pointer;
		}

		.hucode-omni-button:hover {
			background: #333333;
		}

		.hucode-omni-input {
			width: 100%;
			padding: 0 8px;
		}

		.hucode-omni-add {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 6px;
			margin-bottom: 12px;
		}

		.hucode-omni-workspaces {
			display: grid;
			gap: 4px;
			margin-top: 12px;
		}

		.hucode-omni-workspace {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto auto;
			align-items: center;
			gap: 4px;
			min-height: 30px;
			border: 0;
			border-radius: 4px;
			background: transparent;
			color: #cccccc;
		}

		.hucode-omni-workspace[aria-current="true"] {
			background: #37373d;
			color: #ffffff;
		}

		.hucode-omni-workspace-label {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			text-align: left;
			padding: 0 8px;
			font-size: 12px;
		}

		.hucode-omni-empty {
			display: none;
			margin: 8px 0 0;
			font-size: 12px;
			color: #8f8f8f;
		}

		.hucode-omni-workspaces:empty + .hucode-omni-empty {
			display: block;
		}

		.hucode-omni-host {
			position: relative;
			min-width: 0;
			min-height: 0;
			background: #1e1e1e;
		}

		.hucode-omni-workbench {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			border: 0;
			background: #1e1e1e;
		}

		.hucode-omni-workbench[hidden] {
			display: none;
		}
	</style>
</head>
<body
	data-workbench-base="${base}"
	data-initial-workbench-src="${src}"
>
	<main class="hucode-omni-shell">
		<aside class="hucode-omni-projects" aria-label="Projects">
			<div class="hucode-omni-header">
				<h1 class="hucode-omni-title">Projects</h1>
				<button
					class="hucode-omni-button"
					type="button"
					data-hucode-open-empty
				>Empty</button>
			</div>
			<form class="hucode-omni-add" data-hucode-open-folder-form>
				<input
					class="hucode-omni-input"
					type="text"
					placeholder="/path/to/folder"
					aria-label="Folder path"
					data-hucode-folder-input
				>
				<button class="hucode-omni-button" type="submit">Open</button>
			</form>
			<div
				class="hucode-omni-workspaces"
				aria-label="Open workbenches"
				data-hucode-workspaces
			></div>
			<p class="hucode-omni-empty">No open workbenches</p>
		</aside>
		<section
			class="hucode-omni-host"
			aria-label="Workbench"
			data-hucode-workbench-host
		>
		</section>
	</main>
	<script>
		(() => {
			const body = document.body;
			const workbenchBase = body.dataset.workbenchBase;
			const initialWorkbenchSrc = body.dataset.initialWorkbenchSrc;
			const host = document.querySelector('[data-hucode-workbench-host]');
			const list = document.querySelector('[data-hucode-workspaces]');
			const folderInput = document.querySelector('[data-hucode-folder-input]');
			const folderForm = document.querySelector('[data-hucode-open-folder-form]');
			const emptyButton = document.querySelector('[data-hucode-open-empty]');
			const instances = new Map();
			let activeId;

			const nextId = () => (
				crypto.randomUUID?.() ||
				\`hosted-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`
			);

			const payload = id => JSON.stringify([
				['isHostedOmniWorkspace', 'true'],
				['hostedInstanceId', id],
			]);

			const makeSrc = (id, options) => {
				const target = new URL(workbenchBase, location.origin);
				if (options.folder) {
					target.searchParams.set('folder', options.folder);
				} else if (options.workspace) {
					target.searchParams.set('workspace', options.workspace);
				} else {
					target.searchParams.set('ew', 'true');
				}
				target.searchParams.set('payload', payload(id));
				return target.pathname + target.search;
			};

			const renderList = () => {
				list.textContent = '';
				for (const instance of instances.values()) {
					const row = document.createElement('div');
					row.className = 'hucode-omni-workspace';
					row.setAttribute(
						'aria-current',
						instance.id === activeId ? 'true' : 'false'
					);

					const activate = document.createElement('button');
					activate.className = 'hucode-omni-button hucode-omni-workspace-label';
					activate.type = 'button';
					activate.textContent = instance.label;
					activate.title = instance.label;
					activate.addEventListener('click', () => activateInstance(instance.id));

					const reload = document.createElement('button');
					reload.className = 'hucode-omni-button';
					reload.type = 'button';
					reload.textContent = 'Reload';
					reload.addEventListener('click', () => reloadInstance(instance.id));

					const close = document.createElement('button');
					close.className = 'hucode-omni-button';
					close.type = 'button';
					close.textContent = 'Close';
					close.addEventListener('click', () => closeInstance(instance.id));

					row.append(activate, reload, close);
					list.append(row);
				}
			};

			const activateInstance = id => {
				const instance = instances.get(id);
				if (!instance) {
					return;
				}

				activeId = id;
				for (const candidate of instances.values()) {
					candidate.iframe.hidden = candidate.id !== id;
				}
				instance.iframe.focus();
				renderList();
			};

			const openInstance = options => {
				const existing = options.key
					? [...instances.values()].find(candidate =>
						candidate.key === options.key
					)
					: undefined;
				if (existing) {
					activateInstance(existing.id);
					return existing;
				}

				const id = options.id || nextId();
				const iframe = document.createElement('iframe');
				const src = options.src || makeSrc(id, options);
				iframe.className = 'hucode-omni-workbench';
				iframe.title = options.label;
				iframe.src = src;
				iframe.hidden = true;
				iframe.dataset.hucodeHostedInstanceId = id;
				iframe.addEventListener('load', () => {
					const instance = instances.get(id);
					if (instance) {
						instance.state = 'loaded';
						renderList();
					}
				});
				host.append(iframe);

				const instance = {
					id,
					key: options.key || id,
					label: options.label,
					state: 'loading',
					iframe,
				};
				instances.set(id, instance);
				activateInstance(id);
				return instance;
			};

			const reloadInstance = id => {
				const instance = instances.get(id);
				if (!instance) {
					return;
				}

				instance.state = 'loading';
				instance.iframe.src = instance.iframe.src;
				renderList();
			};

			const closeInstance = id => {
				const instance = instances.get(id);
				if (!instance) {
					return;
				}

				instance.iframe.contentWindow?.postMessage({
					type: 'hucode.omni.beforeUnload',
					instanceId: id,
				}, location.origin);
				instance.iframe.remove();
				instances.delete(id);
				if (activeId === id) {
					const next = instances.values().next().value;
					activeId = undefined;
					if (next) {
						activateInstance(next.id);
					}
				}
				renderList();
			};

			folderForm.addEventListener('submit', event => {
				event.preventDefault();
				const folder = folderInput.value.trim();
				if (!folder) {
					return;
				}

				openInstance({
					key: \`folder:\${folder}\`,
					label: folder,
					folder,
				});
				folderInput.value = '';
			});

			emptyButton.addEventListener('click', () => openInstance({
				label: 'Empty Window',
				key: \`empty:\${nextId()}\`,
			}));

			window.addEventListener('message', event => {
				if (event.origin !== location.origin ||
					typeof event.data !== 'object' ||
					!event.data) {
					return;
				}
				if (event.data.type === 'hucode.omni.focusProjects') {
					folderInput.focus();
				}
			});

			openInstance({
				id: '${HUCODE_WEB_OMNI_INITIAL_INSTANCE_ID}',
				key: 'initial',
				label: 'Initial Workbench',
				src: initialWorkbenchSrc,
			});
		})();
	</script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
	return value.replace(/[&"]/g, character =>
		character === '&' ? '&amp;' : '&quot;'
	);
}
