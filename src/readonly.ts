import { Plugin, MarkdownView, Notice, TFile } from 'obsidian';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export class ReadonlyManager {
	private plugin: Plugin;
	private statusBarItem: HTMLElement;
	private isReadonly: boolean = false;

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

		// Active leaf change
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.onActiveLeafChange()),
		);

		// Metadata change (e.g. frontmatter updated externally)
		this.plugin.registerEvent(
			this.plugin.app.metadataCache.on('changed', (file) => {
				const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file === file) {
					this.applyReadonlyState(view);
				}
			}),
		);

		// Layout ready — apply to initial pane
		this.plugin.app.workspace.onLayoutReady(() => this.onActiveLeafChange());
	}

	private onActiveLeafChange(): void {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			this.applyReadonlyState(view);
		} else {
			this.statusBarItem.setText('');
		}
	}

	private applyReadonlyState(view: MarkdownView): void {
		const readonly = this.getReadonlyFromFrontmatter(view);

		if (readonly === null) {
			this.statusBarItem.setText('');
			return;
		}

		this.isReadonly = readonly;
		const cm = (view.editor as any)?.cm as EditorView | undefined;

		if (cm) {
			cm.dispatch({
				effects: StateEffect.appendConfig.of(EditorView.editable.of(!readonly)),
			});
		}

		if (readonly) {
			this.statusBarItem.setText('🔒 ' + this.getStatusText(true));
			this.statusBarItem.style.cursor = 'pointer';
		} else {
			this.statusBarItem.setText('✏️ ' + this.getStatusText(false));
			this.statusBarItem.style.cursor = 'pointer';
		}
	}

	private getReadonlyFromFrontmatter(view: MarkdownView): boolean | null {
		const file = view.file;
		if (!file) return null;

		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter && 'readonly' in cache.frontmatter) {
			return cache.frontmatter.readonly === true;
		}
		return null;
	}

	private async toggleReadonly(): Promise<void> {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) {
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

		const content = await this.plugin.app.vault.read(view.file);
		const newContent = content.replace(
			/^readonly:\s*(true|false)/m,
			`readonly: ${newValue}`,
		);
		await this.plugin.app.vault.modify(view.file, newContent);

		// State applied via metadataCache 'changed' event → applyReadonlyState
		new Notice(newValue ? 'Switched to read-only' : 'Switched to editable');
	}

	private getStatusText(readonly: boolean): string {
		return readonly ? 'Read-only (click to edit)' : 'Editable (click to lock)';
	}
}
