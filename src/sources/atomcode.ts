import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log';
import type { AtomCodeSettings } from '../settings';
import type {
	ChatCompletionRequest,
	ModelMeta,
	PreparedRequest,
	Source,
	SourceStatus,
} from '../types';

/**
 * AtomCode (AtomGit CodingPlan) source.
 *
 * Credentials live in the AtomCode CLI's `auth.toml` (OAuth access +
 * refresh token, 7-day access validity, user id). The CLI refreshes the
 * file while it runs; the extension re-reads it per request (mtime-cached)
 * and, when allowed, mints a fresh access token via the platform refresh
 * endpoint — the minted token stays in memory and `auth.toml` remains the
 * CLI's property.
 *
 * Requests to the AtomGit LLM gateways carry `atomcode-signing-v1`
 * signatures (live-verified 2026-10-05 against llm-api.atomgit.com and
 * api-ai.gitcode.com): HKDF-SHA256 over a salt bound to the user id, the
 * hour bucket and the token/version hashes; HMAC over the canonical
 * request string. Algorithm independently documented by the MIT-licensed
 * atomgit-opencode-bridge / Atom2Api projects.
 */

const PLATFORM_BASE = 'https://acs.atomgit.com';
const DEFAULT_MASTER_KEY_HEX = 'e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123';
/** Fallback roster when config.toml yields nothing (verified 2026-10-05). */
const STATIC_MODELS: ModelMeta[] = [
	{ id: 'qwen3.8-27b', source: 'atomcode', name: 'Qwen3.8-27B (AtomCode)', contextWindow: 262_144, supportsTools: true, imageInput: true, reasoning: true },
	{ id: 'glm5.3-flash', source: 'atomcode', name: 'GLM-5.3-Flash (AtomCode)', contextWindow: 512_000, supportsTools: true, imageInput: true, reasoning: true },
];

interface AtomAuth {
	accessToken: string;
	refreshToken?: string;
	userId: string;
	/** Epoch ms when the file's access token goes stale (best effort). */
	expiresAt?: number;
}

function homePath(home: string): string {
	return home && home.trim() !== '' ? home.trim() : join(homedir(), '.atomcode');
}

function readTomlString(toml: string, key: string): string | undefined {
	const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
	if (m?.[1] !== undefined) {
		return m[1];
	}
	// Unquoted TOML integers (expires_in / created_at).
	const n = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'));
	return n?.[1];
}

export function parseAuthToml(toml: string): AtomAuth | undefined {
	const accessToken = readTomlString(toml, 'access_token');
	const userId = readTomlString(toml, 'id');
	if (!accessToken || !userId) {
		return undefined;
	}
	const refreshToken = readTomlString(toml, 'refresh_token');
	const expiresIn = Number(readTomlString(toml, 'expires_in'));
	const createdAt = Number(readTomlString(toml, 'created_at'));
	const expiresAt = Number.isFinite(expiresIn) && Number.isFinite(createdAt) ? (createdAt + expiresIn) * 1000 : undefined;
	return { accessToken, userId, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

/** Dynamic model discovery: AtomGit models declared in the CLI's config.toml. */
export function parseAtomGitModels(toml: string): ModelMeta[] {
	const out: ModelMeta[] = [];
	const section = /\[models\."([^"]+)"\]([^\[]*)/g;
	let match: RegExpExecArray | null;
	while ((match = section.exec(toml)) !== null) {
		const profile = match[2] ?? '';
		const account = /account\s*=\s*"([^"]*)"/.exec(profile)?.[1];
		if (account !== 'AtomGit') {
			continue;
		}
		const model = /model\s*=\s*"([^"]*)"/.exec(profile)?.[1];
		const ctx = Number(/context_window\s*=\s*(\d+)/.exec(profile)?.[1]);
		if (!model) {
			continue;
		}
		out.push({
			id: model,
			source: 'atomcode',
			name: `${match[1]} (AtomCode)`,
			...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
			supportsTools: true,
			imageInput: /supports_vision\s*=\s*true/.test(profile) || undefined,
			reasoning: true,
		});
	}
	return out;
}

