import vscode from 'vscode';
import type { SourceName } from './types';

export interface AtomCodeSettings {
	enabled: boolean;
	home: string;
	hosts: string[];
	clientVersion: string;
	models: string[];
	allowRefresh: boolean;
}

export interface OpenCodeSettings {
	enabled: boolean;
	baseUrl: string;
	refreshSeconds: number;
}

export interface ClineSettings {
	enabled: boolean;
	baseUrl: string;
	home: string;
	clientType: string;
	clientVersion: string;
	allowRefresh: boolean;
	includeClinePass: boolean;
}

export interface Settings {
	debug: boolean;
	atomcode: AtomCodeSettings;
	opencode: OpenCodeSettings;
	cline: ClineSettings;
}

function str(section: vscode.WorkspaceConfiguration, key: string, fallback: string): string {
	const value = section.get<string>(key);
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function bool(section: vscode.WorkspaceConfiguration, key: string, fallback: boolean): boolean {
	const value = section.get<boolean>(key);
	return typeof value === 'boolean' ? value : fallback;
}

function num(section: vscode.WorkspaceConfiguration, key: string, fallback: number): number {
	const value = section.get<number>(key);
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function strArray(section: vscode.WorkspaceConfiguration, key: string): string[] {
	const value = section.get<unknown[]>(key);
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
		: [];
}

export function getSettings(): Settings {
	const root = vscode.workspace.getConfiguration('anyfree2copilot');
	const sources = vscode.workspace.getConfiguration('anyfree2copilot.sources');
	return {
		debug: bool(root, 'debug', false),
		atomcode: {
			enabled: bool(sources, 'atomcode.enabled', true),
			home: str(root, 'atomcode.home', ''),
			hosts: strArray(root, 'atomcode.hosts').length > 0
				? strArray(root, 'atomcode.hosts')
				: ['https://llm-api.atomgit.com/v1', 'https://api-ai.gitcode.com/v1'],
			clientVersion: str(root, 'atomcode.clientVersion', ''),
			models: strArray(root, 'atomcode.models'),
			allowRefresh: bool(root, 'atomcode.allowRefresh', true),
		},
		opencode: {
			enabled: bool(sources, 'opencode.enabled', true),
			baseUrl: str(root, 'opencode.baseUrl', 'https://opencode.ai/zen').replace(/\/+$/, ''),
			refreshSeconds: num(root, 'opencode.refreshSeconds', 300),
		},
		cline: {
			enabled: bool(sources, 'cline.enabled', true),
			baseUrl: str(root, 'cline.baseUrl', 'https://api.cline.bot/api/v1').replace(/\/+$/, ''),
			home: str(root, 'cline.home', ''),
			clientType: str(root, 'cline.clientType', ''),
			clientVersion: str(root, 'cline.clientVersion', ''),
			allowRefresh: bool(root, 'cline.allowRefresh', true),
			includeClinePass: bool(root, 'cline.includeClinePass', false),
		},
	};
}

export function isSourceEnabled(settings: Settings, name: SourceName): boolean {
	return settings[name].enabled;
}
