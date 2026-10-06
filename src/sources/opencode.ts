import { createHash, randomBytes } from 'node:crypto';

import { log } from '../log';
import type { OpenCodeSettings } from '../settings';
import type {
	ChatCompletionRequest,
	ModelMeta,
	PreparedRequest,
	Source,
	SourceStatus,
} from '../types';

/**
 * OpenCode Zen anonymous free lane.
 *
 * No account: `Authorization: Bearer public`, requests dressed up to look
 * exactly like the OpenCode CLI's (user agent + correlation headers), with
 * session ids in Zen's canonical shape. Since 2026-09-16 the free lane also
 * gates on body shape: the payload must stream and carry function tools
 * named "bash" and "read" (their definitions are not inspected). We append
 * minimal reserved versions of both when the client did not send them.
 *
 * Catalog: live `GET /v1/models` ∩ free-by-metadata (models.dev prices or a
 * `-free` name) → memory cache → verified static fallback. muse-spark-*
 * models are Responses-API-only upstream and are excluded from the
 * chat-completions lane.
 */

const FREE_LANE_GATE_TOOLS = ['bash', 'read'] as const;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ids that look free but do NOT work on the anonymous chat-completions lane
 * (probed 2026-10-06 with the exact lane request shape):
 *  - deepseek-v4-flash-free: HTTP 400 "Model is unavailable" — free only for
 *    authenticated Zen accounts, models.dev still marks it cost 0.
 *  - jev-1.13-free: HTTP 500 — rides the SystemOne endpoint, not chat
 *    completions (no models.dev entry either).
 * muse-spark-* (Responses-API-only) is filtered separately below.
 */
const UNUSABLE_IDS = new Set(['deepseek-v4-flash-free', 'jev-1.13-free']);

/** Verified against the anonymous lane with real chats (2026-10). */
const STATIC_FREE_MODELS: ModelMeta[] = [
	{ id: 'big-pickle', source: 'opencode', name: 'Big Pickle', reasoning: true, supportsTools: true },
	{ id: 'mimo-v2.5-free', source: 'opencode', name: 'MiMo V2.5 Free', reasoning: true, supportsTools: true },
	{ id: 'mimo-v2.6-flash-free', source: 'opencode', name: 'MiMo V2.6 Flash Free', contextWindow: 200_000, maxOutput: 32_000, reasoning: true, supportsTools: true, imageInput: true },
	{ id: 'ling-3.0-flash-fin-free', source: 'opencode', name: 'Ling 3.0 Flash Fin Free', contextWindow: 262_144, maxOutput: 32_768, reasoning: true, supportsTools: true },
	{ id: 'ling-3.1-flash-free', source: 'opencode', name: 'Ling 3.1 Flash Free', contextWindow: 262_144, maxOutput: 32_768, reasoning: true, supportsTools: true },
	{ id: 'fledge-alpha-free', source: 'opencode', name: 'Fledge Alpha Free', contextWindow: 1_000_000, reasoning: true, supportsTools: true },
	{ id: 'nemotron-3.5-lightning-free', source: 'opencode', name: 'Nemotron 3.5 Lightning Free', reasoning: true, supportsTools: true },
	{ id: 'nemotron-3-ultra-free', source: 'opencode', name: 'Nemotron 3 Ultra Free', reasoning: true, supportsTools: true },
];

