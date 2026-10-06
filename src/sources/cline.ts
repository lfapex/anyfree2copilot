import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log';
import type { ClineSettings } from '../settings';
import type {
	ChatCompletionRequest,
	ModelMeta,
	PreparedRequest,
	Source,
	SourceStatus,
} from '../types';

/**
 * Cline source (api.cline.bot, the Cline desktop account's free lane).
 *
 * Credentials live in the Cline desktop app's `providers.json`
 * (WorkOS OAuth, token rotated roughly daily while the app runs). The
 * extension re-reads the file per request (mtime-cached) and, when allowed,
 * mints fresh access tokens via the backend refresh endpoint — the backend
 * does not rotate the refresh token (live-verified 2026-10-04), so the
 * desktop app's session is never kicked.
 *
 * Every request carries the Cline client's full identity header set: the
 * free fleet (`cline-free/*`, `stealth/*`) is gated on these headers —
 * plain Bearer alone gets 403 ("only available via Cline product surfaces").
 *
 * Free catalog, two disjoint families:
 *   1. Cline's promo free fleet — `GET /ai/cline/recommended-models` `free`
 *      bucket (`clinePass` bucket needs a subscription; opt-in);
 *   2. OpenRouter-routed ids with a `:free` suffix of `GET /models`.
 * Fallback chain: live ∪ → memory cache → verified static roster.
 */

interface ClineAuth {
	accessToken: string;
	refreshToken?: string;
	accountId: string;
	expiresAt?: number;
}

interface BucketRow {
	id?: string;
	name?: string;
}

