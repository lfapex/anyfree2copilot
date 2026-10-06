import vscode from 'vscode';

import { log } from './log';
import { FreeModelsChatProvider } from './provider';
import { getSettings } from './settings';

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('Free Models for Copilot');
	log.init(channel, getSettings().debug);
	context.subscriptions.push(channel);

	const provider = new FreeModelsChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('opencodecline.showStatus', () => provider.showStatus()),
		vscode.commands.registerCommand('opencodecline.refreshModels', () => provider.refreshModels()),
		vscode.commands.registerCommand('opencodecline.showLogs', () => log.show()),
		vscode.lm.registerLanguageModelChatProvider('opencodecline', provider),
	);

	// Make models discoverable without waiting for Copilot, which may itself
	// be waiting for BYOK registration.
	provider.refreshModelPicker();

	// Keep a post-activation refresh so cached picker info is replaced once
	// Copilot Chat is up and the live catalogs have answered.
	Promise.resolve(vscode.extensions.getExtension('github.copilot-chat')?.activate())
		.then(() => {
			provider.refreshModelPicker();
		})
		.catch((error) => {
			log.warn('extension', `failed to activate Copilot Chat or refresh model information: ${(error as Error).message}`);
		});
}

export function deactivate(): void {
	// Nothing to dispose manually — everything is registered on context.
}