interface ZenIds {
	session: string;
	request: string;
	project: string;
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** "ses_" + 12 hex + 14 base62 — the only session shape the free lane accepts. */
export function canonicalSessionId(seed: string): string {
	if (SESSION_PATTERN.test(seed)) {
		return seed;
	}
	const sum = createHash('sha256').update(`ses\x00${seed}`).digest();
	const timePart = sum.subarray(0, 6).toString('hex');
	let n = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`);
	const randomPart: string[] = [];
	for (let i = 0; i < 14; i += 1) {
		randomPart.unshift(BASE62[Number(n % 62n)]);
		n /= 62n;
	}
	return `ses_${timePart}${randomPart.join('')}`;
}

/** First user turn keeps a conversation stable across its growing history. */
export function conversationSeed(messages: Array<{ role?: unknown; content?: unknown }>): string {
	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		const encoded = JSON.stringify(message.content ?? null);
		if (encoded !== 'null' && encoded.length > 0) {
			return encoded;
		}
	}
	return randomBytes(16).toString('hex');
}

export function deriveZenIds(body: ChatCompletionRequest, projectSeed: string): ZenIds {
	const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
	return {
		session: canonicalSessionId(conversationSeed(messages)),
		request: `req_${randomBytes(16).toString('hex')}`,
		project: `prj_${createHash('sha256').update(`prj\x00${projectSeed}`).digest().subarray(0, 12).toString('hex')}`,
	};
}

export function zenUserAgent(): string {
	return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}

export function zenHeaders(ids: ZenIds, apiKey = 'public'): Record<string, string> {
	return {
		authorization: `Bearer ${apiKey}`,
		'user-agent': zenUserAgent(),
		'x-opencode-client': 'cli',
		'x-opencode-session': ids.session,
		'x-session-affinity': ids.session,
		'X-Session-Id': ids.session,
		'x-opencode-request': ids.request,
		'x-opencode-project': ids.project,
	};
}

function gateTool(name: (typeof FREE_LANE_GATE_TOOLS)[number]): unknown {
	return {
		type: 'function',
		function: {
			name,
			description: 'Reserved for the host runtime; do not call it.',
			parameters: { type: 'object', properties: {} },
		},
	};
}

/**
 * Rewrite the chat body so it passes the free-lane gate: force streaming,
 * append the reserved bash/read tools, and pin tool_choice=none when the
 * client sent no tools of its own.
 */
export function applyFreeLaneShape(body: ChatCompletionRequest): { body: ChatCompletionRequest; injected: boolean } {
	const tools = Array.isArray(body.tools) ? [...(body.tools as unknown[])] : [];
	const names = new Set(
		tools.map((tool) => {
			if (typeof tool !== 'object' || tool === null) {
				return undefined;
			}
			const fn = (tool as { function?: { name?: unknown } }).function;
			return typeof fn?.name === 'string' ? fn.name : undefined;
		}),
	);
	const missing = FREE_LANE_GATE_TOOLS.filter((name) => !names.has(name));
	const next: ChatCompletionRequest = { ...body, stream: true };
	if (missing.length > 0) {
		next.tools = [...tools, ...missing.map(gateTool)] as ChatCompletionRequest['tools'];
		if (tools.length === 0 && body.tool_choice === undefined) {
			next.tool_choice = 'none';
		}
	}
	if (next.stream_options === undefined && next.stream === true) {
		next.stream_options = { include_usage: true };
	}
	return { body: next, injected: missing.length > 0 };
}

interface ModelsDevEntry {
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	deprecated?: boolean;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
}

async function fetchModelsDev(): Promise<Record<string, ModelsDevEntry>> {
	const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
	if (!res.ok) {
		throw new Error(`models.dev -> ${res.status}`);
	}
	const api = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> }>;
	return api.opencode?.models ?? {};
}

/** Zen ids verified by real anonymous chats (metadata-independent free verdict). */
const STATIC_VERIFIED_IDS = new Set(STATIC_FREE_MODELS.map((m) => m.id));

/** Free verdict for the ANONYMOUS lane. Exported for the smoke tests. */
export function freeVerdict(id: string, entry: ModelsDevEntry | undefined): boolean {
	if (UNUSABLE_IDS.has(id) || entry?.deprecated) {
		return false;
	}
	if (STATIC_VERIFIED_IDS.has(id)) {
		return true;
	}
	if (id.toLowerCase().includes('free')) {
		return true;
	}
	const cost = entry?.cost;
	return cost !== undefined && cost.input === 0 && cost.output === 0;
}

function toMeta(id: string, entry: ModelsDevEntry | undefined): ModelMeta {
	return {
		id,
		source: 'opencode',
		...(entry?.name ? { name: `${entry.name} (OpenCode)` } : {}),
		...(entry?.limit?.context ? { contextWindow: entry.limit.context } : {}),
		...(entry?.limit?.output ? { maxOutput: entry.limit.output } : {}),
		supportsTools: entry?.tool_call ?? true,
		imageInput: entry?.modalities?.input?.includes('image') || undefined,
		reasoning: entry?.reasoning || undefined,
	};
}

export class OpenCodeSource implements Source {
	readonly name = 'opencode' as const;
	readonly #cfg: OpenCodeSettings;
	#projectSeed = 'opencodecline2copilot:default-project';
	#cache: { at: number; models: ModelMeta[] } | undefined;
	#devCache: { at: number; value: Record<string, ModelsDevEntry> } | undefined;
	#lastError = '';

	constructor(cfg: OpenCodeSettings) {
		this.#cfg = cfg;
	}

	isEnabled(): boolean {
		return this.#cfg.enabled;
	}

	/**
	 * Live list ∩ free verdict, models.dev metadata enrichment best-effort;
	 * memory cache for the refresh window; static roster last.
	 */
	async models(): Promise<ModelMeta[]> {
		const refreshMs = this.#cfg.refreshSeconds * 1000;
		if (this.#cache && Date.now() - this.#cache.at < refreshMs) {
			return this.#cache.models;
		}
		try {
			const [liveList, devModels] = await Promise.all([
				this.#fetchLiveList(),
				this.#loadModelsDev().catch(() => ({}) as Record<string, ModelsDevEntry>),
			]);
			const models: ModelMeta[] = [];
			for (const id of liveList) {
				if (id.startsWith('muse-spark-')) {
					continue; // Responses-API-only lane
				}
				const entry = devModels[id];
				if (!freeVerdict(id, entry)) {
					continue;
				}
				models.push(toMeta(id, entry));
			}
			log.debugLog(this.name, `excluded as unusable on the anonymous lane: ${liveList.filter((id) => UNUSABLE_IDS.has(id)).join(', ') || 'none'}`);
			if (models.length === 0) {
				throw new Error('live list empty after free filter');
			}
			log.info(this.name, `live catalog: ${models.length} free models`);
			this.#cache = { at: Date.now(), models };
			this.#lastError = '';
			return models;
		} catch (err) {
			this.#lastError = `live catalog unavailable: ${(err as Error).message}`;
			log.warn(this.name, `${this.#lastError}; falling back to the static verified roster`);
			const models = STATIC_FREE_MODELS;
			this.#cache = { at: Date.now() - refreshMs + 60_000, models }; // retry in a minute
			return models;
		}
	}

