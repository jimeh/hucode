/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type {
	ICheckboxResult,
	IPrompt,
	IPromptResult,
} from '../../../../platform/dialogs/common/dialogs.js';
import type {
	IProjectManagerService,
	RemoveWorktreeOptions,
	RemoveWorktreeResult,
	WorktreeStatusPreview,
} from '../../../../platform/projectManager/common/projectManager.js';
import {
	createDeleteWorktreePrompt,
	deleteWorktreeWithPreview,
	isCurrentWorktreePath,
} from '../../../browser/projectSwitcher/removeWorktree.js';

suite('Remove Worktree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('enables regular deletion for a clean worktree', async () => {
		const harness = createHarness([cleanPreview]);
		harness.actions.push('delete');

		await run(harness);

		assert.strictEqual(harness.prompts.length, 1);
		assert.deepStrictEqual(
			harness.prompts[0].buttons?.map(button => button.label),
			['Delete', 'Force Delete']
		);
		assert.deepStrictEqual(
			customButtonEnabled(harness.prompts[0]),
			[true, false, true]
		);
		assert.deepStrictEqual(harness.removals, [{
			projectId: 'project',
			worktreePath: '/repo.worktrees/feature',
			options: {
				force: false,
				expectedStatusFingerprint: 'clean',
			},
		}]);
	});

	test('enables force deletion and formats every dirty status', async () => {
		const dirty = preview('dirty', [
			entry('M', ' ', 'modified.ts'),
			entry('A', ' ', 'staged.ts'),
			entry(' ', 'D', 'deleted.ts'),
			entry('?', '?', 'untracked.ts'),
			entry('R', ' ', 'new-name.ts', 'old-name.ts'),
			entry('C', ' ', 'copy.ts', 'source.ts'),
			entry('T', ' ', 'type.ts'),
			entry('U', 'U', 'conflicted.ts'),
			entry('A', 'M', 'added-then-modified.ts'),
		]);
		const harness = createHarness([dirty]);
		harness.actions.push('force');

		await run(harness);

		const prompt = harness.prompts[0];
		assert.deepStrictEqual(
			prompt.buttons?.map(button => button.label),
			['Force Delete', 'Delete']
		);
		assert.deepStrictEqual(
			customButtonEnabled(prompt),
			[true, false, true]
		);
		const markdown = prompt.custom && typeof prompt.custom === 'object'
			? prompt.custom.markdownDetails?.[0].markdown.value
			: undefined;
		assert.ok(markdown?.includes('9 uncommitted changes'));
		for (const expected of [
			'Modified (staged)  modified.ts',
			'Added (staged)  staged.ts',
			'Deleted  deleted.ts',
			'Untracked  untracked.ts',
			'Renamed (staged)  old-name.ts -> new-name.ts',
			'Copied (staged)  source.ts -> copy.ts',
			'Type changed (staged)  type.ts',
			'Conflicted  conflicted.ts',
			'Added (staged), modified  added-then-modified.ts',
		]) {
			assert.ok(markdown?.includes(expected), expected);
		}
		assert.deepStrictEqual(harness.removals[0].options, {
			force: true,
			expectedStatusFingerprint: 'dirty',
		});
	});

	test('cancels without removing', async () => {
		const harness = createHarness([cleanPreview]);
		harness.actions.push('cancel');

		await run(harness);

		assert.strictEqual(harness.prompts.length, 1);
		assert.deepStrictEqual(harness.removals, []);
	});

	test('recognizes the current worktree removal guard', () => {
		assert.strictEqual(
			isCurrentWorktreePath(
				'/repo.worktrees/feature',
				'/repo.worktrees/feature'
			),
			true
		);
		assert.strictEqual(
			isCurrentWorktreePath('/repo.worktrees/feature', '/repo'),
			false
		);
		assert.strictEqual(
			isCurrentWorktreePath('/repo.worktrees/feature', undefined),
			false
		);
	});

	test('shows a human error without deletion when status cannot be read',
		async () => {
			const harness = createHarness([new Error('git exploded')]);
			harness.actions.push('cancel');

			await run(harness);

			assert.strictEqual(harness.prompts.length, 1);
			assert.strictEqual(
				harness.prompts[0].message,
				'Unable to check changes in "feature"'
			);
			assert.strictEqual(harness.prompts[0].buttons?.length, 0);
			assert.ok(harness.prompts[0].detail?.includes('git exploded'));
			assert.deepStrictEqual(harness.removals, []);
		}
	);

	test('reopens with the refreshed preview when the snapshot drifts',
		async () => {
			const dirty = preview('dirty', [entry('?', '?', 'new.ts')]);
			const harness = createHarness([cleanPreview]);
			harness.actions.push('delete', 'force');
			harness.removeResults.push(
				{ removed: false, status: dirty },
				{ removed: true }
			);

			await run(harness);

			assert.strictEqual(harness.prompts.length, 2);
			assert.strictEqual(harness.prompts[0].message,
				'Delete worktree "feature"?');
			assert.ok(promptMarkdown(harness.prompts[1])
				?.includes('1 uncommitted change'));
			assert.deepStrictEqual(
				harness.removals.map(removal => removal.options),
				[
					{
						force: false,
						expectedStatusFingerprint: 'clean',
					},
					{
						force: true,
						expectedStatusFingerprint: 'dirty',
					},
				]
			);
		}
	);

	test('reports omitted changes after the 1000-entry preview boundary', () => {
		const exact = preview(
			'exact',
			Array.from({ length: 1000 }, (_, index) =>
				entry('?', '?', `file-${index}.ts`)
			)
		);
		const truncated: WorktreeStatusPreview = {
			...exact,
			fingerprint: 'truncated',
			totalCount: 1001,
			omittedCount: 1,
		};

		assert.ok(!promptMarkdown(createDeleteWorktreePrompt(
			'feature',
			'/repo.worktrees/feature',
			exact
		))?.includes('not shown'));
		const markdown = promptMarkdown(createDeleteWorktreePrompt(
			'feature',
			'/repo.worktrees/feature',
			truncated
		));
		assert.ok(markdown?.includes('1,001 uncommitted changes'));
		assert.ok(markdown?.includes('and 1 more change not shown'));
		assert.ok(markdown?.includes('file-999.ts'));
	}
	);
});

