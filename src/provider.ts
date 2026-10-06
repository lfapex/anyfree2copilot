import vscode from 'vscode';

import { runChatCompletion } from './stream';
import { log } from './log';
import type { Catalog, Group } from './sources';
import type { SourceName } from './types';

/**
 * Per-platform chat provider — implements vscode.LanguageModelChatProvider so
 * each platform's free models appear as their own section in the Copilot Chat
 * model picker (vendors: opencode / cline / atomcode). All sections share one
 * Catalog; each provider only advertises and serves its own platform.
 */

type PickerInfo = vscode.LanguageModelChatInformation & {
	isBYOK?: boolean;
	isUserSelectable?: boolean;
	statusIcon?: vscode.ThemeIcon;
};

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_OUTPUT = 32_768;

function toChatInfo(group: Group, promoIndex: number): PickerInfo {
	const baseName = group.meta.name ?? group.key;
	// The picker re-sorts each section's models by name, so the promo free
	// fleet gets numbered name prefixes ("1. …", "2. …") to stay pinned to the
	// top in the provider's recommendation order; digits sort before letters.
	const name = promoIndex > 0 ? `${promoIndex}. ${baseName}` : baseName;
	return {
		id: group.key,
		name,
		family: group.meta.source,
		version: '1.0.0',
		detail: `free · via ${group.meta.source}`,
		tooltip: `${group.key} — free lane: ${group.candidates.map((c) => c.meta.id).join(', ')}`,
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

/** Shared background refresh driver across the per-platform providers. */
export class CatalogRefresher {
	#refreshing = false;

	constructor(
		private readonly catalog: Catalog,
		private readonly onChanged: () => void,
	) {}

	async refresh(force = false): Promise<void> {
		if (this.#refreshing) {
			return;
		}
		this.#refreshing = true;
		try {
			if (force) {
				for (const source of this.catalog.sources) {
					source.clearCache();
				}
			}
			const changed = await this.catalog.ensureFresh();
			if (changed || force) {
				log.info('provider', `catalog refresh done — ${this.catalog.totalCount} models advertised`);
				this.onChanged();
			}
		} catch (err) {
			log.warn('provider', `catalog refresh failed: ${(err as Error).message}`);
		} finally {
			this.#refreshing = false;
		}
	}
}

export class PlatformChatProvider implements vscode.LanguageModelChatProvider {
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;

	constructor(
		private readonly catalog: Catalog,
		readonly sourceName: SourceName,
		onChanged: vscode.Event<void>,
		private readonly onRequestRefresh: () => void,
	) {
		this.onDidChangeLanguageModelChatInformation = onChanged;
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		// Advertise the cached/static catalog immediately; live-refresh in the
		// background so the picker populates without blocking on the network.
		this.onRequestRefresh();
		let promoIndex = 0;
		return this.catalog
			.currentFor(this.sourceName)
			.map((group) => toChatInfo(group, group.meta.promo === true ? (promoIndex += 1) : 0)) as unknown as vscode.LanguageModelChatInformation[];
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const group = this.catalog.resolveFor(this.sourceName, modelInfo.id);
		if (!group) {
			throw new Error(
				`model '${modelInfo.id}' is not available on '${this.sourceName}' — run "AnyFree: Refresh Model Catalog"`,
			);
		}
		log.debugLog(this.sourceName, `chat request for ${group.key}`);
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