/**
 * `atomcode-signing-v1`. Live-verified 2026-10-05; kept pure so tests can
 * pin golden vectors.
 */
export function signAtomCodeRequest(options: {
	method: string;
	path: string;
	body: Buffer;
	accessToken: string;
	userId: string;
	clientVersion: string;
	timestampSeconds: number;
	nonce: Buffer;
	masterKeyHex?: string;
}): Record<string, string> {
	const masterKey = Buffer.from(options.masterKeyHex ?? DEFAULT_MASTER_KEY_HEX, 'hex');
	const tokenHash = createHash('sha256').update(options.accessToken, 'utf8').digest();
	const versionHash = createHash('sha256').update(options.clientVersion, 'utf8').digest();
	const hourBucket = Buffer.alloc(8);
	hourBucket.writeBigUInt64LE(BigInt(Math.floor(options.timestampSeconds / 3600)));
	const salt = Buffer.concat([Buffer.from(options.userId, 'utf8'), Buffer.from([1]), hourBucket, tokenHash, versionHash]);
	const prk = createHmac('sha256', salt).update(masterKey).digest();
	const signingKey = createHmac('sha256', prk).update('atomcode-signing-v1').update(Buffer.from([1])).digest();
	const bodyHash = createHash('sha256').update(options.body).digest('hex');
	const canonical = ['v1', options.method.toUpperCase(), options.path, String(options.timestampSeconds), options.nonce.toString('hex'), bodyHash].join('\n');
	const signature = createHmac('sha256', signingKey).update(canonical, 'utf8').digest('hex');
	return {
		'X-AtomCode-Sig': `v1:${signature}`,
		'X-AtomCode-Ts': String(options.timestampSeconds),
		'X-AtomCode-Nonce': options.nonce.toString('hex'),
		'X-AtomCode-Alg': '1',
		'X-AtomCode-Ver': options.clientVersion,
	};
}

/** Client version sent as `X-AtomCode-Ver` (and hashed into the signature salt). */
function detectClientVersion(): string {
	return '5.2.1';
}

export class AtomCodeSource implements Source {
	readonly name = 'atomcode' as const;
	readonly #cfg: AtomCodeSettings;
	#authCache: { mtimeMs: number; auth: AtomAuth | undefined; path: string } | undefined;
	#liveToken: { accessToken: string; expiresAt?: number } | undefined;
	#modelsCache: { at: number; models: ModelMeta[] } | undefined;
	#lastError = '';

	constructor(cfg: AtomCodeSettings) {
		this.#cfg = cfg;
	}

	isEnabled(): boolean {
		return this.#cfg.enabled;
	}

