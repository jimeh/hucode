/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ArrowRightIcon } from 'lucide-react';
import { useDeferredValue, useMemo, type RefObject } from 'react';
import type {
	EditorMigrationSetupAction,
	EditorMigrationSetupConflictRow,
	EditorMigrationSetupIntent,
	EditorMigrationSetupPanel,
	EditorMigrationSetupRadioOption,
} from '@/generated/editorMigrationSetupProtocol';
import type { LocalSetupState } from '@/lib/localState';
import { VirtualCollection } from '@/components/VirtualCollection';
import { ActionButton, Disclosure, FilterInput, GroupList, Lead, Note, PanelHeading, ProblemList, SubHeading } from '@/components/primitives';
import { Button } from '@/vendor/shadcn/button';
import { Checkbox } from '@/vendor/shadcn/checkbox';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/vendor/shadcn/field';
import { Input } from '@/vendor/shadcn/input';
import { Progress } from '@/vendor/shadcn/progress';
import { RadioGroup, RadioGroupItem } from '@/vendor/shadcn/radio-group';

/** Beyond this many comparison rows the user needs the filter rather than more scrolling. */
const CONFLICT_ROW_LIMIT = 60;

export interface SetupPanelProps {
	readonly panel: EditorMigrationSetupPanel;
	readonly local: LocalSetupState;
	readonly scrollRef: RefObject<HTMLElement | null>;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
	readonly busy: boolean;
}

export function SetupPanelView(props: SetupPanelProps) {
	const { panel } = props;
	switch (panel.kind) {
		case 'loading': return <LoadingPanel {...props} panel={panel} />;
		case 'recovery': return <RecoveryPanel {...props} panel={panel} />;
		case 'applications': return <ApplicationsPanel {...props} panel={panel} />;
		case 'profiles': return <ProfilesPanel {...props} panel={panel} />;
		case 'target': return <TargetPanel {...props} panel={panel} />;
		case 'reviewCategory': return <ReviewCategoryPanel {...props} panel={panel} />;
		case 'groups': return <GroupsPanel {...props} panel={panel} />;
		case 'applyOverview': return <ApplyOverviewPanel {...props} panel={panel} />;
		case 'applyCategory': return <ApplyCategoryPanel {...props} panel={panel} />;
		case 'resultsOverview': return <ResultsOverviewPanel {...props} panel={panel} />;
		case 'resultsCategory': return <ResultsCategoryPanel {...props} panel={panel} />;
		case 'restore': return <RestorePanel {...props} panel={panel} />;
		case 'message': return (
			<PanelBody>
				<PanelHeading>{panel.heading}</PanelHeading>
				{panel.lead ? <Lead>{panel.lead}</Lead> : null}
			</PanelBody>
		);
	}
}

function PanelBody({ children }: { readonly children: React.ReactNode }) {
	return <div className="flex flex-col gap-4 pb-6">{children}</div>;
}

type PanelOf<K extends EditorMigrationSetupPanel['kind']> = Extract<EditorMigrationSetupPanel, { kind: K }>;

function LoadingPanel({ panel }: SetupPanelProps & { readonly panel: PanelOf<'loading'> }) {
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<div className="flex max-w-md flex-col gap-2">
				<Progress aria-label={panel.progress.text} />
				<Note>{panel.progress.text}</Note>
			</div>
		</PanelBody>
	);
}

/** Case-insensitive contains, matching the previous view's filtering. */
function matches(text: string, filter: string): boolean {
	return text.toLowerCase().includes(filter.toLowerCase());
}

function RecoveryPanel({ panel, local, scrollRef, send }: SetupPanelProps & { readonly panel: PanelOf<'recovery'> }) {
	const filter = useDeferredValue(local.filters[`recoveries`] ?? '');
	const records = useMemo(() => panel.records.filter(record => matches(record.title, filter)), [panel.records, filter]);
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<FilterInput
				id="recoveries"
				label={panel.filterLabel}
				value={local.filters['recoveries'] ?? ''}
				itemCount={panel.records.length}
				onChange={value => local.setFilter('recoveries', value)}
			/>
			{panel.records.length === 0 ? <Note>{panel.emptyText}</Note> : null}
			<VirtualCollection
				items={records}
				itemKey={record => record.id}
				estimateSize={72}
				scrollRef={scrollRef}
				label={panel.listLabel}
				className="gap-2"
				itemClassName="pb-2"
			>
				{record => (
					<div className="border-border bg-card flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="truncate text-sm font-medium">{record.title}</span>
							<span className="text-muted-foreground text-xs">{record.detail}</span>
						</div>
						{record.action ? <ActionButton action={record.action} onRun={action => send(action.intent)} /> : null}
					</div>
				)}
			</VirtualCollection>
		</PanelBody>
	);
}

