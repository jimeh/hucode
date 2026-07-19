/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IListVirtualDelegate } from
	'../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from
	'../../../../base/browser/ui/list/listWidget.js';
import { ITreeNode, ITreeRenderer } from
	'../../../../base/browser/ui/tree/tree.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	ConfigurationTarget,
	IConfigurationChangeEvent,
	IConfigurationService,
} from '../../../configuration/common/configuration.js';
import { TestConfigurationService } from
	'../../../configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../contextkey/common/contextkey.js';
import { IContextViewService } from '../../../contextview/browser/contextView.js';
import { TestInstantiationService } from
	'../../../instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../keybinding/common/keybinding.js';
import {
	MockKeybindingService,
	MockScopableContextKeyService,
} from '../../../keybinding/test/common/mockKeybindingService.js';
import {
	IListService,
	ListService,
	WorkbenchObjectTree,
} from '../../browser/listService.js';

const treeIndentSetting = 'workbench.tree.indent';

class TestDelegate implements IListVirtualDelegate<number> {
	getHeight(): number { return 20; }
	getTemplateId(): string { return 'test'; }
}

class TestRenderer implements ITreeRenderer<number, void, HTMLElement> {
	readonly templateId = 'test';

	renderTemplate(container: HTMLElement): HTMLElement { return container; }
	renderElement(
		element: ITreeNode<number, void>,
		index: number,
		templateData: HTMLElement
	): void { }
	disposeTemplate(templateData: HTMLElement): void { }
}

class TestAccessibilityProvider implements IListAccessibilityProvider<number> {
	getAriaLabel(element: number): string { return `${element}`; }
	getWidgetAriaLabel(): string { return 'Test tree'; }
}

suite('Hucode WorkbenchObjectTree', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let configurationService: TestConfigurationService;
	let instantiationService: TestInstantiationService;

	setup(() => {
		configurationService = new TestConfigurationService({
			[treeIndentSetting]: 7,
		});
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(
			IConfigurationService,
			configurationService
		);
		instantiationService.stub(
			IContextKeyService,
			store.add(new MockScopableContextKeyService())
		);
		instantiationService.stub(
			IContextViewService,
			new class extends mock<IContextViewService>() { }
		);
		instantiationService.stub(
			IKeybindingService,
			new MockKeybindingService()
		);
		instantiationService.stub(IListService, store.add(new ListService()));
	});

	function createTree(indent?: number): WorkbenchObjectTree<number, void> {
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));

		return store.add(instantiationService.createInstance(
			WorkbenchObjectTree<number, void>,
			'test',
			container,
			new TestDelegate(),
			[new TestRenderer()],
			{
				accessibilityProvider: new TestAccessibilityProvider(),
				indent,
			}
		));
	}

	test('explicit indent overrides global configuration changes', async () => {
		const explicitTree = createTree(12);
		const configuredTree = createTree();

		assert.deepStrictEqual(
			[explicitTree.options.indent, configuredTree.options.indent],
			[12, 7]
		);

		explicitTree.updateOptions({ indent: 16 });
		await configurationService.setUserConfiguration(treeIndentSetting, 20);
		configurationService.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: key => key === treeIndentSetting,
			affectedKeys: new Set([treeIndentSetting]),
			change: { keys: [treeIndentSetting], overrides: [] },
			source: ConfigurationTarget.USER,
		} satisfies IConfigurationChangeEvent);

		assert.deepStrictEqual(
			[explicitTree.options.indent, configuredTree.options.indent],
			[16, 20]
		);
	});
});