	/** models.dev metadata with a 7-day memory cache. */
	async #loadModelsDev(): Promise<Record<string, ModelsDevEntry>> {
		if (this.#devCache && Date.now() - this.#devCache.at < CACHE_TTL_MS) {
			return this.#devCache.value;
		}
		const value = await fetchModelsDev();
		this.#devCache = { at: Date.now(), value };
		return value;
	}

	async #fetchLiveList(): Promise<string[]> {
		const ids = deriveZenIds({ messages: [{ role: 'user', content: 'catalog' }] }, this.#projectSeed);
		const res = await fetch(`${this.#cfg.baseUrl}/v1/models`, {
			headers: { ...zenHeaders(ids) },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) {
			throw new Error(`GET /v1/models -> ${res.status}`);
		}
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const out: string[] = [];
		for (const row of body.data ?? []) {
			if (typeof row.id === 'string' && row.id) {
				out.push(row.id);
			}
		}
		log.debugLog(this.name, `live list: ${out.length} ids`);
		return out;
	}

	async prepare(model: string, body: ChatCompletionRequest): Promise<PreparedRequest> {
		const ids = deriveZenIds(body, this.#projectSeed);
		const shaped = applyFreeLaneShape(body);
		const payload = JSON.stringify({ ...shaped.body, model });
		return {
			url: `${this.#cfg.baseUrl}/v1/chat/completions`,
			headers: { 'content-type': 'application/json', ...zenHeaders(ids) },
			body: payload,
			forceStream: true,
			via: `${this.name}@zen-anonymous`,
			stripGateTools: shaped.injected,
		};
	}

	isRetryable(status: number | undefined): boolean {
		return status === undefined || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599);
	}

	status(): SourceStatus {
		return {
			name: this.name,
			enabled: this.#cfg.enabled,
			ready: true,
			models: this.#cache?.models.length ?? 0,
			...(this.#lastError ? { lastError: this.#lastError } : {}),
		};
	}

	clearCache(): void {
		this.#cache = undefined;
		this.#devCache = undefined;
		this.#lastError = '';
	}
}
