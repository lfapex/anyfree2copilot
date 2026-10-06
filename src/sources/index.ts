import { log } from '../log';
import type { Settings } from '../settings';
import type { ModelMeta, Source, SourceName } from '../types';
import { AtomCodeSource } from './atomcode';
import { ClineSource } from './cline';
import { OpenCodeSource } from './opencode';

/**
 * Model catalog: merges every enabled source's models into canonical groups
 * (the same model sold under different ids across sources becomes ONE picker
 * entry whose candidates span every source carrying it — requests fail over
 * across the chain), following the grouping of the local freegw gateway.
 */

/** One picker entry: a canonical model with candidates across sources. */
export interface Group {
	key: string;
	candidates: Array<{ source: Source; meta: ModelMeta }>;
	/** Merged display metadata (capability intersection over candidates). */
	meta: ModelMeta;
}

const SOURCE_ORDER: SourceName[] = ['opencode', 'cline', 'atomcode'];

/**
 * Strip source-specific decorations from an upstream model id so the SAME
 * model sold under different ids (AtomCode `qwen3.8-27b`, Cline
 * `qwen/qwen3.8-27b:free`, Zen `mimo-v2.6-flash-free` vs Cline
 * `cline-free/mimo-v2.6-flash`) groups into one consistent chain.
 * Conservative on purpose: variant suffixes like `-fin`/`-sante` or size
 * specs (`-550b-a55b`) stay distinct.
 */
export function canonicalModelKey(id: string): string {
	let key = id;
	let hadFreeSuffix = false;
	if (key.endsWith(':free')) {
		key = key.slice(0, -':free'.length);
		hadFreeSuffix = true;
	}
	if (key.startsWith('cline-free/')) {
		key = key.slice('cline-free/'.length);
	}
	if (hadFreeSuffix) {
		const slash = key.indexOf('/');
		if (slash > 0) {
			key = key.slice(slash + 1); // OpenRouter org prefix
		}
	}
	if (key.endsWith('-free')) {
		key = key.slice(0, -'-free'.length);
	}
	return key;
}

/** Static rosters so the picker is populated immediately on cold start. */
const STATIC_FALLBACK: Record<SourceName, ModelMeta[]> = {
	atomcode: [
		{ id: 'qwen3.8-27b', source: 'atomcode', name: 'Qwen3.8-27B (AtomCode)', contextWindow: 262_144, supportsTools: true, imageInput: true, reasoning: true },
		{ id: 'glm5.3-flash', source: 'atomcode', name: 'GLM-5.3-Flash (AtomCode)', contextWindow: 512_000, supportsTools: true, imageInput: true, reasoning: true },
	],
	opencode: [
		{ id: 'big-pickle', source: 'opencode', name: 'Big Pickle', reasoning: true, supportsTools: true },
		{ id: 'mimo-v2.6-flash-free', source: 'opencode', name: 'MiMo V2.6 Flash Free', contextWindow: 200_000, maxOutput: 32_000, supportsTools: true, imageInput: true, reasoning: true },
		{ id: 'ling-3.1-flash-free', source: 'opencode', name: 'Ling 3.1 Flash Free', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, reasoning: true },
	],
	cline: [
		{ id: 'cline-free/mimo-v2.6-flash', source: 'cline', name: 'MiMo V2.6 Flash (Cline)', supportsTools: true },
		{ id: 'qwen/qwen3.8-27b:free', source: 'cline', name: 'Qwen3.8-27B Free (Cline)', supportsTools: true },
	],
};

function sourceRank(name: SourceName): number {
	return SOURCE_ORDER.indexOf(name);
}

function stripSourceSuffix(name: string): string {
	return name.replace(/\s*\((?:OpenCode|Cline|AtomCode)\)$/i, '').trim();
}

function mergeGroupMeta(key: string, candidates: Array<{ source: Source; meta: ModelMeta }>): ModelMeta {
	const metas = candidates.map((c) => c.meta);
	const contexts = metas.map((m) => m.contextWindow).filter((v): v is number => typeof v === 'number' && v > 0);
	const sources = [...new Set(metas.map((m) => m.source))].sort((a, b) => sourceRank(a) - sourceRank(b));
	let name = '';
	for (const meta of metas) {
		name = stripSourceSuffix(meta.name ?? '');
		if (name) {
			break;
		}
	}
	return {
		id: key,
		source: sources[0],
		...(name ? { name } : { name: key }),
		contextWindow: contexts.length > 0 ? Math.min(...contexts) : undefined,
		// A chain is only as capable as its weakest candidate.
		supportsTools: metas.every((m) => m.supportsTools !== false),
		imageInput: metas.length > 0 && metas.every((m) => m.imageInput === true) ? true : undefined,
		reasoning: metas.some((m) => m.reasoning === true) || undefined,
	};
}

