/**
 * Incremental server-sent-events parser.
 *
 * Feeds raw text chunks, emits complete `data:` payloads. Comment lines
 * (`: keep-alive`, sent by the Zen lane between events) are ignored; the
 * `data:` value is the join of all data lines of one event, per the SSE spec.
 */

export interface SseEvent {
	data: string;
}

export class SseParser {
	#buffer = '';
	#dataLines: string[] = [];

	/** Push one text chunk; returns the events completed by it. */
	push(chunk: string): SseEvent[] {
		this.#buffer += chunk;
		const events: SseEvent[] = [];
		// Normalize CRLF: split on LF, trim a trailing CR per line.
		let index: number;
		while ((index = this.#buffer.indexOf('\n')) !== -1) {
			const line = this.#buffer.slice(0, index).replace(/\r$/, '');
			this.#buffer = this.#buffer.slice(index + 1);
			if (line === '') {
				if (this.#dataLines.length > 0) {
					events.push({ data: this.#dataLines.join('\n') });
					this.#dataLines = [];
				}
				continue;
			}
			if (line.startsWith(':')) continue; // comment / keep-alive
			if (line.startsWith('data:')) {
				this.#dataLines.push(line.slice(5).replace(/^ /, ''));
			}
			// event:/id:/retry: are irrelevant for chat passthrough.
		}
		return events;
	}
}

/** True when the event closes an OpenAI stream. */
export function isDoneEvent(data: string): boolean {
	return data.trim() === '[DONE]';
}