function ApplicationsPanel({ panel, local, scrollRef, send }: SetupPanelProps & { readonly panel: PanelOf<'applications'> }) {
	const filter = useDeferredValue(local.filters['applications'] ?? '');
	const applications = useMemo(() => panel.applications.filter(application => matches(application.title, filter)), [panel.applications, filter]);
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<FilterInput
				id="applications"
				label={panel.filterLabel}
				value={local.filters['applications'] ?? ''}
				itemCount={panel.applications.length}
				onChange={value => local.setFilter('applications', value)}
			/>
			{panel.applications.length === 0 ? <Note>{panel.emptyText}</Note> : null}
			{panel.applications.length > 0 && applications.length === 0 ? <Note>{panel.noMatchText}</Note> : null}
			<VirtualCollection
				items={applications}
				itemKey={application => application.id}
				estimateSize={56}
				scrollRef={scrollRef}
				label={panel.listLabel}
				itemClassName="pb-2"
			>
				{application => (
					<Button
						type="button"
						variant="outline"
						data-focus-id={`application-${application.id}`}
						className="h-auto w-full justify-between px-3 py-2.5 text-left"
						onClick={() => send(application.intent)}
					>
						<span className="flex min-w-0 flex-col items-start gap-0.5">
							<span className="truncate text-sm font-medium">{application.title}</span>
							<span className="text-muted-foreground text-xs font-normal">{application.detail}</span>
						</span>
						<ArrowRightIcon aria-hidden />
					</Button>
				)}
			</VirtualCollection>
			{panel.diagnostics ? (
				<Disclosure
					disclosure={panel.diagnostics}
					scope="applications"
					open={local.openDisclosures.has(`applications:${panel.diagnostics.id}`)}
					onOpenChange={open => local.toggleDisclosure(`applications:${panel.diagnostics!.id}`, open)}
				/>
			) : null}
		</PanelBody>
	);
}

/** Shared radio list. Choices use native radio semantics through the vendored component. */
function OptionList({ options, name, label, send, focusPrefix }: {
	readonly options: readonly EditorMigrationSetupRadioOption[];
	readonly name: string;
	readonly label: string;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
	readonly focusPrefix: string;
}) {
	const checked = options.find(option => option.checked)?.id;
	return (
		<RadioGroup
			name={name}
			aria-label={label}
			value={checked ?? ''}
			onValueChange={id => {
				const option = options.find(candidate => candidate.id === id);
				if (option) {
					send(option.intent);
				}
			}}
			className="gap-0"
		>
			{options.map(option => (
				<Field key={option.id} orientation="horizontal" className="border-border/60 border-b py-2 last:border-b-0">
					<RadioGroupItem value={option.id} id={`${focusPrefix}-${option.id}`} data-focus-id={`${focusPrefix}-${option.id}`} />
					<FieldContent>
						<FieldLabel htmlFor={`${focusPrefix}-${option.id}`}>{option.label}</FieldLabel>
						{option.description ? <FieldDescription>{option.description}</FieldDescription> : null}
					</FieldContent>
				</Field>
			))}
		</RadioGroup>
	);
}

function ProfilesPanel({ panel, local, send }: SetupPanelProps & { readonly panel: PanelOf<'profiles'> }) {
	const filter = useDeferredValue(local.filters[`profiles:${panel.heading}`] ?? '');
	const profiles = useMemo(() => panel.profiles.filter(profile => matches(profile.label, filter)), [panel.profiles, filter]);
	const filterId = `profiles:${panel.heading}`;
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<FilterInput
				id={filterId}
				label={panel.filterLabel}
				value={local.filters[filterId] ?? ''}
				itemCount={panel.profiles.length}
				onChange={value => local.setFilter(filterId, value)}
			/>
			{profiles.length === 0 ? <Note>{panel.noMatchText}</Note> : (
				<OptionList options={profiles} name="migration-source-profile" label={panel.groupLabel} send={send} focusPrefix="profile" />
			)}
			{panel.details ? (
				<Disclosure
					disclosure={panel.details}
					scope="profiles"
					open={local.openDisclosures.has(`profiles:${panel.details.id}`)}
					onOpenChange={open => local.toggleDisclosure(`profiles:${panel.details!.id}`, open)}
				/>
			) : null}
		</PanelBody>
	);
}

