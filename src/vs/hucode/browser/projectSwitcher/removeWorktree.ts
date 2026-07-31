/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../base/common/htmlContent.js';
import { localize } from '../../../nls.js';
import type {
	IPrompt,
	IPromptResult,
} from '../../../platform/dialogs/common/dialogs.js';
import type {
	IProjectManagerService,
	RemoveWorktreeOptions,
	WorktreeStatusEntry,
	WorktreeStatusPreview,
} from '../../../platform/projectManager/common/projectManager.js';
import { pathsEqual } from './projectSwitcherCommon.js';

type DeleteWorktreeAction = 'delete' | 'force';

const CONFLICT_STATUSES = new Set([
	'DD',
	'AU',
	'UD',
	'UA',
	'DU',
	'AA',
	'UU',
]);

const UNSAFE_PATH_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PATH_CHARACTER_TO_ESCAPE = /["\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Returns whether the requested worktree is the current folder workspace.
 */
export function isCurrentWorktreePath(
	worktreePath: string,
	currentFolderPath: string | undefined
): boolean {
	return currentFolderPath !== undefined &&
		pathsEqual(worktreePath, currentFolderPath);
}

/**
 * Builds the themed, status-aware worktree deletion prompt.
 */
export function createDeleteWorktreePrompt(
	worktreeName: string,
	worktreePath: string,
	status: WorktreeStatusPreview
): IPrompt<DeleteWorktreeAction> {
	const dirty = status.totalCount > 0;
	const markdown = new MarkdownString();
	if (dirty) {
		markdown.appendMarkdown(
			status.totalCount === 1
				? localize(
					'deleteWorktreeOneChange',
					'**1 uncommitted change will be permanently deleted.**'
				)
				: localize(
					'deleteWorktreeManyChanges',
					'**{0} uncommitted changes will be permanently deleted.**',
					status.totalCount.toLocaleString()
				)
		);
		markdown.appendMarkdown('\n\n');
		markdown.appendCodeblock(
			'text',
			status.entries.map(formatWorktreeStatusEntry).join('\n')
		);
		if (status.omittedCount > 0) {
			markdown.appendMarkdown('\n\n');
			markdown.appendMarkdown(
				status.omittedCount === 1
					? localize(
						'deleteWorktreeOneOmittedChange',
						'_and 1 more change not shown_'
					)
					: localize(
						'deleteWorktreeManyOmittedChanges',
						'_and {0} more changes not shown_',
						status.omittedCount.toLocaleString()
					)
			);
		}
	} else {
		markdown.appendMarkdown(localize(
			'deleteWorktreeClean',
			'No uncommitted changes were found.'
		));
	}

	const deleteButton = {
		label: localize('deleteWorktreeDeleteButton', 'Delete'),
		run: () => 'delete' as const,
	};
	const forceButton = {
		label: localize('deleteWorktreeForceDeleteButton', 'Force Delete'),
		run: () => 'force' as const,
	};

	return {
		type: 'warning',
		message: localize(
			'deleteWorktreeTitle',
			'Delete worktree "{0}"?',
			worktreeName
		),
		detail: localize(
			'deleteWorktreeDetail',
			'This permanently deletes the worktree folder at:\n{0}\n\nThe Git branch and committed history will remain.',
			worktreePath
		),
		buttons: dirty
			? [forceButton, deleteButton]
			: [deleteButton, forceButton],
		cancelButton: localize('deleteWorktreeCancelButton', 'Cancel'),
		custom: {
			buttonEnabled: [true, false, true],
			buttonFocus: 2,
			classes: ['hucode-worktree-delete-dialog'],
			markdownDetails: [{
				markdown,
				classes: ['hucode-worktree-delete-preview'],
			}],
		},
	};
}

/**
 * Runs status preview, confirmation, and conditional removal until canceled
 * or a snapshot-matched deletion succeeds.
 */
export async function deleteWorktreeWithPreview(
	projectId: string,
	worktreePath: string,
	worktreeName: string,
	projectManagerService: Pick<
		IProjectManagerService,
		'getWorktreeStatus' | 'removeWorktree'
	>,
	dialogService: {
		prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;
	}
): Promise<void> {
	let status: WorktreeStatusPreview;
	try {
		status = await projectManagerService.getWorktreeStatus(
			projectId,
			worktreePath
		);
	} catch (error) {
		await dialogService.prompt(createStatusErrorPrompt(
			worktreeName,
			worktreePath,
			error
		));
		return;
	}

	while (true) {
		const action = await readPromptResult(
			dialogService.prompt(
				createDeleteWorktreePrompt(
					worktreeName,
					worktreePath,
					status
				)
			)
		);
		if (!action) {
			return;
		}

		const options: RemoveWorktreeOptions = {
			force: action === 'force',
			expectedStatusFingerprint: status.fingerprint,
		};
		const result = await projectManagerService.removeWorktree(
			projectId,
			worktreePath,
			options
		);
		if (result.removed) {
			return;
		}

		status = result.status;
	}
}

/**
 * Formats one porcelain status record for the compact deletion preview.
 */
export function formatWorktreeStatusEntry(
	entry: WorktreeStatusEntry
): string {
	const status = `${entry.indexStatus}${entry.worktreeStatus}`;
	let label: string;
	if (CONFLICT_STATUSES.has(status)) {
		label = localize('worktreeStatusConflicted', 'Conflicted');
	} else if (status === '??') {
		label = localize('worktreeStatusUntracked', 'Untracked');
	} else {
		const stagedLabel = statusLabel(entry.indexStatus);
		const worktreeLabel = statusLabel(entry.worktreeStatus);
		const labels: string[] = [];
		if (stagedLabel) {
			labels.push(localize(
				'worktreeStatusStaged',
				'{0} (staged)',
				stagedLabel
			));
		}
		if (worktreeLabel) {
			labels.push(
				stagedLabel
					? worktreeLabel.toLocaleLowerCase()
					: worktreeLabel
			);
		}
		label = labels.join(', ') || localize(
			'worktreeStatusChanged',
			'Changed ({0})',
			status
		);
	}

	const path = entry.originalPath
		? `${formatWorktreeStatusPath(entry.originalPath)} -> ${formatWorktreeStatusPath(entry.path)}`
		: formatWorktreeStatusPath(entry.path);
	return `${label}  ${path}`;
}

function formatWorktreeStatusPath(path: string): string {
	if (!UNSAFE_PATH_CHARACTER.test(path)) {
		return path;
	}

	return `"${path.replace(
		PATH_CHARACTER_TO_ESCAPE,
		character => {
			switch (character) {
				case '"':
					return '\\"';
				case '\\':
					return '\\\\';
				case '\b':
					return '\\b';
				case '\f':
					return '\\f';
				case '\n':
					return '\\n';
				case '\r':
					return '\\r';
				case '\t':
					return '\\t';
				default: {
					const codePoint = character.codePointAt(0) ?? 0;
					return codePoint <= 0xffff
						? `\\u${codePoint.toString(16).padStart(4, '0')}`
						: `\\u{${codePoint.toString(16)}}`;
				}
			}
		}
	)}"`;
}

function statusLabel(status: string): string | undefined {
	switch (status) {
		case 'M':
			return localize('worktreeStatusModified', 'Modified');
		case 'A':
			return localize('worktreeStatusAdded', 'Added');
		case 'D':
			return localize('worktreeStatusDeleted', 'Deleted');
		case 'R':
			return localize('worktreeStatusRenamed', 'Renamed');
		case 'C':
			return localize('worktreeStatusCopied', 'Copied');
		case 'T':
			return localize('worktreeStatusTypeChanged', 'Type changed');
		default:
			return undefined;
	}
}

function createStatusErrorPrompt(
	worktreeName: string,
	worktreePath: string,
	error: unknown
): IPrompt<never> {
	return {
		type: 'error',
		message: localize(
			'deleteWorktreeStatusErrorTitle',
			'Unable to check changes in "{0}"',
			worktreeName
		),
		detail: localize(
			'deleteWorktreeStatusErrorDetail',
			'Hucode could not safely preview the worktree at:\n{0}\n\n{1}\n\nNo files were deleted.',
			worktreePath,
			error instanceof Error ? error.message : String(error)
		),
		buttons: [],
		cancelButton: localize('deleteWorktreeCloseButton', 'Close'),
		custom: {
			classes: ['hucode-worktree-delete-dialog'],
		},
	};
}

async function readPromptResult<T>(
	prompt: Promise<IPromptResult<T>>
): Promise<T | undefined> {
	return (await prompt).result;
}
