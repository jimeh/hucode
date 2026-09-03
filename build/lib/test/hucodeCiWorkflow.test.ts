/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
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

function readYaml<T>(...segments: string[]): T {
	return load(readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', ...segments), 'utf8')) as T;
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
