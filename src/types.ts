/** Shared types: OpenAI chat-completions wire format, model metadata, sources. */

// ---- OpenAI chat-completions wire format ----

export interface ChatTextPart {
	type: 'text';
	text: string;
}

export interface ChatImageUrlPart {
	type: 'image_url';
	image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImageUrlPart;

export interface ChatToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ChatContentPart[];
	tool_call_id?: string;
	tool_calls?: ChatToolCall[];
}

export interface ChatTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface ChatCompletionRequest {
	model?: string;
	messages: ChatMessage[];
	/** Some upstreams accept a top-level system prompt alongside messages. */
	system?: string;
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	tools?: ChatTool[];
	tool_choice?: string | { type: 'function'; function: { name: string } };
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
}

export interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	cached_tokens?: number;
}

export interface ChatStreamChunk {
	id?: string;
	model?: string;
	choices?: Array<{
		index?: number;
		delta?: {
			content?: string | null;
			reasoning?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ChatUsage;
}

// ---- Model metadata ----

export type SourceName = 'atomcode' | 'opencode' | 'cline';

export interface ModelMeta {
	/** Upstream model id (what the upstream expects in `body.model`). */
	id: string;
	/** Owning source. */
	source: SourceName;
	/** Human display name. */
	name?: string;
	contextWindow?: number;
	maxOutput?: number;
	supportsTools?: boolean;
	imageInput?: boolean;
	reasoning?: boolean;
	/** Provider's own promo free fleet ("Try with limited usage at no cost") —
	 *  pinned to the top of its platform section in the picker. */
	promo?: boolean;
}

/** Picker-wide unique id: `<source>/<upstream-id>`. */
export function pickerId(meta: Pick<ModelMeta, 'source' | 'id'>): string {
	return `${meta.source}/${meta.id}`;
}

// ---- Sources ----

/**
 * One fully prepared upstream request. The stream layer only fetch()es it.
 * `forceStream` marks sources where the upstream always streams (Zen's
 * free-lane gate) even if the client asked otherwise.
 */
export interface PreparedRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
	forceStream: boolean;
	/** Short label for logs, e.g. "atomcode@llm-api.atomgit.com". */
	via: string;
	/** The upstream body carries reserved gate tools the client never sent. */
	stripGateTools?: boolean;
}

export interface SourceStatus {
	name: SourceName;
	enabled: boolean;
	ready: boolean;
	models: number;
	lastError?: string;
}

export interface Source {
	readonly name: SourceName;
	isEnabled(): boolean;
	/** Current model catalog (live, memory-cached, or static fallback). */
	models(): Promise<ModelMeta[]>;
	/** Prepare attempt N (0-based) of one chat completion for one model. */
	prepare(upstreamId: string, body: ChatCompletionRequest, attempt: number): Promise<PreparedRequest>;
	/** True when this failure should be retried on the same source. */
	isRetryable(status: number | undefined): boolean;
	/** Auth-rejection hook: let sources drop minted tokens on 401/403. */
	onUpstreamFailure?(status: number | undefined): void;
	status(): SourceStatus;
	/** Drop memoized catalogs/auth so the next call re-reads everything. */
	clearCache(): void;
}
