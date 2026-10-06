import type vscode from 'vscode';

/**
 * Output-channel logging, shared across the extension. The `vscode` module is
 * required lazily so the pure source modules stay testable under plain Node.
 */
class Log {
	#channel: vscode.OutputChannel | undefined;
	#debug = false;

	init(channel: vscode.OutputChannel, debug: boolean): void {
		this.#channel = channel;
		this.#debug = debug;
	}

	setDebug(debug: boolean): void {
		this.#debug = debug;
	}

	info(source: string, message: string): void {
		this.#write('info', source, message);
	}

	warn(source: string, message: string): void {
		this.#write('warn', source, message);
	}

	error(source: string, message: string): void {
		this.#write('error', source, message);
	}

	debugLog(source: string, message: string): void {
		if (this.#debug) {
			this.#write('debug', source, message);
		}
	}

	show(): void {
		this.#channel?.show();
	}

	#write(level: string, source: string, message: string): void {
		this.#channel?.appendLine(`[${new Date().toISOString()}] [${level}] [${source}] ${message}`);
	}
}

export const log = new Log();