function TargetPanel({ panel, local, send }: SetupPanelProps & { readonly panel: PanelOf<'target'> }) {
	const draft = local.newTargetName || panel.newTarget.value;
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<OptionList options={panel.targets} name="migration-target" label={panel.groupLabel} send={send} focusPrefix="target" />
			<Field orientation="responsive" className="max-w-md">
				<FieldContent>
					<FieldLabel htmlFor="target-new-name">{panel.newTarget.label}</FieldLabel>
					<Input
						id="target-new-name"
						data-focus-id="target-new-name"
						placeholder={panel.newTarget.placeholder}
						value={draft}
						onChange={event => local.setNewTargetName(event.target.value)}
					/>
				</FieldContent>
				<Button
					type="button"
					variant="outline"
					size="sm"
					data-focus-id="target-new-use"
					disabled={!draft.trim()}
					onClick={() => send({ type: 'selectTarget', target: { kind: 'proposed', name: draft.trim() } })}
				>
					{panel.newTarget.actionLabel}
				</Button>
			</Field>
			{panel.newTarget.selectedText ? <Note className="text-foreground">{panel.newTarget.selectedText}</Note> : null}
		</PanelBody>
	);
}

function ConflictRowView({ row, send }: {
	readonly row: EditorMigrationSetupConflictRow;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
}) {
	const checked = row.choices?.find(choice => choice.checked)?.id;
	return (
		<div role="group" aria-label={row.name} className="border-border/60 flex flex-col gap-1.5 border-b py-2.5 last:border-b-0">
			<span className="font-mono text-xs break-all">{row.name}</span>
			<span aria-hidden className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-xs">
				<code className="bg-muted rounded-sm px-1 py-0.5">{row.currentValue}</code>
				<ArrowRightIcon className="size-3" />
				<code className="bg-muted text-foreground rounded-sm px-1 py-0.5">{row.importedValue}</code>
			</span>
			<span className="hucode-sr-only">{row.valuesDescription}</span>
			{row.choices ? (
				<RadioGroup
					name={`decision-${row.id}`}
					value={checked ?? ''}
					className="flex-row gap-4"
					onValueChange={id => {
						const choice = row.choices!.find(candidate => candidate.id === id);
						if (choice) {
							send(choice.intent);
						}
					}}
				>
					{row.choices.map(choice => (
						<Field key={choice.id} orientation="horizontal" className="w-auto">
							<RadioGroupItem value={choice.id} id={choice.id} data-focus-id={choice.id} aria-label={choice.description} />
							<FieldLabel htmlFor={choice.id} className="text-xs font-normal">{choice.label}</FieldLabel>
						</Field>
					))}
				</RadioGroup>
			) : (
				<span className="text-muted-foreground text-xs">{row.chosenText}</span>
			)}
		</div>
	);
}

