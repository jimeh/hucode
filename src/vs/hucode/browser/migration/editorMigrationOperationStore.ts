/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { dirname, joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { FileOperationResult, FileSystemProviderCapabilities, IFileService, toFileOperationResult } from '../../../platform/files/common/files.js';
import {
	EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
	EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION,
	EditorMigrationOperation,
	EditorMigrationOperationSummary,
	editorMigrationPublishers,
	verifyEditorMigrationOperationIntegrity,
	verifiedPersistedEditorMigrationPlanFingerprint,
} from '../../common/migration/editorMigrationApply.js';
import { fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';

/** Atomic local store for Apply journals and recovery payloads. */
export class EditorMigrationOperationStore {
	readonly root: URI;

	constructor(private readonly fileService: IFileService, defaultSettingsResource: URI) {
		this.root = joinPath(dirname(defaultSettingsResource), 'hucode', 'migration', 'operations');
	}

	/** Creates the first durable journal revision. */
	async create(operation: EditorMigrationOperation): Promise<void> {
		await validateOperation(operation, operation.id);
		if (!this.fileService.hasCapability(this.root, FileSystemProviderCapabilities.FileAtomicRead)
			|| !this.fileService.hasCapability(this.root, FileSystemProviderCapabilities.FileAtomicWrite)) {
			throw new Error('Editor migration Apply requires atomic operation storage');
		}
		if (await this.fileService.exists(this.operationResource(operation.id))) {
			throw new Error(`Migration operation '${operation.id}' already exists`);
		}
		await this.fileService.createFolder(this.operationHome(operation.id));
		await this.fileService.createFolder(this.snapshotsHome(operation.id));
		await this.writeRecord(operation);
	}

	/** Replaces a journal after enforcing monotonic revisions. */
	async update(previous: EditorMigrationOperation, update: EditorMigrationOperation, now = Date.now()): Promise<EditorMigrationOperation> {
		if (update.id !== previous.id || update.schemaVersion !== EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION) {
			throw new Error('Migration operation identity or schema changed');
		}
		const current = await this.read(previous.id);
		if (current.revision !== previous.revision) {
			throw new Error(`Migration operation '${previous.id}' revision changed`);
		}
		const next: EditorMigrationOperation = { ...update, revision: previous.revision + 1, updatedAt: now };
		await validateOperation(next, next.id);
		await this.writeRecord(next);
		return next;
	}

	/** Reads and validates one supported journal. */
	async read(operationId: string): Promise<EditorMigrationOperation> {
		const contents = (await this.fileService.readFile(this.operationResource(operationId), { atomic: true })).value.toString();
		const value = JSON.parse(contents) as EditorMigrationOperation;
		await validateOperation(value, operationId);
		return value;
	}

	/** Lists supported recovery records without rewriting unknown versions. */
	async list(): Promise<readonly EditorMigrationOperationSummary[]> {
		let children;
		try {
			children = (await this.fileService.resolve(this.root)).children ?? [];
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return [];
			}
			throw error;
		}
		const result: EditorMigrationOperationSummary[] = [];
		for (const child of children.filter(child => child.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
			let contents: string;
			try {
				contents = (await this.fileService.readFile(joinPath(child.resource, 'operation.json'), { atomic: true })).value.toString();
			} catch (error) {
				if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
					continue;
				}
				throw error;
			}
			try {
				const raw = JSON.parse(contents) as Partial<EditorMigrationOperation>;
				if (raw.schemaVersion !== EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION) {
					result.push({ id: child.name, stage: 'admitted', createdAt: 0, updatedAt: 0, recoverable: false, unsupportedSchemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : -1 });
					continue;
				}
				const operation = raw as EditorMigrationOperation;
				await validateOperation(operation, child.name);
				result.push({
					id: operation.id,
					stage: operation.stage,
					aggregateOutcome: operation.aggregateOutcome,
					createdAt: operation.createdAt,
					updatedAt: operation.updatedAt,
					targetName: operation.target.profileName,
					recoverable: !operation.acknowledged && operation.stage !== 'rolledBack',
				});
			} catch {
				result.push({ id: child.name, stage: 'admitted', createdAt: 0, updatedAt: 0, recoverable: false, unsupportedSchemaVersion: -1 });
			}
		}
		return result;
	}

	/** Writes a recovery payload before the journal references it. */
	async writeSnapshot(operationId: string, relativePath: string, contents: VSBuffer): Promise<string> {
		const resource = this.snapshotResource(operationId, relativePath);
		await this.fileService.createFolder(dirname(resource));
		await this.fileService.writeFile(resource, contents, { atomic: { postfix: '.hucode-tmp' } });
		return relativePath;
	}

	/** Reads one recovery payload. */
	async readSnapshot(operationId: string, relativePath: string): Promise<VSBuffer> {
		return (await this.fileService.readFile(this.snapshotResource(operationId, relativePath), { atomic: true })).value;
	}

	/** Removes acknowledged private recovery data. */
	async delete(operationId: string): Promise<void> {
		try {
			await this.fileService.del(this.operationHome(operationId), { recursive: true });
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				throw error;
			}
		}
	}

	private operationHome(operationId: string): URI {
		assertSafeSegment(operationId);
		return joinPath(this.root, operationId);
	}

	private snapshotsHome(operationId: string): URI {
		return joinPath(this.operationHome(operationId), 'snapshots');
	}

	private operationResource(operationId: string): URI {
		return joinPath(this.operationHome(operationId), 'operation.json');
	}

	private snapshotResource(operationId: string, relativePath: string): URI {
		for (const segment of relativePath.split('/')) {
			assertSafeSegment(segment);
		}
		return joinPath(this.snapshotsHome(operationId), ...relativePath.split('/'));
	}

	private async writeRecord(operation: EditorMigrationOperation): Promise<void> {
		await this.fileService.writeFile(this.operationResource(operation.id), VSBuffer.fromString(`${JSON.stringify(operation, undefined, '\t')}\n`), { atomic: { postfix: '.hucode-tmp' } });
	}
}

