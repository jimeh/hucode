/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const MAX_ATTEMPTS = 4;
const INITIAL_RETRY_DELAY_MS = 5_000;
const GH_ATTEMPT_TIMEOUT_MS = 60_000;

export interface IUpdateServiceRelease {
	readonly tagName: string;
	readonly commitSha: string;
}

export interface IUpdateServiceDispatchDependencies {
	readonly environment: NodeJS.ProcessEnv;
	readonly runGh: (
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		timeoutMs: number
	) => Promise<void>;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly warning: (message: string) => void;
	readonly error: (message: string) => void;
	readonly appendSummary: (message: string) => Promise<void>;
}

class ReportedUpdateServiceDispatchError extends Error { }

/**
 * Dispatches a published release to hucode-updates with bounded retries.
 */
export async function dispatchUpdateServiceRefresh(
	release: IUpdateServiceRelease,
	dependencies: IUpdateServiceDispatchDependencies
): Promise<void> {
	const args = [
		'api',
		'--method',
		'POST',
		'/repos/jimeh/hucode-updates/dispatches',
		'-f',
		'event_type=hucode-release-published',
		'-f',
		`client_payload[tag]=${release.tagName}`,
		'-f',
		`client_payload[commit]=${release.commitSha}`,
	] as const;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await dependencies.runGh(
				args,
				dependencies.environment,
				GH_ATTEMPT_TIMEOUT_MS
			);
			return;
		} catch (error) {
			const errorMessage = getDiagnosticErrorMessage(error);
			if (attempt === MAX_ATTEMPTS) {
				const message =
					`Update service dispatch failed after ${MAX_ATTEMPTS} attempts: ` +
					errorMessage;
				dependencies.error(
					`::error::${escapeWorkflowCommandData(message)}`
				);
				try {
					await dependencies.appendSummary([
						'### Update metadata refresh failed',
						'',
						'The release was published, but hucode-updates was not notified.',
						'',
						`- Tag: \`${release.tagName}\``,
						`- Commit: \`${release.commitSha}\``,
						`- Error: ${errorMessage}`,
						'',
					].join('\n'));
				} catch (summaryError) {
					dependencies.warning(
						'::warning::' + escapeWorkflowCommandData(
							'Failed to append the update dispatch failure ' +
							'to GITHUB_STEP_SUMMARY: ' +
							getDiagnosticErrorMessage(summaryError)
						)
					);
				}
				throw new ReportedUpdateServiceDispatchError(message);
			}

			const delay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
			dependencies.warning(
				'::warning::' + escapeWorkflowCommandData(
					`Update service dispatch attempt ${attempt} of ` +
					`${MAX_ATTEMPTS} failed; retrying in ${delay / 1_000}s: ` +
					errorMessage
				)
			);
			await dependencies.sleep(delay);
		}
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getDiagnosticErrorMessage(error: unknown): string {
	return getErrorMessage(error).replace(/\r\n|\r|\n/g, ' ').trim();
}

function escapeWorkflowCommandData(value: string): string {
	return value
		.replace(/%/g, '%25')
		.replace(/\r/g, '%0D')
		.replace(/\n/g, '%0A');
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string
): string {
	const value = environment[name];
	if (!value) {
		throw new Error(`${name} is required.`);
	}
	return value;
}

function createDefaultDependencies(
	environment: NodeJS.ProcessEnv
): IUpdateServiceDispatchDependencies {
	return {
		environment,
		runGh: runGhCommand,
		sleep: milliseconds =>
			new Promise(resolve => setTimeout(resolve, milliseconds)),
		warning: message => console.warn(message),
		error: message => console.error(message),
		appendSummary: async message => {
			const summaryPath = environment.GITHUB_STEP_SUMMARY;
			if (summaryPath) {
				await fs.appendFile(summaryPath, message, 'utf8');
			}
		},
	};
}

/**
 * Runs the GitHub CLI with a hard per-attempt process deadline.
 */
export async function runGhCommand(
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
	timeoutMs: number,
	executable = 'gh'
): Promise<void> {
	await execFileAsync(executable, [...args], {
		env: environment,
		timeout: timeoutMs,
		killSignal: 'SIGKILL',
	});
}

async function main(): Promise<void> {
	const environment = process.env;
	await dispatchUpdateServiceRefresh({
		tagName: requiredEnvironment(environment, 'TAG_NAME'),
		commitSha: requiredEnvironment(environment, 'COMMIT_SHA'),
	}, createDefaultDependencies(environment));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		if (!(error instanceof ReportedUpdateServiceDispatchError)) {
			console.error(
				`::error::${escapeWorkflowCommandData(
					getDiagnosticErrorMessage(error)
				)}`
			);
		}
		process.exitCode = 1;
	}
}
