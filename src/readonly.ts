import { Plugin, MarkdownView, Notice, TFile } from 'obsidian';

export class ReadonlyManager {
	private plugin: Plugin;
	private statusBarItem: HTMLElement;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.statusBarItem = this.plugin.addStatusBarItem();
		this.statusBarItem.addClass('dw-readonly-status');
	}

	onload(): void {
		// Command: toggle readonly
		this.plugin.addCommand({
			id: 'toggle-readonly',
			name: 'Toggle read-only mode',
			callback: () => this.toggleReadonly(),
		});

		// Ribbon icon
		this.plugin.addRibbonIcon('lock', 'Toggle read-only mode', () => this.toggleReadonly());

		// layout-change: enforce preview mode on all readonly leaves
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => this.enforceReadonlyLeaves()),
		);

		// active-leaf-change: update status bar for current leaf
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.updateStatusBar()),
		);

		// Initial apply
		this.plugin.app.workspace.onLayoutReady(() => {
			this.enforceReadonlyLeaves();
			this.updateStatusBar();
		});
	}

	/**
	 * Iterate all markdown leaves and force preview mode for those with readonly:true.
	 */
	private enforceReadonlyLeaves(): void {
		const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');

		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;

			const readonly = this.getReadonly(view.file);
			if (readonly !== true) continue;

			const viewState = leaf.getViewState();
			if (viewState.state?.mode === 'preview') continue;

			leaf.setViewState({
				type: 'markdown',
				state: { ...viewState.state, mode: 'preview' },
			});
		}
	}

	/**
	 * Update status bar to reflect current active leaf's readonly state.
	 */
	private updateStatusBar(): void {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);

		if (!view?.file) {
			this.statusBarItem.setText('');
			return;
		}

		const readonly = this.getReadonly(view.file);
		if (readonly === null) {
			this.statusBarItem.setText('');
			return;
		}

		if (readonly) {
			this.statusBarItem.setText('\u{1F512} Read-only (click to edit)');
		} else {
			this.statusBarItem.setText('\u270F\uFE0F Editable (click to lock)');
		}
		this.statusBarItem.style.cursor = 'pointer';
	}

	/**
	 * Read the `readonly` field from file's front matter cache.
	 * Returns null if the field is not present.
	 */
	private getReadonly(file: TFile | null): boolean | null {
		if (!file) return null;

		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter && 'readonly' in cache.frontmatter) {
			return cache.frontmatter.readonly === true;
		}
		return null;
	}

	/**
	 * Toggle the current note's readonly flag and immediately apply the mode change.
	 */
	private async toggleReadonly(): Promise<void> {
		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!leaf) {
			new Notice('No active note');
			return;
		}

		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) {
			new Notice('No active note');
			return;
		}

		const cache = this.plugin.app.metadataCache.getFileCache(view.file);
		if (!cache?.frontmatter || !('readonly' in cache.frontmatter)) {
			new Notice('This note does not have a readonly frontmatter field');
			return;
		}

		const current = cache.frontmatter.readonly === true;
		const newValue = !current;

		// Update front matter in file
		const content = await this.plugin.app.vault.read(view.file);
		const newContent = content.replace(
			/^readonly:\s*(true|false)/m,
			`readonly: ${newValue}`,
		);
		await this.plugin.app.vault.modify(view.file, newContent);

		// Immediately apply mode change
		const viewState = leaf.getViewState();
		leaf.setViewState({
			type: 'markdown',
			state: {
				...viewState.state,
				mode: newValue ? 'preview' : 'source',
			},
		});

		this.updateStatusBar();
		new Notice(newValue ? 'Switched to read-only' : 'Switched to editable');
	}
}