export class Catalog {
	#sources: Source[];
	#groups = new Map<string, Group>();
	#singleFlight = new Map<SourceName, Promise<void>>();
	#lastRefresh = 0;

	constructor(settings: Settings) {
		this.#sources = [
			new AtomCodeSource(settings.atomcode),
			new OpenCodeSource(settings.opencode),
			new ClineSource(settings.cline),
		];
		this.#rebuild(this.#staticPerSource());
	}

	get sources(): readonly Source[] {
		return this.#sources;
	}

	#staticPerSource(): Map<SourceName, ModelMeta[]> {
		const perSource = new Map<SourceName, ModelMeta[]>();
		for (const source of this.#sources) {
			if (source.isEnabled()) {
				perSource.set(source.name, STATIC_FALLBACK[source.name]);
			}
		}
		return perSource;
	}

	#rebuild(perSource: Map<SourceName, ModelMeta[]>): void {
		const byKey = new Map<string, Array<{ source: Source; meta: ModelMeta }>>();
		for (const source of this.#sources) {
			const models = perSource.get(source.name);
			if (!models) {
				continue;
			}
			for (const meta of models) {
				const key = canonicalModelKey(meta.id);
				const list = byKey.get(key) ?? [];
				if (!list.some((c) => c.meta.source === meta.source && c.meta.id === meta.id)) {
					list.push({ source, meta });
				}
				byKey.set(key, list);
			}
		}
		const groups = new Map<string, Group>();
		for (const [key, candidates] of byKey) {
			candidates.sort((a, b) => sourceRank(a.meta.source) - sourceRank(b.meta.source));
			groups.set(key, { key, candidates, meta: mergeGroupMeta(key, candidates) });
		}
		this.#groups = groups;
	}

	/** Rebuild with fresh settings: recreate sources, drop caches, reset to static. */
	reconfigure(settings: Settings): void {
		for (const source of this.#sources) {
			source.clearCache();
		}
		this.#sources = [
			new AtomCodeSource(settings.atomcode),
			new OpenCodeSource(settings.opencode),
			new ClineSource(settings.cline),
		];
		this.#singleFlight.clear();
		this.#lastRefresh = 0;
		this.#rebuild(this.#staticPerSource());
	}

	/** Current groups, sorted by canonical id for a stable picker order. */
	current(): Group[] {
		return [...this.#groups.values()].sort((a, b) => a.key.localeCompare(b.key));
	}

	resolve(pickerModelId: string): Group | undefined {
		const exact = this.#groups.get(pickerModelId);
		if (exact) {
			return exact;
		}
		// Legacy/aliased form "source/upstreamId": canonicalize the remainder.
		const slash = pickerModelId.indexOf('/');
		if (slash > 0) {
			const rest = pickerModelId.slice(slash + 1);
			const key = canonicalModelKey(rest);
			return this.#groups.get(key);
		}
		return undefined;
	}

	/**
	 * Refresh every enabled source (single-flight per source; each source
	 * applies its own cache window and falls back to its own static roster on
	 * failure), then rebuild the groups from whatever the sources now report —
	 * models that vanished upstream disappear from the picker instead of
	 * lingering forever. Resolves `true` when the advertised catalog changed.
	 * Never throws.
	 */
	async ensureFresh(): Promise<boolean> {
		this.#lastRefresh = Date.now();
		const perSource = new Map<SourceName, ModelMeta[]>();
		await Promise.all(
			this.#sources
				.filter((s) => s.isEnabled())
				.map((source) => {
					let run = this.#singleFlight.get(source.name);
					if (!run) {
						run = source
							.models()
							.then((models) => {
								perSource.set(source.name, models);
							})
							.catch((err) => {
								log.warn(source.name, `catalog refresh failed: ${(err as Error).message}`);
							})
							.finally(() => {
								this.#singleFlight.delete(source.name);
							});
						this.#singleFlight.set(source.name, run);
					}
					return run;
				}),
		);
		const before = JSON.stringify([...this.#groups.values()].map((g) => [g.key, g.candidates.map((c) => `${c.meta.source}:${c.meta.id}`), g.meta]));
		this.#rebuild(perSource);
		const after = JSON.stringify([...this.#groups.values()].map((g) => [g.key, g.candidates.map((c) => `${c.meta.source}:${c.meta.id}`), g.meta]));
		return before !== after;
	}

	/** For the status view: when the last refresh round ran (0 = never). */
	get lastRefreshAt(): number {
		return this.#lastRefresh;
	}
}

export function statusLines(catalog: Catalog): string[] {
	const lines: string[] = [];
	for (const source of catalog.sources) {
		const status = source.status();
		const head = `${status.name}: ${status.enabled ? (status.ready ? 'ready' : 'not ready') : 'disabled'} · ${status.models} models`;
		lines.push(status.lastError ? `${head} — ${status.lastError}` : head);
	}
	return lines;
}
