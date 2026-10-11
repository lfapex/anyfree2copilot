import { log } from '../log';
import type { FreeGWSettings } from '../settings';
import type {
	ChatCompletionRequest,
	ModelMeta,
	PreparedRequest,
	Source,
	SourceStatus,
} from '../types';

/**
 * FreeGW — the author's local OpenAI-compatible gateway. This source exposes
 * ONLY the gateway's virtual models (failover chains defined in freegw's
 * config, e.g. `main-coder`), not its full catalog: the individual lanes are
 * already covered by the platform sections, while the virtual ids are unique
 * to freegw — clients pin one id and its cross-source failover, health
 * tracking and custom sources are absorbed by the gateway. Mechanically it is
 * a plain OpenAI client: catalog = GET /v1/models (rows with
 * `freegw.source === 'virtual'`, carrying the chain in `freegw.candidates`),
 * chat = POST /v1/chat/completions with the exposed id as `model`. No static
 * roster — when the gateway is not running the section stays empty instead of
 * advertising models that cannot answer.
 */

/** One entry of freegw's /v1/models `data` array. */
interface FreeGWModelRow {
	id?: unknown;
	owned_by?: unknown;
	freegw?: {
		source?: unknown;
		upstream_id?: unknown;
		context_window?: unknown;
		max_output?: unknown;
		supports_tools?: unknown;
		image_input?: unknown;
		reasoning?: unknown;
		candidates?: unknown;
	};
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/** Tokens spelled out for the display name; everything else title-cases. */
const NAME_TOKENS: Record<string, string> = {
	ai: 'AI',
	api: 'API',
	glm: 'GLM',
	llm: 'LLM',
	mimo: 'MiMo',
};

function prettyToken(word: string): string {
	// "glm5.3" -> "GLM5.3": a known acronym that runs into a version suffix.
	const match = /^([a-z]+)([\d.].*)?$/i.exec(word);
	if (match) {
		const known = NAME_TOKENS[match[1].toLowerCase()];
		if (known) {
			return known + (match[2] ?? '');
		}
	}
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Display name from the upstream id: last path segment, decoration suffixes
 * dropped, tokens title-cased ("cline-free/mimo-v2.6-flash" -> "MiMo V2.6
 * Flash"). freegw's /v1/models carries no human names of its own.
 */
export function prettifyModelName(rawId: string): string {
	const id = asString(rawId).trim();
	const last = (id.split('/').pop() ?? id).replace(/:free$/i, '').replace(/-free$/i, '');
	const name = last
		.split(/[-_]/)
		.filter(Boolean)
		.map(prettyToken)
		.join(' ')
		.trim();
	return name || id;
}

/** "atomcode/glm5.3-flash" entries for the picker tooltip, in chain order. */
function asChain(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const chain = value
		.map((entry) => {
			if (typeof entry !== 'object' || entry === null) {
				return '';
			}
			const source = asString((entry as { source?: unknown }).source);
			const id = asString((entry as { id?: unknown }).id);
			return source && id ? `${source}/${id}` : id;
		})
		.filter(Boolean);
	return chain.length > 0 ? chain : undefined;
}

export class FreeGWSource implements Source {
	readonly name = 'freegw' as const;
	#cfg: FreeGWSettings;
	#cache: { at: number; models: ModelMeta[] } | undefined;
	#lastError = '';

	constructor(cfg: FreeGWSettings) {
		// A trailing /v1 (with or without a slash) is tolerated so a pasted full
		// endpoint keeps working; all URLs below append /v1/... themselves.
		this.#cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '') };
	}

	isEnabled(): boolean {
		return this.#cfg.enabled;
	}

	/**
	 * The gateway's virtual models with the source's refresh window. On
	 * failure the section empties (no static roster to fake availability) and
	 * retries in about a minute.
	 */
	async models(): Promise<ModelMeta[]> {
		const refreshMs = this.#cfg.refreshSeconds * 1000;
		if (this.#cache && Date.now() - this.#cache.at < refreshMs) {
			return this.#cache.models;
		}
		try {
			const models = await this.#fetchCatalog();
			log.info(this.name, `live catalog: ${models.length} virtual models from the local gateway`);
			this.#cache = { at: Date.now(), models };
			this.#lastError = '';
			return models;
		} catch (err) {
			this.#lastError = `gateway unreachable: ${(err as Error).message}`;
			log.warn(this.name, `${this.#lastError}; FreeGW section stays empty — start freegw or check anyfree.freegw.baseUrl`);
			this.#cache = { at: Date.now() - refreshMs + 60_000, models: [] }; // retry in a minute
			return [];
		}
	}

	async #fetchCatalog(): Promise<ModelMeta[]> {
		const res = await fetch(`${this.#cfg.baseUrl}/v1/models`, {
			headers: this.#authHeaders(),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			throw new Error(`GET /v1/models -> ${res.status}`);
		}
		const body = (await res.json()) as { data?: FreeGWModelRow[] };
		const models: ModelMeta[] = [];
		for (const row of body.data ?? []) {
			const id = asString(row.id);
			const meta = row.freegw ?? {};
			// Virtual rows only: everything else belongs to the platform sections.
			if (!id || (asString(meta.source) !== 'virtual' && asString(row.owned_by) !== 'virtual')) {
				continue;
			}
			models.push({
				id, // the exposed id — exactly what freegw's chat endpoint resolves
				source: this.name,
				name: `${prettifyModelName(asString(meta.upstream_id) || id)} (FreeGW)`,
				contextWindow: asPositiveNumber(meta.context_window),
				maxOutput: asPositiveNumber(meta.max_output),
				supportsTools: asBoolean(meta.supports_tools) ?? true,
				imageInput: asBoolean(meta.image_input),
				reasoning: asBoolean(meta.reasoning),
				chain: asChain(meta.candidates),
			});
		}
		return models;
	}

	#authHeaders(): Record<string, string> {
		return this.#cfg.apiKey ? { authorization: `Bearer ${this.#cfg.apiKey}` } : {};
	}

	async prepare(model: string, body: ChatCompletionRequest): Promise<PreparedRequest> {
		return {
			url: `${this.#cfg.baseUrl}/v1/chat/completions`,
			headers: { 'content-type': 'application/json', ...this.#authHeaders() },
			body: JSON.stringify({ ...body, model }),
			forceStream: false,
			via: `${this.name}@local`,
		};
	}

	isRetryable(status: number | undefined): boolean {
		// freegw already fails over across its own candidate chains upstream;
		// what surfaces here is a dead gateway (network error) or all-candidates
		// exhausted (429/5xx passthrough), both worth one more try.
		return status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
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
		this.#lastError = '';
	}
}
