import type { ChatMessage, ModelMeta } from './types';

/**
 * Client-side history budgeting. Copilot Chat replays the whole conversation
 * to `provideLanguageModelChatResponse`; when the user switches to a model
 * with a smaller context window (e.g. 1M -> 256K) mid-conversation, the
 * accumulated history can exceed the new model's input budget and the upstream
 * rejects the request with a context-length error. We drop the oldest turns
 * here so the replayed history fits. Pure module — no vscode dependency, so it
 * is testable under plain Node.
 */

/** Mirrors provider.ts DEFAULT_CONTEXT / DEFAULT_MAX_OUTPUT. */
const HISTORY_CONTEXT_FALLBACK = 131_072;
const HISTORY_MAX_OUTPUT_FALLBACK = 32_768;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKEN_ESTIMATE = 1_100;

// Han, kana, Hangul and fullwidth punctuation tokenize at roughly one token
// per character. Counting them at the 4-chars-per-token English heuristic
// underestimates CJK-heavy histories 3-4x and lets oversized requests through
// to a 400; one token per CJK char errs high, which is the safe direction.
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF01-\uFF9F\u{20000}-\u{2FA1F}]/gu;

/** Rough token count for a text run: 1 per CJK char, 4 chars ≈ 1 token otherwise. */
function estimateTextTokens(text: string): number {
	const cjk = text.match(CJK_CHAR)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * Rough token count for one outgoing message. Overestimating is the safe
 * direction: truncate a little early rather than hit a 400 late. Text counts
 * CJK at ~1 token per char and everything else at 4 chars ≈ 1 token (same
 * heuristic as the provider's provideTokenCount for ASCII); tool calls and
 * images get generous placeholders.
 */
export function estimateMessageTokens(message: ChatMessage): number {
	let tokens = MESSAGE_OVERHEAD_TOKENS;
	if (typeof message.content === 'string') {
		tokens += estimateTextTokens(message.content);
	} else {
		for (const part of message.content) {
			if (part.type === 'text') {
				tokens += estimateTextTokens(part.text);
			} else if (part.type === 'image_url') {
				tokens += IMAGE_PART_TOKEN_ESTIMATE;
			}
		}
	}
	if (message.tool_call_id) {
		tokens += Math.ceil(message.tool_call_id.length / 4);
	}
	for (const call of message.tool_calls ?? []) {
		tokens += Math.ceil((call.id.length + call.function.name.length + call.function.arguments.length) / 4) + 4;
	}
	return Math.max(1, tokens);
}

/** Input budget: advertised context window minus the advertised max output, so
 *  generation headroom is never eaten by history. */
export function historyBudget(meta: ModelMeta): number {
	const context = meta.contextWindow ?? HISTORY_CONTEXT_FALLBACK;
	const maxOutput = meta.maxOutput ?? HISTORY_MAX_OUTPUT_FALLBACK;
	return Math.max(1, context - maxOutput);
}

/**
 * Drop the oldest turns until the remainder fits the model's input budget.
 * The first message is never dropped (when it can lead a history safely):
 * Copilot Chat inlines its instructions and the user's original task into the
 * earliest replayed message — there is no system role — so losing it makes the
 * model forget what it was asked to do in the first place. The last message
 * (the current prompt) is likewise always kept. Middle turns are cut only at
 * `user` message boundaries so an assistant tool-call group and its following
 * `tool` results are never split. Returns the input array unchanged when it
 * already fits or when there is nothing safe to drop.
 */
export function truncateHistory(out: ChatMessage[], meta: ModelMeta): ChatMessage[] {
	if (out.length <= 1) {
		return out;
	}

	const budget = historyBudget(meta);
	const perMessage = out.map(estimateMessageTokens);
	let total = 0;
	for (const n of perMessage) {
		total += n;
	}
	if (total <= budget) {
		return out;
	}

	// Only a `user` lead is protected: an assistant lead carrying tool_calls
	// would be orphaned from its tool results by any middle cut.
	const protectFirst = out[0].role === 'user';
	const firstCost = protectFirst ? perMessage[0] : 0;

	// Prefix sums so each candidate cut point is O(1).
	const prefix = new Array<number>(perMessage.length + 1);
	prefix[0] = 0;
	for (let i = 0; i < perMessage.length; i += 1) {
		prefix[i + 1] = prefix[i] + perMessage[i];
	}

	// Scan user boundaries left→right and keep the tail at the first cut that
	// fits — that drops the fewest turns. The last message is never a cut
	// point; the first message is re-attached ahead of the tail.
	for (let i = 1; i < out.length - 1; i += 1) {
		if (out[i].role === 'user' && firstCost + (total - prefix[i]) <= budget) {
			const tail = out.slice(i);
			return protectFirst ? [out[0], ...tail] : tail;
		}
	}

	// No boundary cut fits. Keep first + current prompt when that pair fits
	// (the task description survives), otherwise the current prompt alone.
	const last = out[out.length - 1];
	if (protectFirst && firstCost + perMessage[perMessage.length - 1] <= budget) {
		return [out[0], last];
	}
	return [last];
}
