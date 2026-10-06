import vscode from 'vscode';

import type { ModelMeta } from './types';
import type {
	ChatCompletionRequest,
	ChatContentPart,
	ChatMessage,
	ChatTool,
	ChatToolCall,
} from './types';

/**
 * Convert VS Code chat messages and request options into an OpenAI
 * chat-completions body. Tool results become their own `tool` messages right
 * after the assistant message that called them; images become data URLs when
 * the target model accepts image input.
 */

export function convertToChatRequest(
	upstreamModelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	meta: ModelMeta,
): ChatCompletionRequest {
	const nativeImages = meta.imageInput === true;
	const out: ChatMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);

		let content = '';
		const imageParts: ChatContentPart[] = [];
		const toolCalls: ChatToolCall[] = [];
		const toolResults: Array<{ callId: string; text: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (isToolResultPart(part)) {
				const toolPart = part as vscode.LanguageModelToolResultPart;
				toolResults.push({ callId: toolPart.callId, text: toolResultText(toolPart) });
			} else if (nativeImages && role === 'user' && isImagePart(part)) {
				imageParts.push({
					type: 'image_url',
					image_url: { url: toImageDataUrl(part as vscode.LanguageModelDataPart) },
				});
			}
			// Thinking parts are not replayed upstream.
		}

		if (role === 'assistant') {
			if (content || toolCalls.length > 0) {
				out.push({
					role: 'assistant',
					content,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				});
			}
		} else if (role === 'user' && nativeImages && imageParts.length > 0) {
			const parts: ChatContentPart[] = [];
			if (content) {
				parts.push({ type: 'text', text: content });
			}
			parts.push(...imageParts);
			out.push({ role: 'user', content: parts });
		} else if (content) {
			out.push({ role, content });
		}

		// Tool result messages follow their associated assistant message.
		for (const result of toolResults) {
			out.push({
				role: 'tool',
				content: result.text,
				tool_call_id: result.callId,
			});
		}
	}

	const tools = convertTools(options.tools);
	const toolChoice = convertToolChoice(options);

	return {
		model: upstreamModelId,
		messages: out,
		stream: true,
		stream_options: { include_usage: true },
		...(tools ? { tools } : {}),
		...(toolChoice ? { tool_choice: toolChoice } : {}),
	};
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

function isToolResultPart(part: unknown): boolean {
	if (typeof vscode.LanguageModelToolResultPart === 'function' && part instanceof vscode.LanguageModelToolResultPart) {
		return true;
	}
	// Subclasses (Part2 & co.) may not pass the instanceof check.
	const candidate = part as { callId?: unknown; content?: unknown };
	return typeof candidate?.callId === 'string' && Array.isArray(candidate?.content);
}

function toolResultText(part: vscode.LanguageModelToolResultPart): string {
	let text = '';
	for (const item of part.content ?? []) {
		if (item instanceof vscode.LanguageModelTextPart) {
			text += item.value;
		} else if (typeof item === 'string') {
			text += item;
		} else if (typeof vscode.LanguageModelDataPart === 'function' && item instanceof vscode.LanguageModelDataPart) {
			if (item.mimeType.startsWith('text/')) {
				text += new TextDecoder().decode(item.data);
			} else {
				text += `\n[non-text tool output of type ${item.mimeType} omitted]\n`;
			}
		}
	}
	return text;
}

function isImagePart(part: unknown): boolean {
	if (typeof vscode.LanguageModelDataPart !== 'function' || !(part instanceof vscode.LanguageModelDataPart)) {
		return false;
	}
	return typeof part.mimeType === 'string' && part.mimeType.startsWith('image/');
}

function toImageDataUrl(part: vscode.LanguageModelDataPart): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): ChatTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			// Some compatible endpoints require an explicit schema for tools without parameters.
			parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
		},
	}));
}

interface ToolChoiceShape {
	mode?: string;
	name?: string;
}

function convertToolChoice(options: vscode.ProvideLanguageModelChatResponseOptions): ChatCompletionRequest['tool_choice'] {
	const raw = (options as { toolChoice?: unknown }).toolChoice;
	if (raw === undefined || raw === null) {
		return undefined;
	}
	if (typeof raw === 'string') {
		return raw === 'auto' || raw === 'none' || raw === 'required' ? raw : undefined;
	}
	const shape = raw as ToolChoiceShape;
	if (shape.mode === 'tool' && typeof shape.name === 'string') {
		return { type: 'function', function: { name: shape.name } };
	}
	if (shape.mode === 'auto' || shape.mode === 'none' || shape.mode === 'required') {
		return shape.mode;
	}
	return undefined;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '{}';
	} catch {
		return '{}';
	}
}
