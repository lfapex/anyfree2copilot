import vscode from 'vscode';

import { runChatCompletion } from './stream';
import { log } from './log';
import { getSettings, type Settings } from './settings';
import { Catalog, statusLines, type Group } from './sources';

/**
 * Free-models chat provider — implements vscode.LanguageModelChatProvider so
 * the free lanes behind OpenCode Zen, Cline and AtomCode appear directly in
 * the Copilot Chat model picker. The same model sold under different ids
 * across sources is advertised once, as a canonical group whose candidates
 * fail over across the sources carrying it.
 */

type PickerInfo = vscode.LanguageModelChatInformation & {
	isBYOK?: boolean;
	isUserSelectable?: boolean;
	statusIcon?: vscode.ThemeIcon;
};

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_OUTPUT = 32_768;

function toChatInfo(group: Group): PickerInfo {
	const sourceNames = [...new Set(group.candidates.map((c) => c.source.name))].join(' + ');
	return {
		id: group.key,
		name: group.meta.name ?? group.key,
		family: group.meta.source,
		version: '1.0.0',
		detail: `free · via ${sourceNames}`,
		tooltip: `${group.key} — free lanes: ${group.candidates.map((c) => `${c.source.name}/${c.meta.id}`).join(', ')}`,
		maxInputTokens: group.meta.contextWindow ?? DEFAULT_CONTEXT,
		maxOutputTokens: group.meta.maxOutput ?? DEFAULT_MAX_OUTPUT,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: group.meta.supportsTools !== false,
			imageInput: group.meta.imageInput === true,
		},
	};
}

export class FreeModelsChatProvider implements vscode.LanguageModelChatProvider {
	private readonly catalog: Catalog;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private refreshing = false;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.catalog = new Catalog(this.readSettings());
		context.subscriptions.push(this.onDidChangeLanguageModelChatInformationEmitter);

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('opencodecline')) {
					const settings = this.readSettings();
					this.catalog.reconfigure(settings);
					log.debugLog('provider', 'settings changed — catalog reconfigured');
					this.refreshModelPicker();
					void this.ensureFreshSoon();
				}
			}),
		);
	}

	private readSettings(): Settings {
		const settings = getSettings();
		log.setDebug(settings.debug);
		return settings;
	}

	/** Kick a background catalog refresh (single-flight) and fire on change. */
	private async ensureFreshSoon(): Promise<void> {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		try {
			const changed = await this.catalog.ensureFresh();
			if (changed) {
				log.info('provider', `catalog changed — ${this.catalog.current().length} models advertised`);
				this.refreshModelPicker();
			}
		} catch (err) {
			log.warn('provider', `catalog refresh failed: ${(err as Error).message}`);
		} finally {
			this.refreshing = false;
		}
	}

	/** Force Copilot Chat to re-query model information. */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	/** Command: refresh every source's catalog from scratch. */
	async refreshModels(): Promise<void> {
		for (const source of this.catalog.sources) {
			source.clearCache();
		}
		await this.ensureFreshSoon();
		void vscode.window.showInformationMessage(
			`Free Models: catalog refreshed — ${this.catalog.current().length} models available`,
		);
	}

	/** Command: per-source readiness overview. */
	showStatus(): void {
		const lines = statusLines(this.catalog);
		const items = lines.map((line) => ({
			label: line.split(':')[0],
			description: line.split(':').slice(1).join(':').trim(),
		}));
		items.unshift({ label: `${this.catalog.current().length} models`, description: 'advertised to Copilot Chat' });
		void vscode.window.showQuickPick(items, { placeHolder: 'Free Models source status' });
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		// Advertise the cached/static catalog immediately; live-refresh in the
		// background so the picker populates without blocking on the network.
		void this.ensureFreshSoon();
		return this.catalog.current().map(toChatInfo) as unknown as vscode.LanguageModelChatInformation[];
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const group = this.catalog.resolve(modelInfo.id);
		if (!group) {
			throw new Error(
				`model '${modelInfo.id}' is not exposed by any enabled source — run "Free Models: Refresh Model Catalog"`,
			);
		}
		log.debugLog('provider', `chat request for ${group.key} via ${group.candidates.map((c) => c.source.name).join('+')}`);
		return runChatCompletion({
			group,
			messages,
			options,
			progress,
			token,
		});
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text);
	}
}

function estimateTokenCount(text: string | vscode.LanguageModelChatRequestMessage): number {
	let chars = 0;
	if (typeof text === 'string') {
		chars = text.length;
	} else {
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				chars += part.value.length;
			} else if (typeof vscode.LanguageModelToolCallPart === 'function' && part instanceof vscode.LanguageModelToolCallPart) {
				chars += part.name.length + JSON.stringify(part.input ?? {}).length;
			}
		}
	}
	return Math.max(1, Math.ceil(chars / 4));
}
