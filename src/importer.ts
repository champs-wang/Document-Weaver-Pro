import { App, Notice, TFile, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as nodePath from 'path';
import { DocWeaverSettings, ImportResult, ConverterOutput, SUPPORTED_EXTENSIONS, SupportedExtension } from './types';
import { convertDocx } from './converters/docxConverter';
import { convertPlain } from './converters/plainConverter';
import { convertPdf } from './converters/pdfConverter';
import { convertPptx } from './converters/pptxConverter';
import { convertXlsx } from './converters/xlsxConverter';
import { convertHwp, convertHwpx } from './converters/hwpConverter';
import { tFormat, formatStats } from './i18n';

export class Importer {
	app: App;
	settings: DocWeaverSettings;

	constructor(app: App, settings: DocWeaverSettings) {
		this.app = app;
		this.settings = settings;
	}

	pickAndImport(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(',');
		input.style.display = 'none';
		document.body.appendChild(input);

		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			document.body.removeChild(input);
			if (files.length === 0) return;
			await this.importFiles(files);
		};

		input.click();
	}

	async importFiles(files: File[]): Promise<ImportResult[]> {
		const filtered = files.filter(f => !this.shouldExclude(f.name));
		const excluded = files.length - filtered.length;

		if (filtered.length === 0) {
			if (excluded > 0) {
				new Notice(tFormat('NOTICE_ALL_FILTERED', { n: excluded }));
			}
			return [];
		}

		// Extract the full filesystem path from File objects (Electron non-standard extension).
		// Without this, relativeDir derivation in importSingleFile falls through
		// when (file as any).path is unavailable in the Obsidian sandbox.
		const getSourcePath = (f: File): string => {
			return (f as any).path || (f as any).webkitRelativePath || '';
		};

		if (filtered.length === 1) {
			const f = filtered[0];
			const result = await this.importSingleFile(f, { sourceAbsPath: getSourcePath(f) });
			this.notifySingle(result);
			return [result];
		}

		const results: ImportResult[] = [];
		for (const file of filtered) {
			results.push(await this.importSingleFile(file, {
				skipOpen: true,
				sourceAbsPath: getSourcePath(file),
			}));
		}
		this.notifyBulk(results);
		return results;
	}

	async importSingleFile(file: File, opts?: { skipOpen?: boolean; sourceAbsPath?: string; relativeDir?: string }): Promise<ImportResult> {
		const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
		const sourceName = file.name;

		if (!SUPPORTED_EXTENSIONS.includes(ext as SupportedExtension)) {
			new Notice(tFormat('NOTICE_UNSUPPORTED', { ext }));
			return { success: false, sourcePath: sourceName, warnings: [], error: `Unsupported: ${ext}` };
		}

		try {
			const buffer = await file.arrayBuffer();
			const output = await this.convert(buffer, ext as SupportedExtension);
			const basename = file.name.replace(/\.[^.]+$/, '');

			const sourceAbsPath = opts?.sourceAbsPath ?? (file as any).path ?? '';

			// Compute relative dir: use explicit value; otherwise derive from sourceAbsPath
			let relativeDir = opts?.relativeDir ?? '';
			if (!relativeDir && sourceAbsPath) {
				const parentDir = nodePath.dirname(sourceAbsPath);
				const parsed = nodePath.parse(parentDir);
				// If parent is not a drive root, use its name as the subdirectory
				if (parsed.base && parsed.base !== parsed.root) {
					relativeDir = parsed.base;
				}
			}
			console.log(`[DocWeaver] importSingleFile: sourceName="${sourceName}" sourceAbsPath="${sourceAbsPath}" relativeDir="${relativeDir}"`);

			const destPath = await this.resolveDestPath(basename, relativeDir || undefined);

			if (destPath === null) {
				return { success: true, sourcePath: sourceName, warnings: output.warnings, skipped: true };
			}

			const frontmatter = this.buildFrontmatter(file.name, ext, sourceAbsPath, output.frontmatterExtra);
			// Resolve bare asset filenames to vault-relative paths (non-wikilink mode)
			const markdown = output.assets.length > 0
				? this.resolveAssetLinks(output.markdown, basename, relativeDir || undefined)
				: output.markdown;
			const content = frontmatter + markdown;

			await this.writeNote(destPath, content);

			if (output.assets.length > 0) {
				await this.saveAssets(basename, output.assets, relativeDir || undefined);
			}

			if (output.additionalFiles && output.additionalFiles.length > 0) {
				for (const extra of output.additionalFiles) {
					const extraPath = await this.resolveDestPath(extra.basename, relativeDir || undefined);
					if (extraPath !== null) {
						await this.writeNote(extraPath, extra.content);
					}
				}
			}

			if (this.settings.openAfterImport && !opts?.skipOpen) {
				const tfile = this.app.vault.getAbstractFileByPath(destPath);
				if (tfile instanceof TFile) {
					await this.app.workspace.getLeaf(false).openFile(tfile);
				}
			}

			return {
				success: true,
				sourcePath: sourceName,
				destPath,
				warnings: output.warnings,
				stats: output.stats,
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[DocWeaver] importSingleFile failed: "${sourceName}" — ${error}`, err);
			return { success: false, sourcePath: sourceName, warnings: [], error };
		}
	}

	private shouldExclude(filename: string): boolean {
		if (!this.settings.includeHiddenFiles) {
			if (filename.startsWith('.') || filename.startsWith('~$')) return true;
		}

		const patterns = this.settings.excludePatterns.trim();
		if (patterns) {
			const parts = patterns.split(',').map(p => p.trim()).filter(p => p.length > 0);
			for (const part of parts) {
				if (filename.includes(part)) return true;
			}
		}

		return false;
	}

	private async convert(buffer: ArrayBuffer, ext: SupportedExtension): Promise<ConverterOutput> {
		switch (ext) {
			case 'docx':
				return convertDocx(buffer, this.settings.useWikilinks);
			case 'pdf':
				return convertPdf(buffer, this.settings.useWikilinks);
			case 'pptx':
				return convertPptx(buffer, {
					outputMode: this.settings.pptxOutput,
					useWikilinks: this.settings.useWikilinks,
				});
			case 'hwp':
			case 'hwpx': {
				if (!this.settings.showHwpBeta) {
					throw new Error('Enable "Show HWP beta features" in settings to import HWP/HWPx files.');
				}
				return ext === 'hwp'
					? convertHwp(buffer, this.settings.useWikilinks)
					: convertHwpx(buffer, this.settings.useWikilinks);
			}
			case 'xlsx':
			case 'xls':
				return convertXlsx(buffer, { outputMode: 'single' });
			case 'txt':
			case 'csv':
				return convertPlain(buffer, ext);
			default:
				throw new Error(`Converter not yet implemented for .${ext} (coming in a future milestone)`);
		}
	}

	private async resolveDestPath(basename: string, subDir?: string): Promise<string | null> {
		const destFolder = normalizePath(this.settings.destinationFolder);
		const targetFolder = subDir ? normalizePath(`${destFolder}/${subDir}`) : destFolder;

		console.log(`[DocWeaver] resolveDestPath: basename="${basename}" subDir="${subDir ?? ''}" targetFolder="${targetFolder}"`);

		// Ensure the target folder (and all its parents) exists before checking collision
		await this.ensureFolders(targetFolder);

		const candidate = normalizePath(`${targetFolder}/${basename}.md`);
		const exists = await this.app.vault.adapter.exists(candidate);

		if (!exists) return candidate;

		switch (this.settings.filenameCollision) {
			case 'skip':
				return null;
			case 'overwrite':
				return candidate;
			case 'number': {
				for (let i = 1; i <= 999; i++) {
					const numbered = normalizePath(`${targetFolder}/${basename} ${i}.md`);
					if (!(await this.app.vault.adapter.exists(numbered))) return numbered;
				}
				return candidate; // fallback
			}
		}
	}

	private buildFrontmatter(
		filename: string,
		format: string,
		sourceAbsPath: string,
		extra?: Record<string, string | boolean | number>,
	): string {
		const now = this.localISOString();
		const fileUrl = sourceAbsPath
			? `file:///${sourceAbsPath.replace(/\\/g, '/')}`
			: filename;
		const lines = [
			'---',
			`source_file: "${fileUrl}"`,
			`source_format: "${format}"`,
			`imported_at: "${now}"`,
		];
		// Add note_path (wiki-link to source file) if source is inside the vault
		if (sourceAbsPath) {
			const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? '';
			if (vaultRoot) {
				const normalizedRoot = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '');
				const normalizedSource = sourceAbsPath.replace(/\\/g, '/');
				if (normalizedSource.startsWith(normalizedRoot + '/')) {
					const relativePath = normalizedSource.substring(normalizedRoot.length + 1);
					lines.push(`note_path: "[[${relativePath}]]"`);
				}
			}
		}
		if (extra) {
			for (const [k, v] of Object.entries(extra)) {
				lines.push(`${k}: ${JSON.stringify(v)}`);
			}
		}
		lines.push('---', '');
		return lines.join('\n') + '\n';
	}

	private localISOString(): string {
		const now = new Date();
		// Use China Standard Time (UTC+8)
		const chinaTime = new Date(now.getTime() + (8 * 60 - now.getTimezoneOffset()) * 60000);
		const Y = chinaTime.getFullYear();
		const M = String(chinaTime.getMonth() + 1).padStart(2, '0');
		const D = String(chinaTime.getDate()).padStart(2, '0');
		const h = String(chinaTime.getHours()).padStart(2, '0');
		const m = String(chinaTime.getMinutes()).padStart(2, '0');
		const s = String(chinaTime.getSeconds()).padStart(2, '0');
		return `${Y}-${M}-${D} ${h}:${m}:${s}`;
	}

	private resolveAssetLinks(markdown: string, noteName: string, subDir?: string): string {
		const assetBase = subDir
			? normalizePath(`${this.settings.destinationFolder}/${this.settings.assetSubfolder}/${subDir}/${noteName}`)
			: normalizePath(`${this.settings.destinationFolder}/${this.settings.assetSubfolder}/${noteName}`);

		if (this.settings.useWikilinks) {
			// Replace bare ![[filename.ext]] with path-qualified ![[assetBase/filename.ext]].
			// Without this, Obsidian searches the whole vault and resolves all same-named
			// assets (e.g. page-001.jpg from different PDFs) to the same file.
			return markdown.replace(
				/!\[\[([^\]/|#]+\.[a-zA-Z]{2,5})(|[^\]]*)?\]\]/g,
				(_, filename, alias) => `![[${assetBase}/${filename}${alias ?? ''}]]`,
			);
		}

		// Standard markdown: qualify bare filenames with the full asset path
		return markdown.replace(/!\[([^\]]*)\]\(([^/)(]+\.[a-zA-Z]{2,5})\)/g, (_, alt, filename) => {
			return `![${alt}](${assetBase}/${filename})`;
		});
	}

	/**
	 * Recursively ensure all parent directories exist.
	 * Walks the path from root down, creating each missing segment.
	 * Wraps createFolder in try-catch to tolerate concurrent creation by parallel imports.
	 */
	private async ensureFolders(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		const parts = normalized.split('/');
		let current = '';
		for (const part of parts) {
			if (!part) continue;
			current = current ? `${current}/${part}` : part;
			try {
				const exists = await this.app.vault.adapter.exists(current);
				if (!exists) {
					await this.app.vault.createFolder(current);
				}
			} catch (err) {
				// Ignore "folder already exists" from concurrent createFolder calls
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.toLowerCase().includes('already exists') &&
					!msg.toLowerCase().includes('folder already exists')) {
					throw err;
				}
			}
		}
	}

	private async writeNote(destPath: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(destPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(destPath, content);
		}
	}

	private async saveAssets(noteName: string, assets: { filename: string; data: ArrayBuffer; mimeType: string }[], subDir?: string): Promise<void> {
		const assetFolder = subDir
			? normalizePath(`${this.settings.destinationFolder}/${this.settings.assetSubfolder}/${subDir}/${noteName}`)
			: normalizePath(`${this.settings.destinationFolder}/${this.settings.assetSubfolder}/${noteName}`);
		await this.ensureFolders(assetFolder);

		for (const asset of assets) {
			const assetPath = normalizePath(`${assetFolder}/${asset.filename}`);
			await this.app.vault.adapter.writeBinary(assetPath, asset.data);
		}
	}

	private notifySingle(result: ImportResult): void {
		const name = result.sourcePath;
		if (result.skipped) {
			new Notice(tFormat('NOTICE_SKIP', { name }));
			return;
		}
		if (!result.success) {
			new Notice(tFormat('NOTICE_ERROR', { name, error: result.error ?? '' }));
			return;
		}
		const stats = result.stats ? formatStats(result.stats.headings, result.stats.images, result.stats.tables) : '';
		const dest = result.destPath ?? this.settings.destinationFolder;
		new Notice(tFormat('NOTICE_SUCCESS', { name, dest, stats }));

		for (const w of result.warnings) {
			if (w.isBeta) new Notice(tFormat('NOTICE_BETA_WARNING', { name }));
		}
	}

	private notifyBulk(results: ImportResult[]): void {
		const success = results.filter(r => r.success && !r.skipped).length;
		const warn = results.filter(r => r.warnings.length > 0).length;
		const dest = this.settings.destinationFolder;
		new Notice(tFormat('NOTICE_BULK_SUMMARY', { success, warn, dest }));

		const errors = results.filter(r => !r.success);
		if (errors.length > 0) {
			this.appendErrorLog(errors);
		}
	}

	private async appendErrorLog(errors: ImportResult[]): Promise<void> {
		const logPath = normalizePath(`${this.settings.destinationFolder}/_import_errors.md`);
		const lines = errors.map(e => `- \`${e.sourcePath}\`: ${e.error ?? 'unknown error'}`);
		const entry = `\n### ${new Date().toISOString()}\n${lines.join('\n')}\n`;

		const existing = this.app.vault.getAbstractFileByPath(logPath);
		if (existing instanceof TFile) {
			const prev = await this.app.vault.read(existing);
			await this.app.vault.modify(existing, prev + entry);
		} else {
			await this.ensureFolders(this.settings.destinationFolder);
			await this.app.vault.create(logPath, `# Import Errors\n${entry}`);
		}
	}

	/**
	 * Sync all imported files: scan watch folders for new files, then re-convert existing notes.
	 * Returns counts for: new imports, updated re-conversions, failures, and skipped.
	 */
	async syncAllImportedFiles(): Promise<{ new_: number; updated: number; failed: number; skipped: number }> {
		const stats = { new_: 0, updated: 0, failed: 0, skipped: 0 };
		const destFolder = normalizePath(this.settings.destinationFolder);

		// Build a set of OS-normalized source paths from existing imported notes.
		// We use this to determine which watch-folder files have already been imported.
		const existingSourcePaths = new Set<string>();
		const notesBySourcePath = new Map<string, TFile>(); // normalized sourcePath → note TFile

		const destExists = await this.app.vault.adapter.exists(destFolder);
		if (destExists) {
			const notes = this.app.vault.getFiles().filter(f =>
				f.path.startsWith(destFolder + '/') && f.path.endsWith('.md'),
			);
			for (const note of notes) {
				try {
					const content = await this.app.vault.read(note);
					const sourcePath = this.parseSourceFile(content);
					if (!sourcePath) continue;
					const fileUrlMatch = sourcePath.match(/^file:\/\/\/(.+)$/);
					const osPath = fileUrlMatch ? fileUrlMatch[1] : sourcePath;
					const normalized = nodePath.normalize(osPath);
					existingSourcePaths.add(normalized);
					notesBySourcePath.set(normalized, note);
				} catch {
					// unreadable note — skip
				}
			}
		}

		// ---- Phase 1: scan watch folders for NEW files ----
		const watchFolders = this.settings.watchFolders
			.map(f => f.trim())
			.filter(f => f.length > 0);

		for (const watchFolder of watchFolders) {
			const files = await this.scanWatchFolder(watchFolder, this.settings.watchSubfolders);
			for (const filePath of files) {
				const filename = nodePath.basename(filePath);
				if (this.shouldExclude(filename)) continue;

				const ext = filename.split('.').pop()?.toLowerCase() ?? '';
				if (!SUPPORTED_EXTENSIONS.includes(ext as SupportedExtension)) continue;

				const normalized = nodePath.normalize(filePath);
				if (existingSourcePaths.has(normalized)) continue;

				// New file — import it
				try {
					const fileDir = nodePath.dirname(filePath);
					let relativeDir = nodePath.relative(watchFolder, fileDir).replace(/\\/g, '/');
					if (relativeDir === '.' || relativeDir === '') relativeDir = '';

					const buffer = await fs.promises.readFile(filePath);
					const fileObj = new File([buffer], filename);

					const result = await this.importSingleFile(fileObj, {
						skipOpen: true,
						sourceAbsPath: filePath,
						relativeDir: relativeDir || undefined,
					});

					if (result.success && !result.skipped) {
						stats.new_++;
					} else if (result.skipped) {
						stats.skipped++;
					} else {
						stats.failed++;
					}
				} catch (err) {
					console.error(`[DocWeaver] sync: failed to import new file "${filePath}"`, err);
					stats.failed++;
				}
			}
		}

		// ---- Phase 2: re-convert EXISTING notes ----
		for (const [normalizedSource, noteFile] of notesBySourcePath) {
			try {
				// Verify source file still exists
				let stat: fs.Stats;
				try {
					stat = await fs.promises.stat(normalizedSource);
				} catch {
					stats.skipped++;
					continue;
				}
				if (!stat.isFile()) {
					stats.skipped++;
					continue;
				}

				const filename = nodePath.basename(normalizedSource);
				const ext = filename.split('.').pop()?.toLowerCase() ?? '';
				if (!SUPPORTED_EXTENSIONS.includes(ext as SupportedExtension)) {
					stats.skipped++;
					continue;
				}

				const buffer = await fs.promises.readFile(normalizedSource);
				const output = await this.convert(
					buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
					ext as SupportedExtension,
				);
				const basename = noteFile.basename;

				const frontmatter = this.buildFrontmatter(filename, ext, normalizedSource, output.frontmatterExtra);
				const markdown = output.assets.length > 0
					? this.resolveAssetLinks(output.markdown, basename)
					: output.markdown;
				const newContent = frontmatter + markdown;

				await this.app.vault.modify(noteFile, newContent);

				if (output.assets.length > 0) {
					await this.saveAssets(basename, output.assets);
				}

				stats.updated++;
			} catch (err) {
				console.error(`[DocWeaver] sync: failed to re-convert "${noteFile.path}"`, err);
				stats.failed++;
			}
		}

		return stats;
	}

	/**
	 * Recursively scan a directory for files, respecting the watchSubfolders setting.
	 */
	private async scanWatchFolder(folderPath: string, recursive: boolean): Promise<string[]> {
		const results: string[] = [];
		try {
			const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = nodePath.join(folderPath, entry.name);
				if (entry.isDirectory()) {
					if (recursive) {
						const sub = await this.scanWatchFolder(fullPath, recursive);
						results.push(...sub);
					}
					continue;
				}
				if (entry.isFile()) {
					results.push(fullPath);
				}
			}
		} catch {
			// folder missing or no permission — silently skip
		}
		return results;
	}

	private parseSourceFile(content: string): string | null {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) return null;

		const lines = fmMatch[1].split('\n');
		for (const line of lines) {
			const m = line.match(/^source_file:\s*"(.+)"$/);
			if (m) return m[1];
		}
		return null;
	}
}
