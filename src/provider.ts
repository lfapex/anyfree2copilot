import vscode from 'vscode';

import { runChatCompletion } from './stream';
import { log } from './log';
import { getSettings, type Settings } from './settings';
import { Catalog, statusLines } from './sources';
import type { ModelMeta } from './types';
import { pickerId } from './types';

/**
 * Free-models chat provider — implements vscode.LanguageModelChatProvider so
 * the free lanes behind OpenCode Zen, Cline and AtomCode appear directly in
 * the Copilot Chat model picker.
 */

type PickerInfo = vscode.LanguageModelChatInformation & {
	isBYOK?: boolean;
	isUserSelectable?: boolean;
	statusIcon?: vscode.ThemeIcon;
};

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_OUTPUT = 32_768;

function toChatInfo(meta: ModelMeta): PickerInfo {
	return {
		id: pickerId(meta),
		name: meta.name ?? meta.id,
		family: meta.source,
		version: '1.0.0',
		detail: `free · via ${meta.source}`,
		tooltip: `${pickerId(meta)} — free lane via ${meta.source}`,
		maxInputTokens: meta.contextWindow ?? DEFAULT_CONTEXT,
		maxOutputTokens: meta.maxOutput ?? DEFAULT_MAX_OUTPUT,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: meta.supportsTools !== false,
			imageInput: meta.imageInput === true,
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
		const resolved = this.catalog.resolve(modelInfo.id);
		if (!resolved) {
			throw new Error(
				`model '${modelInfo.id}' is not exposed by any enabled source — run "Free Models: Refresh Model Catalog"`,
			);
		}
		log.debugLog('provider', `chat request for ${modelInfo.id} via ${resolved.source.name}`);
		return runChatCompletion({
			source: resolved.source,
			meta: resolved.meta,
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
