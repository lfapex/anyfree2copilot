/**
 * Pure-function smoke tests for the ported source logic. Run with:
 *
 *   npm run compile && npm run smoke
 *
 * The signing golden vector was live-verified by freegw (2026-10-05) against
 * llm-api.atomgit.com; the session/shape vectors come from the same lineage.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const atomcode = require('../out/sources/atomcode.js');
const opencode = require('../out/sources/opencode.js');
const cline = require('../out/sources/cline.js');
const { canonicalModelKey, Catalog } = require('../out/sources/index.js');
const { SseParser, isDoneEvent } = require('../out/sse.js');

test('atomcode-signing-v1: golden vector (live-verified scheme, pinned)', () => {
	const headers = atomcode.signAtomCodeRequest({
		method: 'POST',
		path: '/v1/chat/completions',
		body: Buffer.from('{}'),
		accessToken: 'test-token',
		userId: 'usr123',
		clientVersion: '5.2.1',
		timestampSeconds: 1_791_164_000,
		nonce: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
	});
	assert.equal(headers['X-AtomCode-Sig'], 'v1:baac21297c10a255211405457bd6c5a7046061f2335526f6175536376254c043');
	assert.equal(headers['X-AtomCode-Ts'], '1791164000');
	assert.equal(headers['X-AtomCode-Nonce'], '0123456789abcdef0123456789abcdef');
	assert.equal(headers['X-AtomCode-Alg'], '1');
	assert.equal(headers['X-AtomCode-Ver'], '5.2.1');
});

test('atomcode-signing-v1: signature varies with body, nonce, hour bucket and path', () => {
	const base = {
		method: 'POST',
		path: '/v1/chat/completions',
		body: Buffer.from('{"model":"qwen3.8-27b"}'),
		accessToken: 'test-token',
		userId: 'usr123',
		clientVersion: '5.2.1',
	};
	const sigOf = (h) => h['X-AtomCode-Sig'];
	const a = atomcode.signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) });
	const b = atomcode.signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 2) });
	const c = atomcode.signAtomCodeRequest({ ...base, body: Buffer.from('{"model":"glm5.3-flash"}'), timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) });
	const d = atomcode.signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000 + 3600, nonce: Buffer.alloc(16, 1) });
	const e = atomcode.signAtomCodeRequest({ ...base, path: '/chat/completions', timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) });
	assert.notEqual(sigOf(a), sigOf(b));
	assert.notEqual(sigOf(a), sigOf(c));
	assert.notEqual(sigOf(a), sigOf(d));
	assert.notEqual(sigOf(a), sigOf(e));
	assert.equal(sigOf(atomcode.signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) })), sigOf(a));
});

test('auth.toml parsing: tokens, user id and expiry', () => {
	const auth = atomcode.parseAuthToml(`
access_token = "tok-abc"
refresh_token = "ref-xyz"
token_type = "Bearer"
expires_in = 604800
created_at = 1791162795

[user]
id = "uid-42"
username = "someone"
`);
	assert.ok(auth);
	assert.equal(auth.accessToken, 'tok-abc');
	assert.equal(auth.refreshToken, 'ref-xyz');
	assert.equal(auth.userId, 'uid-42');
	assert.equal(auth.expiresAt, (1_791_162_795 + 604_800) * 1000);
});

test('config.toml parsing: AtomGit model profiles', () => {
	const toml = `
default_provider = "AtomGit-qwen3.8-27b"

[provider_accounts.AtomGit]
provider = "openai"
base_url = "https://llm-api.atomgit.com/v1"

[models."AtomGit-qwen3.8-27b"]
account = "AtomGit"
model = "qwen3.8-27b"
context_window = 262144
supports_vision = true

[models."Other-claude"]
account = "Other"
model = "claude-x"
`;
	const models = atomcode.parseAtomGitModels(toml);
	assert.equal(models.length, 1);
	assert.equal(models[0].id, 'qwen3.8-27b');
	assert.equal(models[0].source, 'atomcode');
	assert.equal(models[0].contextWindow, 262_144);
	assert.equal(models[0].imageInput, true);
});

test('canonical session id matches the Zen free-lane shape and is stable', () => {
	const a = opencode.canonicalSessionId('conversation-seed-one');
	const b = opencode.canonicalSessionId('conversation-seed-one');
	const c = opencode.canonicalSessionId('conversation-seed-two');
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	const official = 'ses_0123456789abABCDEF01234567';
	assert.equal(opencode.canonicalSessionId(official), official);
});

test('zen headers carry the full CLI disguise set', () => {
	const ids = opencode.deriveZenIds({ messages: [{ role: 'user', content: 'hello' }] }, 'project-seed');
	const headers = opencode.zenHeaders(ids);
	assert.equal(headers.authorization, 'Bearer public');
	assert.equal(headers['x-opencode-client'], 'cli');
	assert.equal(headers['x-opencode-session'], ids.session);
	assert.equal(headers['x-session-affinity'], ids.session);
	assert.equal(headers['X-Session-Id'], ids.session);
	assert.match(headers['x-opencode-request'], /^req_[0-9a-f]{32}$/);
	assert.match(headers['x-opencode-project'], /^prj_[0-9a-f]{24}$/);
	assert.match(opencode.zenUserAgent(), /^opencode\/1\.18\.31 \(/);
});

test('free-lane gate: injects bash+read, forces stream, pins tool_choice=none', () => {
	const plain = opencode.applyFreeLaneShape({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
	assert.equal(plain.injected, true);
	assert.equal(plain.body.stream, true);
	assert.equal(plain.body.tool_choice, 'none');
	const names = plain.body.tools.map((t) => t.function.name);
	assert.deepEqual([...names].sort(), ['bash', 'read']);
	assert.equal(plain.body.stream_options.include_usage, true);

	const withTools = opencode.applyFreeLaneShape({
		model: 'x',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
	});
	assert.equal(withTools.injected, true); // only bash is missing
	assert.equal(withTools.body.tool_choice, undefined);
	const names2 = withTools.body.tools.map((t) => t.function.name);
	assert.deepEqual([...names2].sort(), ['bash', 'read']);
});

test('providers.json parsing: Cline account session', () => {
	const auth = cline.parseClineProvidersJson(JSON.stringify({
		providers: {
			cline: {
				settings: {
					auth: {
						accessToken: 'acc-1',
						refreshToken: 'ref-1',
						expiresAt: 1791164000000,
						metadata: { userInfo: { clineUserId: 'acct-9' } },
					},
				},
			},
		},
	}));
	assert.ok(auth);
	assert.equal(auth.accessToken, 'acc-1');
	assert.equal(auth.refreshToken, 'ref-1');
	assert.equal(auth.accountId, 'acct-9');
	assert.equal(auth.expiresAt, 1_791_164_000_000);
	assert.equal(cline.parseClineProvidersJson('not json'), undefined);
});

test('cline identity headers: the full desktop-client set', () => {
	const headers = cline.clineIdentityHeaders('acct-9', 'cline-sdk', '4.1.22');
	assert.equal(headers.clineUserId, 'acct-9');
	assert.equal(headers['X-CLIENT-TYPE'], 'cline-sdk');
	assert.equal(headers['X-CLIENT-VERSION'], '4.1.22');
	assert.equal(headers['User-Agent'], 'Cline/4.1.22');
	assert.equal(headers['HTTP-Referer'], 'https://cline.bot');
});

test('cline session id: stable per conversation, 32 hex', () => {
	const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
	assert.equal(cline.deriveClineSession(body), cline.deriveClineSession({ ...body }));
	assert.match(cline.deriveClineSession(body), /^[0-9a-f]{32}$/);
	assert.notEqual(cline.deriveClineSession(body), cline.deriveClineSession({ model: 'other', messages: body.messages }));
});

test('SSE parser: comments, CRLF, multi-line data and [DONE]', () => {
	const parser = new SseParser();
	let events = [];
	for (const event of parser.push(': keep-alive\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\n')) {
		events.push(event);
	}
	assert.equal(events.length, 2);
	assert.equal(events[0].data, '{"a":1}');
	assert.equal(events[1].data, 'line1\nline2');
	events = parser.push('data: [DONE]\n\n');
	assert.equal(events.length, 1);
	assert.ok(isDoneEvent(events[0].data));
	assert.ok(!isDoneEvent('{"x":1}'));
});

test('canonicalModelKey: same model across sources groups into one key', () => {
	assert.equal(canonicalModelKey('qwen/qwen3.8-27b:free'), 'qwen3.8-27b');
	assert.equal(canonicalModelKey('cline-free/mimo-v2.6-flash'), 'mimo-v2.6-flash');
	assert.equal(canonicalModelKey('mimo-v2.6-flash-free'), 'mimo-v2.6-flash');
	assert.equal(canonicalModelKey('nvidia/nemotron-3.5-lightning:free'), 'nemotron-3.5-lightning');
	assert.equal(canonicalModelKey('qwen3.8-27b'), 'qwen3.8-27b');
	// Conservative: no `:free` suffix → the org prefix stays (distinct model).
	assert.equal(canonicalModelKey('stealth/space-bunny-alpha'), 'stealth/space-bunny-alpha');
	// Variant suffixes stay distinct.
	assert.equal(canonicalModelKey('ling-3.0-flash-fin-free'), 'ling-3.0-flash-fin');
});

test('freeVerdict: probed-unusable ids are excluded even when metadata says free', () => {
	// Live probed 2026-10-06: HTTP 400 "Model is unavailable" on the anonymous lane.
	assert.equal(opencode.freeVerdict('deepseek-v4-flash-free', { cost: { input: 0, output: 0 } }), false);
	// Live probed 2026-10-06: HTTP 500 (SystemOne endpoint, no chat-completions lane).
	assert.equal(opencode.freeVerdict('jev-1.13-free', undefined), false);
	// Verified roster passes regardless of metadata.
	assert.equal(opencode.freeVerdict('big-pickle', undefined), true);
	// Deprecation beats even the verified roster.
	assert.equal(opencode.freeVerdict('big-pickle', { deprecated: true }), false);
	// Name fallback for unknown -free ids; paid models excluded.
	assert.equal(opencode.freeVerdict('some-future-model-free', undefined), true);
	assert.equal(opencode.freeVerdict('paid-model', { cost: { input: 1, output: 2 } }), false);
});

test('catalog: canonical groups, failover candidates and stable sort', () => {
	const settings = {
		debug: false,
		atomcode: { enabled: true, home: '', hosts: [], clientVersion: '', models: [], allowRefresh: false },
		opencode: { enabled: true, baseUrl: 'https://opencode.ai/zen', refreshSeconds: 300 },
		cline: { enabled: true, baseUrl: '', home: '', clientType: '', clientVersion: '', allowRefresh: false, includeClinePass: false },
	};
	const catalog = new Catalog(settings);
	const groups = catalog.current();
	const keys = groups.map((g) => g.key);
	assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)), 'groups must be sorted by canonical key');

	// mimo-v2.6-flash: opencode static + cline static group into one entry.
	const mimo = catalog.resolve('mimo-v2.6-flash');
	assert.ok(mimo);
	assert.equal(mimo.candidates.length, 2);
	assert.deepEqual(mimo.candidates.map((c) => c.meta.source), ['opencode', 'cline']);
	// qwen3.8-27b: atomcode + cline group into one entry.
	const qwen = catalog.resolve('qwen3.8-27b');
	assert.ok(qwen);
	assert.equal(qwen.candidates.length, 2);
	assert.deepEqual(qwen.candidates.map((c) => c.meta.source), ['cline', 'atomcode']);
	// Legacy "source/id" ids from an old session resolve to their group.
	assert.ok(catalog.resolve('opencode/mimo-v2.6-flash-free'));
	assert.ok(catalog.resolve('cline/cline-free/mimo-v2.6-flash'));
	assert.equal(catalog.resolve('does-not-exist'), undefined);
	// Merged capabilities: intersection, not union.
	assert.equal(mimo.meta.imageInput, undefined, 'cline candidate has no imageInput — intersection must drop it');
});