async function validateOperation(value: EditorMigrationOperation, operationId: string): Promise<void> {
	if (!value || typeof value !== 'object' || value.schemaVersion !== EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION || value.id !== operationId || !Number.isSafeInteger(value.revision)
		|| !value.plan || !value.integrity || !value.authorization
		|| value.plan.schemaVersion !== EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION
		|| value.authorization.planningSchemaVersion !== EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION
		|| value.authorization.planningSchemaVersion !== value.plan.schemaVersion
		|| value.authorization.planFingerprint !== value.plan.fingerprints?.plan
		|| !Array.isArray(value.authorization.publishers)
		|| !Number.isFinite(value.authorization.issuedAt)
		|| !Number.isFinite(value.authorization.consumedAt)
		|| value.authorization.consumedAt < value.authorization.issuedAt) {
		throw new Error(`Migration operation '${operationId}' has an unsupported or corrupt schema`);
	}
	try {
		await verifyEditorMigrationOperationIntegrity(value.plan, value.integrity);
		const planFingerprint = await verifiedPersistedEditorMigrationPlanFingerprint(value.plan);
		const publishers = editorMigrationPublishers(value.plan);
		if (value.authorization.planFingerprint !== planFingerprint
			|| JSON.stringify(value.authorization.publishers) !== JSON.stringify(publishers)
			|| value.authorization.publisherSetFingerprint !== await fingerprintEditorMigrationValue(publishers)) {
			throw new Error('Authorization linkage is corrupt');
		}
	} catch {
		throw new Error(`Migration operation '${operationId}' has an unsupported or corrupt plan fingerprint`);
	}
}

function assertSafeSegment(value: string): void {
	if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
		throw new Error('Migration operation path contains an invalid segment');
	}
}
