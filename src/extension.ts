import vscode from 'vscode';

import { log } from './log';
import { CatalogRefresher, PlatformChatProvider } from './provider';
import { getSettings } from './settings';
import { Catalog, PLATFORMS, statusLines } from './sources';

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('AnyFree for Copilot');
	log.init(channel, getSettings().debug);
	context.subscriptions.push(channel);

	const catalog = new Catalog(getSettings());
	const onChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(onChanged);
	const refresher = new CatalogRefresher(catalog, () => onChanged.fire());

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('anyfree')) {
				catalog.reconfigure(getSettings());
				log.debugLog('extension', 'settings changed — catalog reconfigured');
				onChanged.fire();
				void refresher.refresh();
			}
		}),
		vscode.commands.registerCommand('anyfree.showStatus', () => showStatus(catalog)),
		vscode.commands.registerCommand('anyfree.refreshModels', () => refreshModels(refresher, catalog)),
		vscode.commands.registerCommand('anyfree.showLogs', () => log.show()),
	);

	// One picker section per platform, in package.json contribution order.
	for (const { vendor, source } of PLATFORMS) {
		context.subscriptions.push(
			vscode.lm.registerLanguageModelChatProvider(
				vendor,
				new PlatformChatProvider(catalog, source, onChanged.event, () => void refresher.refresh()),
			),
		);
	}

	// Make models discoverable without waiting for Copilot, which may itself
	// be waiting for BYOK registration.
	onChanged.fire();

	// Keep a post-activation refresh so cached picker info is replaced once
	// Copilot Chat is up and the live catalogs have answered.
	Promise.resolve(vscode.extensions.getExtension('github.copilot-chat')?.activate())
		.then(() => {
			onChanged.fire();
		})
		.catch((error) => {
			log.warn('extension', `failed to activate Copilot Chat or refresh model information: ${(error as Error).message}`);
		});
}

function refreshModels(refresher: CatalogRefresher, catalog: Catalog): void {
	void refresher.refresh(true).then(() => {
		void vscode.window.showInformationMessage(
			`AnyFree: catalog refreshed — ${catalog.totalCount} models available`,
		);
	});
}

function showStatus(catalog: Catalog): void {
	const items = statusLines(catalog).map((line) => ({
		label: line.split(':')[0],
		description: line.split(':').slice(1).join(':').trim(),
	}));
	items.unshift({ label: `${catalog.totalCount} models`, description: 'advertised to Copilot Chat' });
	void vscode.window.showQuickPick(items, { placeHolder: 'AnyFree source status' });
}

export function deactivate(): void {
	// Nothing to dispose manually — everything is registered on context.
}