type Prompt = IPrompt<'delete' | 'force'>;

interface Harness {
	readonly prompts: Prompt[];
	readonly removals: {
		readonly projectId: string;
		readonly worktreePath: string;
		readonly options: RemoveWorktreeOptions;
	}[];
	readonly actions: ('delete' | 'force' | 'cancel')[];
	readonly removeResults: RemoveWorktreeResult[];
	readonly projectManager: Pick<
		IProjectManagerService,
		'getWorktreeStatus' | 'removeWorktree'
	>;
	readonly dialog: {
		prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;
	};
}

function createHarness(
	statuses: (WorktreeStatusPreview | Error)[]
): Harness {
	const prompts: Prompt[] = [];
	const removals: Harness['removals'] = [];
	const actions: Harness['actions'] = [];
	const removeResults: RemoveWorktreeResult[] = [];
	return {
		prompts,
		removals,
		actions,
		removeResults,
		projectManager: {
			async getWorktreeStatus() {
				const status = statuses.shift();
				assert.ok(status);
				if (status instanceof Error) {
					throw status;
				}
				return status;
			},
			async removeWorktree(projectId, worktreePath, options) {
				assert.ok(options);
				removals.push({ projectId, worktreePath, options });
				return removeResults.shift() ?? { removed: true };
			},
		},
		dialog: {
			async prompt<T>(prompt: IPrompt<T>) {
				prompts.push(prompt as Prompt);
				const action = actions.shift();
				if (!action || action === 'cancel') {
					return {};
				}
				const button = prompt.buttons?.find(candidate =>
					candidate.label === (
						action === 'delete' ? 'Delete' : 'Force Delete'
					)
				);
				assert.ok(button);
				return {
					result: await button.run({} as ICheckboxResult),
				};
			},
		},
	};
}

function run(harness: Harness): Promise<void> {
	return deleteWorktreeWithPreview(
		'project',
		'/repo.worktrees/feature',
		'feature',
		harness.projectManager,
		harness.dialog
	);
}

function preview(
	fingerprint: string,
	entries: WorktreeStatusPreview['entries']
): WorktreeStatusPreview {
	return {
		fingerprint,
		totalCount: entries.length,
		entries,
		omittedCount: 0,
	};
}

function entry(
	indexStatus: string,
	worktreeStatus: string,
	path: string,
	originalPath?: string
): WorktreeStatusPreview['entries'][number] {
	return {
		indexStatus,
		worktreeStatus,
		path,
		originalPath,
	};
}

const cleanPreview: WorktreeStatusPreview = preview('clean', []);

function customButtonEnabled(prompt: Prompt): readonly boolean[] | undefined {
	return prompt.custom && typeof prompt.custom === 'object'
		? prompt.custom.buttonEnabled
		: undefined;
}

function promptMarkdown(prompt: Prompt): string | undefined {
	return prompt.custom && typeof prompt.custom === 'object'
		? prompt.custom.markdownDetails?.[0].markdown.value
		: undefined;
}
