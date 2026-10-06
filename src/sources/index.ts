import { log } from '../log';
import type { Settings } from '../settings';
import type { ModelMeta, Source, SourceName } from '../types';
import { AtomCodeSource } from './atomcode';
import { ClineSource } from './cline';
import { OpenCodeSource } from './opencode';

/**
 * Model catalog. Each platform (source) is its own picker section — its
 * models are grouped by canonical key (decoration variants like
 * `cline-free/x` vs `org/x:free` dedup) and sorted for a stable order.
 */

/** One picker entry within a platform section. */
export interface Group {
	key: string;
	candidates: Array<{ source: Source; meta: ModelMeta }>;
	/** Merged display metadata (capability intersection over candidates). */
	meta: ModelMeta;
}

/** Picker sections / vendor ids, matching the package.json contributions.
 *  The picker sorts vendor sections alphabetically by displayName (core
 *  workbench getVendors()) and each section's models by name, so order is
 *  pinned with name prefixes: displayNames carry "1."/"2."/"3." prefixes
 *  (OpenCode, AtomCode, Cline) and promo fleet names get numbered prefixes
 *  at advertise time. */
export const PLATFORMS: Array<{ vendor: string; source: SourceName }> = [
	{ vendor: 'opencode', source: 'opencode' },
	{ vendor: 'atomcode', source: 'atomcode' },
	{ vendor: 'cline', source: 'cline' },
];

/**
 * Strip source-specific decorations from an upstream model id so variants of
 * the SAME model within one platform (Cline `cline-free/mimo-v2.6-flash` vs
 * `vendor/mimo-v2.6-flash:free`) group into one entry. Conservative on
 * purpose: variant suffixes like `-fin`/`-sante` or size specs stay distinct.
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
		{ id: 'cline-free/mimo-v2.6-flash', source: 'cline', name: 'MiMo V2.6 Flash (Cline)', supportsTools: true, promo: true },
		{ id: 'qwen/qwen3.8-27b:free', source: 'cline', name: 'Qwen3.8-27B Free (Cline)', supportsTools: true },
	],
};

function stripSourceSuffix(name: string): string {
	return name.replace(/\s*\((?:OpenCode|Cline|AtomCode)\)$/i, '').trim();
}

function mergeGroupMeta(key: string, metas: ModelMeta[]): ModelMeta {
	const contexts = metas.map((m) => m.contextWindow).filter((v): v is number => typeof v === 'number' && v > 0);
	let name = '';
	for (const meta of metas) {
		name = stripSourceSuffix(meta.name ?? '');
		if (name) {
			break;
		}
	}
	return {
		id: key,
		source: metas[0].source,
		...(name ? { name } : { name: key }),
		contextWindow: contexts.length > 0 ? Math.min(...contexts) : undefined,
		// A group is only as capable as its weakest candidate.
		supportsTools: metas.every((m) => m.supportsTools !== false),
		imageInput: metas.length > 0 && metas.every((m) => m.imageInput === true) ? true : undefined,
		reasoning: metas.some((m) => m.reasoning === true) || undefined,
		promo: metas.length > 0 && metas.every((m) => m.promo === true) ? true : undefined,
	};
}

function buildSourceGroups(source: Source, models: ModelMeta[]): Map<string, Group> {
	const byKey = new Map<string, Group>();
	for (const meta of models) {
		const key = canonicalModelKey(meta.id);
		const group = byKey.get(key);
		if (group) {
			if (!group.candidates.some((c) => c.meta.id === meta.id)) {
				group.candidates.push({ source, meta });
				group.meta = mergeGroupMeta(key, group.candidates.map((c) => c.meta));
			}
		} else {
			byKey.set(key, { key, candidates: [{ source, meta }], meta: mergeGroupMeta(key, [meta]) });
		}
	}
	return byKey;
}

export class Catalog {
	#sources: Source[];
	#bySource = new Map<SourceName, Map<string, Group>>();
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

	getSource(name: SourceName): Source | undefined {
		return this.#sources.find((s) => s.name === name);
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
		for (const source of this.#sources) {
			const models = perSource.get(source.name) ?? [];
			this.#bySource.set(source.name, buildSourceGroups(source, models));
		}
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

	/** One platform's groups for the picker: the provider's own promo free
	 *  fleet first (Cline's "Try with limited usage at no cost" models, kept in
	 *  the provider's recommendation order), then the rest by canonical key. */
	currentFor(source: SourceName): Group[] {
		const values = [...(this.#bySource.get(source)?.values() ?? [])];
		const promo = values.filter((g) => g.meta.promo === true);
		if (promo.length === 0) {
			return values.sort((a, b) => a.key.localeCompare(b.key));
		}
		const rest = values
			.filter((g) => g.meta.promo !== true)
			.sort((a, b) => a.key.localeCompare(b.key));
		return [...promo, ...rest];
	}

	/** Total number of advertised entries across all platforms. */
	get totalCount(): number {
		let total = 0;
		for (const groups of this.#bySource.values()) {
			total += groups.size;
		}
		return total;
	}

	resolveFor(source: SourceName, pickerModelId: string): Group | undefined {
		const byKey = this.#bySource.get(source);
		if (!byKey) {
			return undefined;
		}
		const direct = byKey.get(pickerModelId);
		if (direct) {
			return direct;
		}
		const canonical = byKey.get(canonicalModelKey(pickerModelId));
		if (canonical) {
			return canonical;
		}
		// Legacy "source/upstreamId" ids from an older session.
		const slash = pickerModelId.indexOf('/');
		if (slash > 0) {
			const rest = pickerModelId.slice(slash + 1);
			return byKey.get(rest) ?? byKey.get(canonicalModelKey(rest));
		}
		return undefined;
	}

	/**
	 * Refresh every enabled source (single-flight per source; each source
	 * applies its own cache window and falls back to its own static roster on
	 * failure), then rebuild the groups from whatever the sources now report —
	 * models that vanished upstream disappear from the picker instead of
	 * lingering. Resolves `true` when the advertised catalog changed. Never
	 * throws.
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
		const snapshot = () =>
			JSON.stringify([...this.#bySource.entries()].map(([name, groups]) => [name, [...groups.keys()].sort(), [...groups.values()].map((g) => g.meta)]));
		const before = snapshot();
		this.#rebuild(perSource);
		return before !== snapshot();
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