	#authPath(): string {
		return join(homePath(this.#cfg.home), 'auth.toml');
	}

	#readAuth(): AtomAuth | undefined {
		const path = this.#authPath();
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			this.#lastError = `auth.toml not found at ${path} — run \`atomcode login\``;
			return undefined;
		}
		if (this.#authCache && this.#authCache.path === path && this.#authCache.mtimeMs === mtimeMs) {
			return this.#authCache.auth;
		}
		let auth: AtomAuth | undefined;
		try {
			auth = parseAuthToml(readFileSync(path, 'utf8'));
			if (!auth) {
				this.#lastError = 'auth.toml has no access_token/user id';
			}
		} catch (err) {
			this.#lastError = `auth.toml unreadable: ${(err as Error).message}`;
		}
		this.#authCache = { mtimeMs, auth, path };
		return auth;
	}

	async #ensureToken(): Promise<AtomAuth | undefined> {
		const auth = this.#readAuth();
		if (!auth) {
			return undefined;
		}
		const now = Date.now();
		const fileFresh = auth.expiresAt === undefined || now < auth.expiresAt - 120_000;
		if (this.#liveToken && this.#liveToken.expiresAt !== undefined && now < this.#liveToken.expiresAt - 120_000) {
			return { ...auth, accessToken: this.#liveToken.accessToken, expiresAt: this.#liveToken.expiresAt };
		}
		if (this.#liveToken && fileFresh) {
			// The file was renewed by the CLI after we minted ours; the file token
			// is as good. Keep the live one only while the file is stale.
			return { ...auth, accessToken: auth.accessToken };
		}
		if (fileFresh) {
			return auth;
		}
		if (!this.#cfg.allowRefresh) {
			return auth;
		}
		const refreshed = await this.#refresh(auth);
		if (refreshed) {
			this.#liveToken = refreshed;
			return { ...auth, ...refreshed };
		}
		log.warn(this.name, 'refresh failed; trying the file token as-is');
		return auth;
	}

	async #refresh(auth: AtomAuth): Promise<{ accessToken: string; expiresAt?: number } | undefined> {
		if (!auth.refreshToken) {
			return undefined;
		}
		try {
			const res = await fetch(`${PLATFORM_BASE}/oauth/refresh`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ refresh_token: auth.refreshToken }),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) {
				this.#lastError = `oauth refresh -> ${res.status}`;
				return undefined;
			}
			const body = (await res.json()) as Record<string, unknown>;
			const inner = (typeof body.data === 'object' && body.data !== null ? body.data : body) as Record<string, unknown>;
			const accessToken = typeof inner.access_token === 'string' ? inner.access_token : typeof inner.accessToken === 'string' ? inner.accessToken : undefined;
			if (!accessToken) {
				this.#lastError = 'oauth refresh returned no access_token';
				return undefined;
			}
			const expiresIn = typeof inner.expires_in === 'number' ? inner.expires_in : undefined;
			log.info(this.name, 'minted a fresh access token via acs.atomgit.com/oauth/refresh');
			return { accessToken, ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}) };
		} catch (err) {
			this.#lastError = `oauth refresh transport: ${(err as Error).message}`;
			return undefined;
		}
	}

	/** Host rotation across failover attempts. */
	#pickHost(attempt: number): string {
		return this.#cfg.hosts[attempt % this.#cfg.hosts.length];
	}

	async models(): Promise<ModelMeta[]> {
		if (this.#modelsCache && Date.now() - this.#modelsCache.at < 60_000) {
			return this.#modelsCache.models;
		}
		let models: ModelMeta[] = [];
		try {
			models = parseAtomGitModels(readFileSync(join(homePath(this.#cfg.home), 'config.toml'), 'utf8'));
		} catch {
			// config.toml is optional for our purposes
		}
		if (this.#cfg.models.length > 0) {
			const allow = new Set(this.#cfg.models);
			models = models.filter((m) => allow.has(m.id));
		}
		if (models.length === 0) {
			models = STATIC_MODELS;
		}
		this.#modelsCache = { at: Date.now(), models };
		return models;
	}

	async prepare(model: string, body: ChatCompletionRequest, attempt: number): Promise<PreparedRequest> {
		const auth = await this.#ensureToken();
		if (!auth) {
			throw new Error('atomcode: not logged in — run `atomcode login`');
		}
		const host = this.#pickHost(attempt);
		const url = `${host.replace(/\/+$/, '')}/chat/completions`;
		const path = new URL(url).pathname;
		const payload: ChatCompletionRequest = { ...body, model };
		// Usage arrives in the final stream chunk only when requested.
		if (payload.stream === true && payload.stream_options === undefined) {
			payload.stream_options = { include_usage: true };
		}
		const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
		const version = this.#cfg.clientVersion || detectClientVersion();
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			authorization: `Bearer ${auth.accessToken}`,
			'user-agent': `atomcode/${version}`,
			...signAtomCodeRequest({
				method: 'POST',
				path,
				body: payloadBytes,
				accessToken: auth.accessToken,
				userId: auth.userId,
				clientVersion: version,
				timestampSeconds: Math.floor(Date.now() / 1000),
				nonce: randomBytes(16),
			}),
		};
		return {
			url,
			headers,
			body: payloadBytes.toString('utf8'),
			forceStream: false,
			via: `${this.name}@${new URL(host).hostname}`,
		};
	}

	isRetryable(status: number | undefined): boolean {
		return status === undefined || status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599);
	}

	/** 401/403: drop any minted token so the next attempt re-reads auth.toml. */
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
