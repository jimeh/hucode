/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../base/common/uri.js';
import { IOmniRetainedWorkbench } from
	'../../platform/window/common/window.js';

/** Desired resource state for a retained arbitrary Omni workbench. */
export type HucodeRetainedWorkbenchDesiredState = 'loaded' | 'unloaded';

/** Startup policy for Omni-hosted workbenches. */
export type HucodeHostedWorkbenchRestorePolicy = 'active' | 'all' | 'none';

/** User setting controlling eager Omni hosted-workbench restoration. */
export const HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING =
	'hucode.omni.restoreHostedWorkbenches';

/** User setting controlling Omni Projects tree indentation. */
export const HUCODE_OMNI_TREE_INDENT_SETTING =
	'hucode.omni.treeIndent';

/** Default indentation for the Omni Projects tree. */
export const HUCODE_OMNI_TREE_INDENT_DEFAULT = 8;

/** Minimum indentation for the Omni Projects tree. */
export const HUCODE_OMNI_TREE_INDENT_MINIMUM = 4;

/** Maximum indentation for the Omni Projects tree. */
export const HUCODE_OMNI_TREE_INDENT_MAXIMUM = 40;

/** Layout variants supported by Omni sidebar workbench rows. */
export type HucodeOmniItemLayout = 'compact' | 'twoLine';

/** Default layout for Omni sidebar workbench and worktree rows. */
export const HUCODE_OMNI_ITEM_LAYOUT_DEFAULT: HucodeOmniItemLayout =
	'twoLine';

/** User setting controlling arbitrary workbench row layout. */
export const HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING =
	'hucode.omni.workbenchItemLayout';

/** User setting controlling project worktree row layout. */
export const HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING =
	'hucode.omni.worktreeItemLayout';

/** User setting controlling paths on project worktree rows. */
export const HUCODE_OMNI_SHOW_WORKTREE_PATHS_SETTING =
	'hucode.omni.showWorktreePaths';

/** User setting controlling inline metadata icons in Omni sidebar rows. */
export const HUCODE_OMNI_SHOW_INLINE_ICONS_SETTING =
	'hucode.omni.showInlineIcons';

/** Persisted arbitrary-folder entry owned by one Omni window. */
export type IHucodeRetainedWorkbench = IOmniRetainedWorkbench;

/** Candidate consumed by the shared hosted-workbench restore scheduler. */
export interface IHucodeHostedWorkbenchRestoreCandidate {
	readonly worktreePath: string;
	readonly projectId?: string;
	readonly retainedWorkbenchId?: string;
	readonly lastActiveAt?: number;
}

/** Eager and dormant sets selected for one Omni startup. */
export interface IHucodeHostedWorkbenchRestorePlan {
	readonly eager: readonly IHucodeHostedWorkbenchRestoreCandidate[];
	readonly dormant: readonly IHucodeHostedWorkbenchRestoreCandidate[];
}

/** Mutable, normalized catalog for arbitrary folder-backed Omni workbenches. */
export class RetainedWorkbenchCatalog {
	private records: IHucodeRetainedWorkbench[];

	constructor(
		records: readonly IHucodeRetainedWorkbench[] = [],
		private readonly toResourceKey: (uri: URI) => string = uri =>
			uri.toString(),
		private readonly createId: () => string,
	) {
		this.records = deserializeRetainedWorkbenches(
			records,
			this.toResourceKey
		);
	}

	/** Returns retained records in their persisted manual order. */
	get all(): readonly IHucodeRetainedWorkbench[] {
		return this.records;
	}

	/** Finds a retained record by stable ID. */
	getById(id: string): IHucodeRetainedWorkbench | undefined {
		return this.records.find(record => record.id === id);
	}

	/** Finds a retained record by normalized folder identity. */
	getByUri(uri: URI): IHucodeRetainedWorkbench | undefined {
		const key = this.toResourceKey(uri);
		return this.records.find(record =>
			this.toResourceKey(URI.revive(record.folderUri)) === key
		);
	}

	/** Adds a folder or reuses its existing retained record. */
	retain(
		folderUri: URI,
		desiredState: HucodeRetainedWorkbenchDesiredState = 'loaded',
		lastActiveAt?: number,
	): IHucodeRetainedWorkbench {
		const existing = this.getByUri(folderUri);
		if (existing) {
			return this.update(existing.id, {
				desiredState,
				folderStatus: undefined,
				...(lastActiveAt === undefined ? {} : { lastActiveAt }),
			}) ?? existing;
		}

		const record: IHucodeRetainedWorkbench = {
			id: this.createId(),
			folderUri: folderUri.toJSON(),
			desiredState,
			order: this.records.length,
			lastActiveAt,
		};
		this.records = [...this.records, record];
		return record;
	}

	/** Updates desired state, folder status, or recency without changing order. */
	update(
		id: string,
		update: Partial<Pick<
			IHucodeRetainedWorkbench,
			'desiredState' | 'folderStatus' | 'lastActiveAt'
		>>,
	): IHucodeRetainedWorkbench | undefined {
		const index = this.records.findIndex(record => record.id === id);
		if (index < 0) {
			return undefined;
		}

		const next = { ...this.records[index], ...update };
		this.records = [...this.records];
		this.records[index] = next;
		return next;
	}