function ReviewCategoryPanel({ panel, local, scrollRef, send }: SetupPanelProps & { readonly panel: PanelOf<'reviewCategory'> }) {
	const filterId = `conflicts:${panel.id}`;
	const filter = useDeferredValue(local.filters[filterId] ?? '');
	const visible = useMemo(
		() => panel.conflicts.filter(conflict => matches(conflict.searchText, filter)),
		[panel.conflicts, filter],
	);
	const shown = visible.slice(0, CONFLICT_ROW_LIMIT);
	const overflow = visible.length > CONFLICT_ROW_LIMIT && panel.conflictOverflowTemplate
		? panel.conflictOverflowTemplate.replace('{0}', String(CONFLICT_ROW_LIMIT)).replace('{1}', String(visible.length))
		: undefined;

	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			{panel.include ? (
				<Field orientation="horizontal" className="w-auto">
					<Checkbox
						id={`category-${panel.include.category}`}
						data-focus-id={`category-${panel.include.category}`}
						checked={panel.include.checked}
						onCheckedChange={value => send({ type: 'toggleCategory', category: panel.include!.category, selected: value === true })}
					/>
					<FieldLabel htmlFor={`category-${panel.include.category}`}>{panel.include.label}</FieldLabel>
				</Field>
			) : null}
			<Note>{panel.ownership}</Note>
			{panel.excludedText ? <Note>{panel.excludedText}</Note> : null}

			{panel.differencesHeading ? <SubHeading>{panel.differencesHeading}</SubHeading> : null}
			{panel.bulkActions?.length ? (
				<div className="flex flex-wrap gap-2">
					{panel.bulkActions.map(action => <ActionButton key={action.id} action={action} onRun={run => send(run.intent)} />)}
				</div>
			) : null}
			{panel.conflictFilterLabel ? (
				<FilterInput
					id={filterId}
					label={panel.conflictFilterLabel}
					value={local.filters[filterId] ?? ''}
					itemCount={panel.conflicts.length}
					onChange={value => local.setFilter(filterId, value)}
				/>
			) : null}
			{shown.length ? (
				<VirtualCollection items={shown} itemKey={row => row.id} estimateSize={92} scrollRef={scrollRef} label={panel.differencesHeading}>
					{row => <ConflictRowView row={row} send={send} />}
				</VirtualCollection>
			) : null}
			{overflow ? <Note>{overflow}</Note> : null}

			{panel.notesHeading ? <SubHeading>{panel.notesHeading}</SubHeading> : null}
			{panel.warnings.length ? (
				<GroupList groups={panel.warnings} scope={`review:${panel.id}`} openDisclosures={local.openDisclosures} onToggleDisclosure={local.toggleDisclosure} />
			) : null}
			{panel.additions ? (
				<Disclosure
					disclosure={panel.additions}
					scope={`review:${panel.id}`}
					open={local.openDisclosures.has(`review:${panel.id}:${panel.additions.id}`)}
					onOpenChange={open => local.toggleDisclosure(`review:${panel.id}:${panel.additions!.id}`, open)}
				/>
			) : null}
			{panel.exclusionNote ? <Note>{panel.exclusionNote}</Note> : null}
			{panel.emptyText ? <Note>{panel.emptyText}</Note> : null}
		</PanelBody>
	);
}

function GroupsPanel({ panel, local }: SetupPanelProps & { readonly panel: PanelOf<'groups'> }) {
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			{panel.emptyText ? <Note>{panel.emptyText}</Note> : null}
			<GroupList groups={panel.groups} scope={`groups:${panel.id}`} openDisclosures={local.openDisclosures} onToggleDisclosure={local.toggleDisclosure} />
		</PanelBody>
	);
}

function ApplyOverviewPanel({ panel }: SetupPanelProps & { readonly panel: PanelOf<'applyOverview'> }) {
	const percent = panel.progress.max > 0 ? Math.min(100, (panel.progress.now / panel.progress.max) * 100) : 0;
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<div className="flex max-w-lg flex-col gap-2">
				<Progress
					value={percent}
					aria-label={panel.progress.text}
					aria-valuemin={panel.progress.min}
					aria-valuemax={panel.progress.max}
					aria-valuenow={panel.progress.now}
					aria-valuetext={panel.progress.text}
				/>
				<Note>{panel.progress.text}</Note>
			</div>
			{panel.rows.length ? (
				<ul className="flex flex-col">
					{panel.rows.map(row => (
						<li key={row.id} className="border-border/60 flex items-baseline justify-between gap-3 border-b py-2 text-sm last:border-b-0">
							<span className="font-medium">{row.label}</span>
							<span className="text-muted-foreground text-xs">{row.state}</span>
						</li>
					))}
				</ul>
			) : null}
			{panel.currentItem ? <Note className="text-foreground">{panel.currentItem}</Note> : null}
			<Note>{panel.note}</Note>
		</PanelBody>
	);
}

function ApplyCategoryPanel({ panel }: SetupPanelProps & { readonly panel: PanelOf<'applyCategory'> }) {
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<ProblemList problems={panel.problems} overflowText={panel.problemOverflowText} />
			{panel.recordedNote ? <Note>{panel.recordedNote}</Note> : null}
		</PanelBody>
	);
}

