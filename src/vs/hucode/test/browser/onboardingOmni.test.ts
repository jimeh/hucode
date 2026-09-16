/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ResolvedKeybinding, decodeKeybinding } from '../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { URI } from '../../../base/common/uri.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IProjectManagerService, ProjectRecord } from '../../../platform/projectManager/common/projectManager.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { HucodeOnboardingOpenRequest, HucodeOnboardingOpenResult, HucodeOnboardingTarget } from '../../../platform/window/common/hucodeOnboardingHandoff.js';
import { USLayoutResolvedKeybinding } from '../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { MockKeybindingService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { OnboardingOmniAuthority } from '../../browser/onboarding/onboardingOmni.js';

suite('OnboardingOmniAuthority', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** Real resolved chords, so the labels under test are the ones the keybinding service would produce. */
	function chord(keybinding: number): ResolvedKeybinding {
		return USLayoutResolvedKeybinding.resolveKeybinding(decodeKeybinding(keybinding, OperatingSystem.Macintosh)!, OperatingSystem.Macintosh)[0];
	}

	function setup(bound: Record<string, ResolvedKeybinding> = {}, options: {
		folder?: URI;
		project?: ProjectRecord;
		offers?: HucodeOnboardingTarget[];
		choices?: number[];
		results?: HucodeOnboardingOpenResult[];
	} = {}) {
		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stub(IKeybindingService, new class extends MockKeybindingService {
			override lookupKeybinding(commandId: string): ResolvedKeybinding | undefined { return bound[commandId]; }
		}());
		const dialogs: string[] = [];
		const opened: HucodeOnboardingOpenRequest[] = [];
		const notifications: string[] = [];
		const promoted: string[] = [];
		instantiation.stub(IFileDialogService, { showOpenDialog: async () => options.folder ? [options.folder] : undefined });
		instantiation.stub(IProjectManagerService, {
			getProjects: async () => options.project ? [options.project] : [],
			addProject: async () => { if (!options.project) { throw new Error('discovery failed'); } return options.project; },
		});
		instantiation.stub(IQuickInputService, { pick: async () => undefined });
		instantiation.stub(INotificationService, {
			info: message => { notifications.push(String(message)); },
			error: message => { notifications.push(String(message)); },
		});
		instantiation.stub(IDialogService, {}, 'prompt', async (prompt: { message: string; buttons: { run(): string | boolean }[]; cancelButton: { run(): string | boolean } }) => {
			dialogs.push(prompt.message);
			const choice = options.choices?.shift() ?? 0;
			return { result: choice < 0 ? prompt.cancelButton.run() : prompt.buttons[choice].run() };
		});
		instantiation.stub(IHucodeShellControllerService, {
			promoteRetainedWorkbenchProjectFolders: async folders => { promoted.push(...folders.map(folder => URI.revive(folder.folderUri).fsPath)); return {} as Awaited<ReturnType<IHucodeShellControllerService['getState']>>; },
			inspectOnboardingTarget: async worktreePath => options.offers?.shift() ?? { worktreePath, alreadyOpen: false },
			openOnboardingWorkbench: async request => { opened.push(request); return options.results?.shift() ?? { kind: 'opened', associationSaved: !!request.profileId }; },
		});
		return { authority: instantiation.createInstance(OnboardingOmniAuthority), dialogs, opened, notifications, promoted };
	}

	test('lists the four commands with a resolved chord where one is bound and none otherwise', () => {
		const unbound = setup().authority.snapshot().shortcuts;
		const bound = setup({
			'hucode.projectSwitcher.switchWorktree': chord(KeyMod.CtrlCmd | KeyCode.KeyO),
			'hucode.projectSwitcher.switchNextLoadedWorktree': chord(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.DownArrow)),
		}).authority.snapshot().shortcuts;
		assert.deepStrictEqual({ unbound, bound }, {
			unbound: [
				{ commandId: 'hucode.projectSwitcher.switchWorktree', label: 'Switch Workbench' },
				{ commandId: 'hucode.projectSwitcher.quickSwitchLoadedWorktree', label: 'Quick Switch Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchNextLoadedWorktree', label: 'Switch to Next Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchPreviousLoadedWorktree', label: 'Switch to Previous Loaded Workbench' },
			],
			bound: [
				{ commandId: 'hucode.projectSwitcher.switchWorktree', label: 'Switch Workbench', keybinding: { label: '⌘O', ariaLabel: 'Command+O' } },
				{ commandId: 'hucode.projectSwitcher.quickSwitchLoadedWorktree', label: 'Quick Switch Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchNextLoadedWorktree', label: 'Switch to Next Loaded Workbench', keybinding: { label: '⌘K ⌘↓', ariaLabel: 'Command+K Command+DownArrow' } },
				{ commandId: 'hucode.projectSwitcher.switchPreviousLoadedWorktree', label: 'Switch to Previous Loaded Workbench' },
			],
		});
	});

	test('a cancelled folder picker leaves completion alone and opens nothing', async () => {
		const { authority, opened, dialogs } = setup();
		await authority.addProject();
		await authority.openFolderAsWorkbench();
		assert.deepStrictEqual({ opened, dialogs }, { opened: [], dialogs: [] });
	});

	test('offers the actual imported profile for the exact selected folder and preserves by default', async () => {
		const offer: HucodeOnboardingTarget = { worktreePath: '/repo/feature', alreadyOpen: false, importedProfile: { id: 'actual-id', name: 'Imported' } };
		const keep = setup({}, { folder: URI.file('/repo/feature'), offers: [offer] });
		const use = setup({}, { folder: URI.file('/repo/feature'), offers: [offer], choices: [1] });
		await keep.authority.openFolderAsWorkbench('actual-id');
		await use.authority.openFolderAsWorkbench('actual-id');
		assert.deepStrictEqual([keep.opened[0].profileId, use.opened[0].profileId, use.opened[0].worktreePath], [undefined, 'actual-id', '/repo/feature']);
	});

	test('requires explicit replacement confirmation and can cancel without opening', async () => {
		const offer: HucodeOnboardingTarget = { worktreePath: '/repo', alreadyOpen: false, associatedProfileId: 'prior', associatedProfileName: 'Prior', importedProfile: { id: 'imported', name: 'Imported' } };
		const keep = setup({}, { folder: URI.file('/repo'), offers: [offer], choices: [1, 0] });
		const replace = setup({}, { folder: URI.file('/repo'), offers: [offer], choices: [1, 1] });
		const cancel = setup({}, { folder: URI.file('/repo'), offers: [offer], choices: [-1] });
		await keep.authority.openFolderAsWorkbench('imported');
		await replace.authority.openFolderAsWorkbench('imported');
		await cancel.authority.openFolderAsWorkbench('imported');
		assert.deepStrictEqual({ keep: keep.opened[0].profileId, replace: replace.opened[0], cancel: cancel.opened }, {
			keep: undefined, replace: { worktreePath: '/repo', projectId: undefined, profileId: 'imported', expectedProfileId: 'prior' }, cancel: [],
		});
	});

	test('already-open owners get focus-only admission, including an owner appearing during the offer', async () => {
		const offer: HucodeOnboardingTarget = { worktreePath: '/repo', alreadyOpen: true, importedProfile: { id: 'imported', name: 'Imported' } };
		const open = setup({}, { folder: URI.file('/repo'), offers: [offer], results: [{ kind: 'alreadyOpen', associationSaved: false }] });
		await open.authority.openFolderAsWorkbench('imported');
		assert.deepStrictEqual({ dialogs: open.dialogs, profile: open.opened[0].profileId, explains: open.notifications[0].includes('profile is unchanged') }, { dialogs: [], profile: undefined, explains: true });
		const race = setup({}, { folder: URI.file('/repo'), offers: [{ ...offer, alreadyOpen: false }], choices: [1], results: [{ kind: 'alreadyOpen', associationSaved: false }] });
		await race.authority.openFolderAsWorkbench('imported');
		assert.strictEqual(race.notifications[0].includes('profile is unchanged'), true);
	});

	test('a deleted or ineligible import profile opens with the existing association and no offer', async () => {
		const { authority, dialogs, opened } = setup({}, { folder: URI.file('/repo') });
		await authority.openFolderAsWorkbench('deleted');
		assert.deepStrictEqual({ dialogs, profileId: opened[0].profileId }, { dialogs: [], profileId: undefined });
	});

	test('reports saved association plus failed open separately and never retries an open failure', async () => {
		const { authority, opened, notifications } = setup({}, { folder: URI.file('/repo'), results: [{ kind: 'failed', associationSaved: true, message: 'load failed' }] });
		await authority.openFolderAsWorkbench();
		assert.strictEqual(opened.length, 1);
		assert.match(notifications[0], /association was saved.*load failed/);
	});

	test('re-prompts an association conflict with a fresh main-owned offer', async () => {
		const offer: HucodeOnboardingTarget = { worktreePath: '/repo', alreadyOpen: false, importedProfile: { id: 'imported', name: 'Imported' } };
		const { authority, opened, dialogs } = setup({}, { folder: URI.file('/repo'), offers: [offer, offer], choices: [1, 0], results: [{ kind: 'conflict' }, { kind: 'opened', associationSaved: false }] });
		await authority.openFolderAsWorkbench('imported');
		assert.deepStrictEqual({ profiles: opened.map(request => request.profileId), dialogs: dialogs.length }, { profiles: ['imported', undefined], dialogs: 2 });
	});

	test('Add Project reports discovery failure without attempting a handoff', async () => {
		const { authority, opened, notifications } = setup({}, { folder: URI.file('/not-a-repo') });
		await authority.addProject();
		assert.deepStrictEqual({ opened, notifications }, { opened: [], notifications: ['discovery failed'] });
	});

	test('Add Project opens the selected worktree after catalog promotion instead of only adding the repository', async () => {
		const project: ProjectRecord = {
			id: 'project', label: 'Repository', rootUri: URI.file('/repo'), pinned: false, order: 0, worktreeState: 'current', lastActiveWorktreePath: '/repo/main',
			worktrees: [
				{ path: '/repo/main', label: 'main', isMain: true, isDetached: false },
				{ path: '/repo/feature', label: 'feature', isMain: false, isDetached: false },
			],
		};
		const { authority, opened, promoted } = setup({}, { folder: URI.file('/repo/feature'), project });
		await authority.addProject();
		assert.deepStrictEqual(promoted, ['/repo/main', '/repo/feature']);
		assert.deepStrictEqual(opened, [{ worktreePath: '/repo/feature', projectId: 'project', profileId: undefined, expectedProfileId: undefined }]);
	});

	test('a repository root resolves a valid last-active worktree then main, and does not guess without either', async () => {
		const project: ProjectRecord = {
			id: 'project', label: 'Repository', rootUri: URI.file('/bare.git'), pinned: false, order: 0, worktreeState: 'current', lastActiveWorktreePath: '/checkouts/feature',
			worktrees: [
				{ path: '/checkouts/main', label: 'main', isMain: true, isDetached: false },
				{ path: '/checkouts/feature', label: 'feature', isMain: false, isDetached: false },
			],
		};
		const last = setup({}, { folder: project.rootUri, project });
		const main = setup({}, { folder: project.rootUri, project: { ...project, lastActiveWorktreePath: '/gone' } });
		const unresolved = setup({}, { folder: project.rootUri, project: { ...project, lastActiveWorktreePath: '/gone', worktrees: project.worktrees.filter(worktree => !worktree.isMain) } });
		await last.authority.addProject();
		await main.authority.addProject();
		await unresolved.authority.addProject();
		assert.deepStrictEqual([last.opened[0].worktreePath, main.opened[0].worktreePath, unresolved.opened], ['/checkouts/feature', '/checkouts/main', []]);
	});
});