	/** Sets or resets a retained workbench's custom display label. */
	setLabel(
		id: string,
		label: string | undefined,
	): IHucodeRetainedWorkbench | undefined {
		const normalizedLabel = label?.trim();
		if (label !== undefined && !normalizedLabel) {
			return undefined;
		}

		const record = this.getById(id);
		if (!record) {
			return undefined;
		}

		const next = { ...record, label: normalizedLabel };
		this.records = this.records.map(candidate =>
			candidate.id === id ? next : candidate
		);
		return next;
	}

	/** Removes one retained record without touching its folder. */
	dismiss(id: string): boolean {
		const next = this.records.filter(record => record.id !== id);
		if (next.length === this.records.length) {
			return false;
		}

		this.records = compactRetainedWorkbenchOrder(next);
		return true;
	}

	/** Replaces manual order after validating exact catalog membership. */
	reorder(orderedIds: readonly string[]): boolean {
		if (
			orderedIds.length !== this.records.length ||
			new Set(orderedIds).size !== orderedIds.length ||
			orderedIds.some(id => !this.getById(id))
		) {
			return false;
		}

		const byId = new Map(this.records.map(record => [record.id, record]));
		this.records = orderedIds.map((id, order) => ({
			...byId.get(id)!,
			order,
		}));
		return true;
	}

	/** Removes records whose folders have been promoted to project worktrees. */
	reconcileProjectPaths(projectPaths: readonly URI[]): boolean {
		const projectKeys = new Set(projectPaths.map(this.toResourceKey));
		const next = this.records.filter(record =>
			!projectKeys.has(this.toResourceKey(URI.revive(record.folderUri)))
		);
		if (next.length === this.records.length) {
			return false;
		}

		this.records = compactRetainedWorkbenchOrder(next);
		return true;
	}
}

/** Validates, deduplicates, and compacts persisted retained records. */
export function deserializeRetainedWorkbenches(
	value: readonly IHucodeRetainedWorkbench[] | undefined,
	toResourceKey: (uri: URI) => string = uri => uri.toString(),
): IHucodeRetainedWorkbench[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const ids = new Set<string>();
	const resources = new Set<string>();
	const records: IHucodeRetainedWorkbench[] = [];
	for (const [index, candidate] of value.entries()) {
		const label = typeof candidate?.label === 'string'
			? candidate.label.trim() || undefined
			: candidate?.label;
		const normalized = {
			...candidate,
			...(candidate?.label === undefined ? {} : { label }),
			order: Number.isFinite(candidate?.order) && candidate.order >= 0
				? candidate.order
				: index,
		};
		if (!isRetainedWorkbench(normalized)) {
			continue;
		}

		const uri = URI.revive(normalized.folderUri);
		const key = toResourceKey(uri);
		if (ids.has(normalized.id) || resources.has(key)) {
			continue;
		}

		ids.add(normalized.id);
		resources.add(key);
		records.push({ ...normalized, folderUri: uri.toJSON() });
	}

	return compactRetainedWorkbenchOrder(records.sort((a, b) =>
		a.order - b.order
	));
}

/** Selects eager and dormant desired-loaded hosted workbenches. */
export function createHostedWorkbenchRestorePlan(
	candidates: readonly IHucodeHostedWorkbenchRestoreCandidate[],
	activeWorktreePath: string | undefined,
	policy: HucodeHostedWorkbenchRestorePolicy,
	pathsEqual: (a: string, b: string) => boolean = (a, b) => a === b,
): IHucodeHostedWorkbenchRestorePlan {
	const deduplicated: IHucodeHostedWorkbenchRestoreCandidate[] = [];
	for (const candidate of candidates) {
		if (!deduplicated.some(entry =>
			pathsEqual(entry.worktreePath, candidate.worktreePath)
		)) {
			deduplicated.push(candidate);
		}
	}

	const active = activeWorktreePath
		? deduplicated.find(candidate =>
			pathsEqual(candidate.worktreePath, activeWorktreePath)
		)
		: undefined;
	const fallback = [...deduplicated].sort((a, b) =>
		(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
	)[0];
	const selected = active ?? fallback;
	const eager = policy === 'all'
		? selected
			? [selected, ...deduplicated.filter(candidate =>
				candidate !== selected
			)]
			: deduplicated
		: policy === 'active' && selected ? [selected] : [];
	return {
		eager,
		dormant: deduplicated.filter(candidate => !eager.some(entry =>
			pathsEqual(entry.worktreePath, candidate.worktreePath)
		)),
	};
}

function isRetainedWorkbench(
	value: IHucodeRetainedWorkbench
): value is IHucodeRetainedWorkbench {
	if (!value || typeof value !== 'object') {
		return false;
	}

	try {
		const uri = URI.revive(value.folderUri);
		return typeof value.id === 'string' && value.id.length > 0 &&
			uri.scheme.length > 0 &&
			(value.desiredState === 'loaded' ||
				value.desiredState === 'unloaded') &&
			Number.isFinite(value.order) && value.order >= 0 &&
			(value.folderStatus === undefined ||
				value.folderStatus === 'missing') &&
			(value.label === undefined ||
				typeof value.label === 'string' && value.label.length > 0) &&
			(value.lastActiveAt === undefined ||
				Number.isFinite(value.lastActiveAt));
	} catch {
		return false;
	}
}

function compactRetainedWorkbenchOrder(
	records: readonly IHucodeRetainedWorkbench[]
): IHucodeRetainedWorkbench[] {
	return records.map((record, order) => ({ ...record, order }));
}
