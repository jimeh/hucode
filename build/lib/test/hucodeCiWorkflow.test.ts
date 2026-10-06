/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { suite, test } from 'node:test';
import { load } from 'js-yaml';

interface IWorkflowStep {
	readonly name?: string;
	readonly if?: string;
	readonly run?: string;
}

interface IAction {
	readonly runs?: {
		readonly steps?: readonly IWorkflowStep[];
	};
}

interface IWorkflow {
	readonly jobs?: Record<string, {
		readonly steps?: readonly IWorkflowStep[];
	}>;
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function readYaml<T>(...segments: string[]): T {
	return load(readFileSync(path.resolve(repoRoot, ...segments), 'utf8')) as T;
}

/**
 * Returns the Hucode workflows and the local composite actions they use,
 * directly or through another local action.
 */
function hucodeWorkflowFiles(): string[] {
	const files = readdirSync(path.join(repoRoot, '.github/workflows'))
		.filter(name => name.startsWith('hucode-') && name.endsWith('.yml'))
		.map(name => `.github/workflows/${name}`);
	for (let i = 0; i < files.length; i++) {
		const text = readFileSync(path.join(repoRoot, files[i]), 'utf8');
		for (const match of text.matchAll(/uses: \.\/(?<action>\.github\/actions\/[\w-]+)/g)) {
			const action = `${match.groups!.action}/action.yml`;
			if (!files.includes(action)) {
				files.push(action);
			}
		}
	}
	return files;
}

function requiredStepIndex(steps: readonly IWorkflowStep[], name: string): number {
	const index = steps.findIndex(step => step.name === name);
	assert.notStrictEqual(index, -1, `Expected workflow step '${name}'`);
	return index;
}

function assertPreparesElectronTypes(
	steps: readonly IWorkflowStep[],
	beforeStepName: string
): void {
	const install = requiredStepIndex(steps, 'Install dependencies');
	const prepare = requiredStepIndex(steps, 'Prepare Electron types');
	const before = requiredStepIndex(steps, beforeStepName);

	assert.ok(prepare > install, 'Electron types must be prepared after dependency restoration');
	assert.ok(before > prepare, `Electron types must be prepared before '${beforeStepName}'`);
	assert.strictEqual(steps[prepare].if, undefined, 'Electron types must also be prepared on cache hits');
	assert.strictEqual(steps[prepare].run, 'node build/npm/electronTypes.ts');
}

suite('Hucode CI workflow contract', () => {
	test('runs only repository scripts that exist', () => {
		// Upstream deletes build helpers between baselines; a missing script
		// fails every job that runs it, which only CI would otherwise reveal.
		const missing = hucodeWorkflowFiles().flatMap(file => {
			const text = readFileSync(path.join(repoRoot, file), 'utf8');
			const scripts = [
				...text.matchAll(/\bnode (?<script>(?:build|scripts|\.github)\/[\w./-]+\.(?:ts|js|mjs))/g),
				...text.matchAll(/(?:^|\s)\.\/(?<script>(?:build|scripts|\.github)\/[\w./-]+\.(?:sh|ps1))/g),
			].map(match => match.groups!.script);
			return scripts
				.filter(script => !existsSync(path.join(repoRoot, script)))
				.map(script => `${file}: ${script}`);
		});
		assert.deepStrictEqual(missing, []);
	});

	test('prepares Electron types in the shared Linux setup on cache hits', () => {
		const action = readYaml<IAction>('.github', 'actions', 'setup-hucode-linux', 'action.yml');
		const steps = action.runs?.steps;
		assert.ok(steps, 'setup-hucode-linux steps must exist');

		const install = requiredStepIndex(steps, 'Install dependencies');
		const prepare = requiredStepIndex(steps, 'Prepare Electron types');
		assert.ok(prepare > install, 'Electron types must follow dependency restoration');
		assert.strictEqual(steps[prepare].if, undefined, 'Electron types must also be prepared on cache hits');
		assert.strictEqual(steps[prepare].run, 'node build/npm/electronTypes.ts');
	});

	test('prepares Electron types before compiling unit tests on cache hits', () => {
		const workflow = readYaml<IWorkflow>('.github', 'workflows', 'hucode-ci.yml');
		const steps = workflow.jobs?.['unit-tests']?.steps;
		assert.ok(steps, 'unit-tests steps must exist');

		assertPreparesElectronTypes(steps, 'Compile Hucode');
	});
});
