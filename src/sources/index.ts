import { log } from '../log';
import type { Settings } from '../settings';
import type { ModelMeta, Source, SourceName } from '../types';
import { pickerId } from '../types';
import { AtomCodeSource } from './atomcode';
import { ClineSource } from './cline';
import { OpenCodeSource } from './opencode';

/** Static rosters so the picker is populated immediately on cold start. */
const STATIC_FALLBACK: Record<SourceName, ModelMeta[]> = {
	atomcode: [
		{ id: 'qwen3.8-27b', source: 'atomcode', name: 'Qwen3.8-27B (AtomCode)', contextWindow: 262_144, supportsTools: true, imageInput: true, reasoning: true },
		{ id: 'glm5.3-flash', source: 'atomcode', name: 'GLM-5.3-Flash (AtomCode)', contextWindow: 512_000, supportsTools: true, imageInput: true, reasoning: true },
	],
	opencode: [
		{ id: 'big-pickle', source: 'opencode', name: 'Big Pickle (OpenCode)', reasoning: true, supportsTools: true },
		{ id: 'mimo-v2.6-flash-free', source: 'opencode', name: 'MiMo V2.6 Flash Free (OpenCode)', contextWindow: 200_000, supportsTools: true, imageInput: true, reasoning: true },
		{ id: 'ling-3.1-flash-free', source: 'opencode', name: 'Ling 3.1 Flash Free (OpenCode)', contextWindow: 262_144, supportsTools: true, reasoning: true },
	],
	cline: [
		{ id: 'cline-free/deepseek-v4.1-flash', source: 'cline', name: 'DeepSeek V4.1 Flash (Cline)', supportsTools: true },
		{ id: 'cline-free/mimo-v2.6-flash', source: 'cline', name: 'MiMo V2.6 Flash (Cline)', supportsTools: true },
		{ id: 'qwen/qwen3.8-27b:free', source: 'cline', name: 'Qwen3.8-27B Free (Cline)', supportsTools: true },
	],
};

/**
 * Aggregated catalog of every enabled source, with a live refresh loop and
 * a static fallback so the model picker never starts out empty.
 */
export class Catalog {
	#sources: Source[];
	/** Currently advertised models, keyed by picker id. */
	#current = new Map<string, ModelMeta>();
	#singleFlight = new Map<SourceName, Promise<void>>();
	#lastRefresh = 0;
	#changedSinceLastCheck = false;

	constructor(settings: Settings) {
		this.#sources = [
			new AtomCodeSource(settings.atomcode),
			new OpenCodeSource(settings.opencode),
			new ClineSource(settings.cline),
		];
		this.#resetToStatic();
	}

	get sources(): readonly Source[] {
		return this.#sources;
	}

	#resetToStatic(): void {
		this.#current.clear();
		for (const source of this.#sources) {
			if (!source.isEnabled()) {
				continue;
			}
			for (const meta of STATIC_FALLBACK[source.name]) {
				this.#current.set(pickerId(meta), meta);
			}
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
		this.#resetToStatic();
	}

	current(): ModelMeta[] {
		return [...this.#current.values()];
	}

	resolve(pickerModelId: string): { source: Source; meta: ModelMeta } | undefined {
		const known = this.#current.get(pickerModelId);
		if (known) {
			const source = this.#sources.find((s) => s.name === known.source);
			if (source) {
				return { source, meta: known };
			}
		}
		// Unknown to the catalog (it may have refreshed since): route by prefix.
		const slash = pickerModelId.indexOf('/');
		if (slash <= 0) {
			return undefined;
		}
		const sourceName = pickerModelId.slice(0, slash) as SourceName;
		const source = this.#sources.find((s) => s.name === sourceName);
		if (!source) {
			return undefined;
		}
		return {
			source,
			meta: { id: pickerModelId.slice(slash + 1), source: sourceName, supportsTools: true },
		};
	}

	/**
	 * Refresh every enabled source (single-flight per source; each source
	 * applies its own cache window). Resolves `true` when the advertised
	 * catalog changed. Never throws.
	 */
	async ensureFresh(): Promise<boolean> {
		this.#lastRefresh = Date.now();
		this.#changedSinceLastCheck = false;
		await Promise.all(
			this.#sources
				.filter((s) => s.isEnabled())
				.map((source) => {
					let run = this.#singleFlight.get(source.name);
					if (!run) {
						run = source
							.models()
							.then((models) => {
								this.#merge(source.name, models);
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
		return this.#changedSinceLastCheck;
	}

	#merge(source: SourceName, models: ModelMeta[]): void {
		let changed = false;
		const keep = new Set<string>();
		for (const meta of models) {
			const id = pickerId(meta);
			keep.add(id);
			const existing = this.#current.get(id);
			if (!existing || JSON.stringify(existing) !== JSON.stringify(meta)) {
				this.#current.set(id, meta);
				changed = true;
			}
		}
		// Drop ids of this source that vanished upstream, unless they are one of
		// the static fallback entries (those stay so the picker never empties).
		const fallbackIds = new Set(STATIC_FALLBACK[source].map((m) => m.id));
		for (const [id, meta] of this.#current) {
			if (meta.source === source && !keep.has(id) && !fallbackIds.has(meta.id)) {
				this.#current.delete(id);
				changed = true;
			}
		}
		if (changed) {
			this.#changedSinceLastCheck = true;
		}
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
