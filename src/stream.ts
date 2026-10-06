import vscode from 'vscode';

import { convertToChatRequest } from './convert';
import { log } from './log';
import { isDoneEvent, SseParser } from './sse';
import type { Group } from './sources';
import type {
	ChatStreamChunk,
	ChatUsage,
} from './types';

/**
 * Run one chat completion over a canonical group's candidate chain: prepare
 * the upstream request per candidate, stream the SSE response and forward
 * content, thinking and tool calls to Copilot. Retryable failures rotate an
 * AtomCode host (per-candidate sub-attempts) and then fail over to the next
 * source carrying the same model; a total budget caps the attempts.
 */

const BUDGET = 6;
const TRIES_PER_CANDIDATE = 2;
const COPILOT_USAGE_DATA_PART_MIME = 'usage';
const ERROR_BODY_SNIPPET = 500;

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface RunChatCompletionOptions {
	group: Group;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
}

export async function runChatCompletion({
	group,
	messages,
	options,
	progress,
	token,
}: RunChatCompletionOptions): Promise<void> {
	let lastMessage = 'no candidate answered';
	let used = 0;

	for (const { source, meta } of group.candidates) {
		for (let sub = 0; sub < TRIES_PER_CANDIDATE; sub += 1) {
			if (used >= BUDGET) {
				break;
			}
			used += 1;

			let prepared;
			try {
				const body = convertToChatRequest(meta.id, messages, options, meta);
				prepared = await source.prepare(meta.id, body, sub);
			} catch (err) {
				lastMessage = (err as Error).message;
				log.warn(source.name, `prepare failed for ${meta.id}: ${lastMessage}`);
				break; // auth/catalog problems will not heal within this request — next candidate
			}

			const controller = new AbortController();
			const cancelListener = token.onCancellationRequested(() => controller.abort());
			if (token.isCancellationRequested) {
				cancelListener.dispose();
				return;
			}

			try {
				const res = await fetch(prepared.url, {
					method: 'POST',
					headers: prepared.headers,
					body: prepared.body,
					signal: controller.signal,
				});
				if (!res.ok) {
					const message = await consumeErrorBody(res);
					source.onUpstreamFailure?.(res.status);
					log.warn(source.name, `upstream ${res.status} via ${prepared.via} for ${meta.id}: ${message.slice(0, 160)}`);
					lastMessage = message;
					if (source.isRetryable(res.status) && sub + 1 < TRIES_PER_CANDIDATE && used < BUDGET) {
						continue; // same source, next sub-attempt (AtomCode host rotation)
					}
					break; // next candidate
				}
				if (!res.body) {
					lastMessage = `upstream (${prepared.via}) response has no body`;
					break;
				}
				await streamResponse(res.body, prepared.stripGateTools === true, progress, token);
				return;
			} catch (err) {
				if (token.isCancellationRequested) {
					return;
				}
				lastMessage = (err as Error).message;
				log.warn(source.name, `attempt ${used}/${BUDGET} via ${prepared.via} failed: ${lastMessage}`);
				if (used >= BUDGET) {
					break;
				}
				// fall through to the next sub-attempt / candidate
			} finally {
				cancelListener.dispose();
			}
		}
		if (used >= BUDGET) {
			break;
		}
	}

	throw new Error(`all upstreams failed for '${group.key}': ${lastMessage}`);
}

async function streamResponse(
	upstream: ReadableStream<Uint8Array>,
	stripGateTools: boolean,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const parser = new SseParser();
	const decoder = new TextDecoder();
	const pendingToolCalls = new Map<number, PendingToolCall>();
	let finishSeen = false;

	const flushToolCalls = () => {
		for (const call of [...pendingToolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot)) {
			let input: unknown = {};
			try {
				input = JSON.parse(call.arguments || '{}');
			} catch {
				input = {};
			}
			progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input as Record<string, unknown>));
		}
		pendingToolCalls.clear();
	};

	for await (const raw of upstream) {
		if (token.isCancellationRequested) {
			return;
		}
		for (const event of parser.push(decoder.decode(raw, { stream: true }))) {
			if (isDoneEvent(event.data)) {
				flushToolCalls();
				return;
			}
			let chunk: ChatStreamChunk;
			try {
				chunk = JSON.parse(event.data) as ChatStreamChunk;
			} catch {
				continue;
			}
			for (const choice of chunk.choices ?? []) {
				const delta = choice.delta ?? {};
				if (typeof delta.content === 'string' && delta.content.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(delta.content));
				}
				const thinking = delta.reasoning_content ?? delta.reasoning;
				if (typeof thinking === 'string' && thinking.length > 0) {
					emitThinking(thinking, progress);
				}
				if (Array.isArray(delta.tool_calls)) {
					for (const call of delta.tool_calls) {
						if (stripGateTools && (call.function?.name === 'bash' || call.function?.name === 'read')) {
							continue;
						}
						const index = call.index ?? 0;
						const slot = pendingToolCalls.get(index) ?? { id: '', name: '', arguments: '' };
						if (call.id) {
							slot.id = call.id;
						}
						if (call.function?.name) {
							// Providers that repeat the whole name each delta must not concatenate.
							const incoming = call.function.name;
							slot.name = slot.name && !incoming.startsWith(slot.name) ? slot.name + incoming : incoming;
						}
						if (call.function?.arguments) {
							slot.arguments += call.function.arguments;
						}
						pendingToolCalls.set(index, slot);
					}
				}
				if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
					finishSeen = true;
					flushToolCalls();
				}
			}
			if (chunk.usage) {
				reportUsage(chunk.usage, progress);
			}
		}
	}
	// Stream ended without [DONE]/finish_reason — flush anything accumulated.
	if (!finishSeen) {
		flushToolCalls();
	}
}

function emitThinking(text: string, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
	if (typeof vscode.LanguageModelThinkingPart !== 'function') {
		return;
	}
	try {
		progress.report(
			new vscode.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart,
		);
	} catch {
		// Runtime without the proposed API — drop thinking output silently.
	}
}

function reportUsage(usage: ChatUsage, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
	const data = {
		prompt_tokens: usage.prompt_tokens ?? 0,
		completion_tokens: usage.completion_tokens ?? 0,
		total_tokens: usage.total_tokens ?? 0,
		prompt_tokens_details: {
			cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0,
		},
	};
	if (typeof vscode.LanguageModelDataPart !== 'function') {
		return;
	}
	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(data)),
				COPILOT_USAGE_DATA_PART_MIME,
			) as unknown as vscode.LanguageModelResponsePart,
		);
	} catch (err) {
		log.warn('stream', `failed to report usage data: ${(err as Error).message}`);
	}
}

/** Text of an upstream error response, truncated, error.message picked out. */
function consumeErrorBody(res: Response): Promise<string> {
	return res
		.text()
		.catch(() => '')
		.then((text) => {
			try {
				const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; detail?: { message?: unknown } };
				const message = parsed.error?.message ?? parsed.message ?? parsed.detail?.message;
				if (typeof message === 'string' && message) {
					return `${res.status}: ${message}`;
				}
			} catch {
				// not JSON — fall through to the raw snippet
			}
			return `${res.status}: ${text.slice(0, ERROR_BODY_SNIPPET)}`;
		});
}