function ResultsOverviewPanel({ panel, local }: SetupPanelProps & { readonly panel: PanelOf<'resultsOverview'> }) {
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<p className="text-foreground text-lg font-semibold">{panel.outcome}</p>
			<Lead>{panel.lead}</Lead>
			{panel.placementsHeading ? <SubHeading>{panel.placementsHeading}</SubHeading> : null}
			{panel.placements.length ? (
				<GroupList groups={panel.placements} scope="results:overview" openDisclosures={local.openDisclosures} onToggleDisclosure={local.toggleDisclosure} />
			) : null}
			{panel.preserved ? (
				<Disclosure
					disclosure={panel.preserved}
					scope="results:overview"
					open={local.openDisclosures.has(`results:overview:${panel.preserved.id}`)}
					onOpenChange={open => local.toggleDisclosure(`results:overview:${panel.preserved!.id}`, open)}
				/>
			) : null}
			{panel.rollbackOutcome ? (
				<>
					<SubHeading>{panel.rollbackOutcome.heading}</SubHeading>
					<ul className="flex flex-col">
						{panel.rollbackOutcome.rows.map(row => (
							<li key={row} className="border-border/60 border-b py-2 text-sm last:border-b-0">{row}</li>
						))}
					</ul>
					<Note>{panel.rollbackOutcome.note}</Note>
				</>
			) : null}
		</PanelBody>
	);
}

function ResultsCategoryPanel({ panel, local }: SetupPanelProps & { readonly panel: PanelOf<'resultsCategory'> }) {
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			{panel.problemsHeading ? <SubHeading>{panel.problemsHeading}</SubHeading> : null}
			<ProblemList problems={panel.problems} overflowText={panel.problemOverflowText} />
			{panel.completed ? (
				<Disclosure
					disclosure={panel.completed}
					scope={`results:${panel.id}`}
					open={local.openDisclosures.has(`results:${panel.id}:${panel.completed.id}`)}
					onOpenChange={open => local.toggleDisclosure(`results:${panel.id}:${panel.completed!.id}`, open)}
				/>
			) : null}
			{panel.emptyText ? <Note>{panel.emptyText}</Note> : null}
		</PanelBody>
	);
}

function RestorePanel({ panel, local, send, busy }: SetupPanelProps & { readonly panel: PanelOf<'restore'> }) {
	const selected = [...local.rollbackSelection];
	const inspection = panel.inspection;
	const rollbackAction: EditorMigrationSetupAction | undefined = inspection
		? {
			id: inspection.forced ? 'results-rollback-force' : 'results-rollback',
			label: inspection.actionLabel,
			kind: 'danger',
			disabled: busy || selected.length === 0,
			intent: { type: 'rollback', categories: selected, forceCategories: inspection.forced ? inspection.driftedCategories : [] },
		}
		: undefined;
	return (
		<PanelBody>
			<PanelHeading>{panel.heading}</PanelHeading>
			{panel.lead ? <Lead>{panel.lead}</Lead> : null}
			{panel.placeholder ? <Note>{panel.placeholder}</Note> : null}
			{panel.selection ? (
				<>
					<FieldSet>
						<FieldLegend variant="label">{panel.selection.legend}</FieldLegend>
						<FieldGroup className="gap-0">
							{panel.selection.options.map(option => (
								<Field key={option.category} orientation="horizontal" className="w-auto py-1.5">
									<Checkbox
										id={`rollback-category-${option.category}`}
										data-focus-id={`rollback-category-${option.category}`}
										checked={local.rollbackSelection.has(option.category)}
										onCheckedChange={value => {
											local.toggleRollbackCategory(option.category, value === true);
											send({ type: 'clearRollbackInspection' });
										}}
									/>
									<FieldLabel htmlFor={`rollback-category-${option.category}`}>{option.label}</FieldLabel>
								</Field>
							))}
						</FieldGroup>
					</FieldSet>
					<div className="flex flex-wrap gap-2">
						<ActionButton
							action={{
								id: 'results-rollback-inspect',
								label: panel.selection.inspectLabel,
								kind: 'default',
								disabled: busy || selected.length === 0,
								intent: { type: 'inspectRollback', categories: selected },
							}}
							onRun={action => send(action.intent)}
						/>
					</div>
				</>
			) : null}
			{inspection ? (
				<div className="border-border bg-card flex flex-col gap-2 rounded-md border p-3">
					{inspection.heading ? <FieldTitle>{inspection.heading}</FieldTitle> : null}
					<p className="text-sm">{inspection.description}</p>
					{rollbackAction ? (
						<div className="flex">
							<ActionButton action={rollbackAction} onRun={action => send(action.intent)} />
						</div>
					) : null}
				</div>
			) : null}
		</PanelBody>
	);
}