/** Verified free roster (free bucket ∪ /models `:free`, 2026-10-04). */
export const STATIC_FREE_MODELS: ModelMeta[] = [
	{ id: 'cline-free/deepseek-v4.1-flash', source: 'cline', name: 'DeepSeek V4.1 Flash (Cline)', supportsTools: true },
	{ id: 'stealth/space-bunny-alpha', source: 'cline', name: 'Space Bunny Alpha (Cline)', supportsTools: true },
	{ id: 'cline-free/mimo-v2.6-flash', source: 'cline', name: 'MiMo V2.6 Flash (Cline)', supportsTools: true },
	{ id: 'cline-free/muse-spark-1.3-contributor', source: 'cline', name: 'Muse Spark 1.3 Contributor (Cline)', supportsTools: true },
	{ id: 'apodex/apodex-1.1-mini:free', source: 'cline', supportsTools: true },
	{ id: 'inclusionai/ling-3.0-flash-sante:free', source: 'cline', supportsTools: true },
	{ id: 'qwen/qwen3.8-27b:free', source: 'cline', supportsTools: true },
	{ id: 'dots-studio/dots-3-note-preview:free', source: 'cline', supportsTools: true },
	{ id: 'liquid/lfm-2.5-2.6b:free', source: 'cline', supportsTools: true },
	{ id: 'nvidia/nemotron-3.5-lightning:free', source: 'cline', supportsTools: true },
	{ id: 'thinkingmachines/inkling-small:free', source: 'cline', supportsTools: true },
	{ id: 'poolside/laguna-s-2.1:free', source: 'cline', supportsTools: true },
	{ id: 'thinkingmachines/inkling:free', source: 'cline', supportsTools: true },
	{ id: 'poolside/laguna-xs-2.1:free', source: 'cline', supportsTools: true },
	{ id: 'cohere/north-mini-code:free', source: 'cline', supportsTools: true },
	{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', source: 'cline', supportsTools: true },
	{ id: 'google/gemma-4-26b-a4b-it:free', source: 'cline', supportsTools: true },
	{ id: 'google/gemma-4-31b-it:free', source: 'cline', supportsTools: true },
	{ id: 'nvidia/nemotron-3-super-120b-a12b:free', source: 'cline', supportsTools: true },
];

export function parseClineProvidersJson(raw: string): ClineAuth | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const cline = (parsed as { providers?: Record<string, unknown> }).providers?.cline as
		| { settings?: { auth?: Record<string, unknown> } }
		| undefined;
	const auth = cline?.settings?.auth;
	if (typeof auth !== 'object' || auth === null) {
		return undefined;
	}
	const accessToken = auth.accessToken;
	const accountId =
		auth.accountId ??
		((auth.metadata as { userInfo?: { clineUserId?: unknown } } | undefined)?.userInfo?.clineUserId);
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		return undefined;
	}
	if (typeof accountId !== 'string' || accountId.length === 0) {
		return undefined;
	}
	const refreshToken = typeof auth.refreshToken === 'string' && auth.refreshToken ? auth.refreshToken : undefined;
	const expiresAt = typeof auth.expiresAt === 'number' && Number.isFinite(auth.expiresAt) ? auth.expiresAt : undefined;
	return { accessToken, accountId, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

/** The identity header set the Cline desktop client itself sends. */
export function clineIdentityHeaders(accountId: string, clientType: string, clientVersion: string): Record<string, string> {
	return {
		clineUserId: accountId,
		'HTTP-Referer': 'https://cline.bot',
		'X-Title': 'Cline',
		'X-IS-MULTIROOT': 'false',
		'X-CLIENT-TYPE': clientType,
		'X-CLIENT-VERSION': clientVersion,
		'X-PLATFORM': clientType,
		'X-PLATFORM-VERSION': clientVersion,
		'User-Agent': `Cline/${clientVersion}`,
	};
}

/** Session ids: stable per conversation (model, system, first user turn). */
export function deriveClineSession(body: ChatCompletionRequest): string {
	const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
	const firstUser = messages.find((m) => m.role === 'user');
	const h = createHash('sha256');
	for (const part of [
		typeof body.model === 'string' ? body.model : undefined,
		typeof body.system === 'string' ? body.system : undefined,
		firstUser ? JSON.stringify(firstUser.content ?? null) : undefined,
	]) {
		h.update(part ?? '\u0000');
		h.update('\u0001');
	}
	return h.digest('hex').slice(0, 32);
}

export class ClineSource implements Source {
	readonly name = 'cline' as const;
	readonly #cfg: ClineSettings;
	#authCache: { mtimeMs: number; auth: ClineAuth | undefined; path: string } | undefined;
	/** Minted token, bound to the providers.json mtime it was minted against:
	 *  the desktop app rewrites that file when it re-authenticates, and any
	 *  token minted before that moment is permanently dead (chat 401s while
	 *  /models still answers), so the mtime match is the invalidation signal. */
	#liveToken: { accessToken: string; expiresAt?: number; mintedAgainstMtime: number } | undefined;
	#modelsCache: { at: number; models: ModelMeta[] } | undefined;
	#lastError = '';

	constructor(cfg: ClineSettings) {
		this.#cfg = cfg;
	}

	isEnabled(): boolean {
		return this.#cfg.enabled;
	}

	#authPath(): string {
		const home = this.#cfg.home && this.#cfg.home.trim() !== '' ? this.#cfg.home.trim() : join(homedir(), '.cline');
		return join(home, 'data', 'settings', 'providers.json');
	}

	#readAuth(): ClineAuth | undefined {
		const path = this.#authPath();
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			this.#lastError = `providers.json not found at ${path} — log in from the Cline desktop app`;
			return undefined;
		}
		if (this.#authCache && this.#authCache.path === path && this.#authCache.mtimeMs === mtimeMs) {
			return this.#authCache.auth;
		}
		let auth: ClineAuth | undefined;
		try {
			auth = parseClineProvidersJson(readFileSync(path, 'utf8'));
			if (!auth) {
				this.#lastError = 'providers.json has no Cline account session (accessToken/accountId)';
			}
		} catch (err) {
			this.#lastError = `providers.json unreadable: ${(err as Error).message}`;
		}
		this.#authCache = { mtimeMs, auth, path };
		return auth;
	}

	async #ensureToken(): Promise<ClineAuth | undefined> {
		const auth = this.#readAuth();
		if (!auth) {
			return undefined;
		}
		const now = Date.now();
		const mtime = this.#authCache?.mtimeMs ?? 0;
		if (this.#liveToken && this.#liveToken.mintedAgainstMtime === mtime) {
			if (this.#liveToken.expiresAt === undefined || now < this.#liveToken.expiresAt - 60_000) {
				return { ...auth, accessToken: this.#liveToken.accessToken, expiresAt: this.#liveToken.expiresAt };
			}
			this.#liveToken = undefined;
		}
		const fileFresh = auth.expiresAt === undefined || now < auth.expiresAt - 60_000;
		if (fileFresh) {
			return auth;
		}
		if (!this.#cfg.allowRefresh || !auth.refreshToken) {
			return auth;
		}
		try {
			const res = await fetch(`${this.#base()}/auth/refresh`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json', ...clineIdentityHeaders(auth.accountId, this.#clientType(), this.#clientVersion()) },
				body: JSON.stringify({ refreshToken: auth.refreshToken, grantType: 'refresh_token' }),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) {
				this.#lastError = `token refresh -> ${res.status}`;
				return auth;
			}
			const body = (await res.json()) as Record<string, unknown>;
			const inner = (typeof body.data === 'object' && body.data !== null ? body.data : body) as Record<string, unknown>;
			const accessToken = typeof inner.accessToken === 'string' ? inner.accessToken : undefined;
			if (!accessToken) {
				this.#lastError = 'token refresh returned no accessToken';
				return auth;
			}
			let expiresAt: number | undefined;
			const raw = inner.expiresAt;
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				expiresAt = raw < 1e12 ? raw * 1000 : raw;
			} else if (typeof raw === 'string' && raw) {
				const parsed = Date.parse(raw);
				if (Number.isFinite(parsed)) {
					expiresAt = parsed;
				}
			}
			log.info(this.name, 'minted a fresh access token via the Cline refresh endpoint');
			this.#liveToken = { accessToken, ...(expiresAt ? { expiresAt } : {}), mintedAgainstMtime: this.#authCache?.mtimeMs ?? 0 };
			return { ...auth, accessToken, ...(expiresAt ? { expiresAt } : {}) };
		} catch (err) {
			this.#lastError = `token refresh transport: ${(err as Error).message}`;
			return auth;
		}
	}

	#clientType(): string {
		return this.#cfg.clientType && this.#cfg.clientType.trim() !== '' ? this.#cfg.clientType.trim() : 'cline-sdk';
	}

	#clientVersion(): string {
		return this.#cfg.clientVersion && this.#cfg.clientVersion.trim() !== '' ? this.#cfg.clientVersion.trim() : '4.1.22';
	}

	#base(): string {
		return this.#cfg.baseUrl.replace(/\/+$/, '');
	}

	async #authedHeaders(): Promise<Record<string, string> | undefined> {
		const auth = await this.#ensureToken();
		if (!auth) {
			return undefined;
		}
		return {
			authorization: `Bearer ${auth.accessToken}`,
			...clineIdentityHeaders(auth.accountId, this.#clientType(), this.#clientVersion()),
		};
	}

	async models(): Promise<ModelMeta[]> {
		const ttlMs = 300_000;
		if (this.#modelsCache && Date.now() - this.#modelsCache.at < ttlMs) {
			return this.#modelsCache.models;
		}
		try {
			const headers = await this.#authedHeaders();
			if (!headers) {
				throw new Error(this.#lastError || 'not logged in');
			}
			const [fleet, orFree] = await Promise.all([
				this.#fetchFleet(headers),
				this.#fetchOpenRouterFree(headers).catch(() => [] as ModelMeta[]),
			]);
			const byId = new Map<string, ModelMeta>();
			for (const meta of [...fleet, ...orFree]) {
				if (!byId.has(meta.id)) {
					byId.set(meta.id, meta);
				}
			}
			if (byId.size === 0) {
				throw new Error('both free sources came back empty');
			}
			const models = [...byId.values()];
			log.info(this.name, `live catalog: ${models.length} free models (fleet ${fleet.length}, openrouter ${orFree.length})`);
			this.#modelsCache = { at: Date.now(), models };
			this.#lastError = '';
			return models;
		} catch (err) {
			this.#lastError = `live catalog unavailable: ${(err as Error).message}`;
			log.warn(this.name, `${this.#lastError}; falling back to the static verified roster`);
			const models = STATIC_FREE_MODELS;
			this.#modelsCache = { at: Date.now() - ttlMs + 60_000, models }; // retry in a minute
			return models;
		}
	}

	/** Cline's own promo free fleet (`free` bucket; `clinePass` is opt-in). */
	async #fetchFleet(headers: Record<string, string>): Promise<ModelMeta[]> {
		const res = await fetch(`${this.#base()}/ai/cline/recommended-models`, {
			method: 'GET',
			headers: { accept: 'application/json', ...headers },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			throw new Error(`GET recommended-models -> ${res.status}`);
		}
		const body = (await res.json()) as { free?: BucketRow[]; clinePass?: BucketRow[] };
		const out: ModelMeta[] = [];
		for (const row of body.free ?? []) {
			if (typeof row.id === 'string' && row.id) {
				out.push({ id: row.id, source: 'cline', ...(row.name ? { name: `${row.name} (Cline)` } : {}), supportsTools: true });
			}
		}
		if (this.#cfg.includeClinePass) {
			for (const row of body.clinePass ?? []) {
				if (typeof row.id === 'string' && row.id) {
					out.push({ id: row.id, source: 'cline', ...(row.name ? { name: `${row.name} (Cline Pass)` } : {}), supportsTools: true });
				}
			}
		}
		return out;
	}

	/** OpenRouter-routed free models: `:free` rows of GET /models. */
	async #fetchOpenRouterFree(headers: Record<string, string>): Promise<ModelMeta[]> {
		const res = await fetch(`${this.#base()}/models`, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			throw new Error(`GET /models -> ${res.status}`);
		}
		const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
		const rows = body.data ?? body.models ?? [];
		const ids: string[] = [];
		for (const row of rows) {
			if (typeof row.id === 'string' && row.id.endsWith(':free')) {
				ids.push(row.id);
			}
		}
		return ids.map((id) => ({ id, source: 'cline', supportsTools: true }) as ModelMeta);
	}

	async prepare(model: string, body: ChatCompletionRequest): Promise<PreparedRequest> {
		const headers = await this.#authedHeaders();
		if (!headers) {
			throw new Error(`cline: ${this.#lastError || 'not logged in — open the Cline desktop app and sign in'}`);
		}
		const payloadBody: ChatCompletionRequest = { ...body, model };
		if (payloadBody.stream === true && payloadBody.stream_options === undefined) {
			payloadBody.stream_options = { include_usage: true };
		}
		const session = deriveClineSession(payloadBody);
		const payload = JSON.stringify(payloadBody);
		return {
			url: `${this.#base()}/chat/completions`,
			headers: {
				'content-type': 'application/json',
				...headers,
				'x-client-request-id': randomUUID(),
				'x-session-affinity': session,
			},
			body: payload,
			forceStream: false,
			via: `${this.name}@api.cline.bot`,
		};
	}

	isRetryable(status: number | undefined): boolean {
		return status === undefined || status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599);
	}

	/** 401/403: the minted token is dead — drop it so the next attempt re-reads
	 *  the file (the desktop app may have re-authenticated meanwhile). */
	onUpstreamFailure(status: number | undefined): void {
		if (status === 401 || status === 403) {
			this.#liveToken = undefined;
		}
	}

	status(): SourceStatus {
		const auth = this.#readAuth();
		return {
			name: this.name,
			enabled: this.#cfg.enabled,
			ready: auth !== undefined,
			models: this.#modelsCache?.models.length ?? 0,
			...(this.#lastError ? { lastError: this.#lastError } : {}),
		};
	}

	clearCache(): void {
		this.#authCache = undefined;
		this.#liveToken = undefined;
		this.#modelsCache = undefined;
		this.#lastError = '';
	}
}
