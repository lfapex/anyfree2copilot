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
const freegw = require('../out/sources/freegw.js');
const { canonicalModelKey, Catalog, PLATFORMS } = require('../out/sources/index.js');
const { SseParser, isDoneEvent } = require('../out/sse.js');
const { truncateHistory, estimateMessageTokens } = require('../out/truncate.js');

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

test('freegw: display names prettified from upstream ids', () => {
	assert.equal(freegw.prettifyModelName('cline-free/mimo-v2.6-flash'), 'MiMo V2.6 Flash');
	assert.equal(freegw.prettifyModelName('atomcode/glm5.3-flash'), 'GLM5.3 Flash');
	assert.equal(freegw.prettifyModelName('qwen/qwen3.8-27b:free'), 'Qwen3.8 27b');
	assert.equal(freegw.prettifyModelName('nemotron-3.5-lightning-free'), 'Nemotron 3.5 Lightning');
	assert.equal(freegw.prettifyModelName('main-coder'), 'Main Coder');
	assert.equal(freegw.prettifyModelName('big-pickle'), 'Big Pickle');
});

test('freegw: prepare sends the exposed id to the local gateway', async () => {
	const source = new freegw.FreeGWSource({ enabled: true, baseUrl: 'http://127.0.0.1:8484/v1/', apiKey: 'sk-test' });
	const prepared = await source.prepare('atomcode/glm5.3-flash', { model: 'ignored', messages: [{ role: 'user', content: 'hi' }], stream: true });
	assert.equal(prepared.url, 'http://127.0.0.1:8484/v1/chat/completions');
	assert.equal(prepared.via, 'freegw@local');
	assert.equal(prepared.forceStream, false);
	const body = JSON.parse(prepared.body);
	assert.equal(body.model, 'atomcode/glm5.3-flash');
	assert.equal(prepared.headers.authorization, 'Bearer sk-test');

	const noAuth = new freegw.FreeGWSource({ enabled: true, baseUrl: 'http://127.0.0.1:8484', apiKey: '' });
	const openPrepared = await noAuth.prepare('x', { model: 'x', messages: [] });
	assert.equal(openPrepared.headers.authorization, undefined);
	assert.equal(openPrepared.url, 'http://127.0.0.1:8484/v1/chat/completions');
});

test('freegw: catalog keeps only virtual rows, chains carried through', async () => {
	const rows = {
		data: [
			// Non-virtual rows belong to the platform sections — dropped here.
			{ id: 'atomcode/glm5.3-flash', owned_by: 'atomcode', freegw: { source: 'atomcode', upstream_id: 'glm5.3-flash', context_window: 512000, supports_tools: true } },
			{ id: 'big-pickle', owned_by: 'opencode', freegw: { source: 'opencode', upstream_id: 'big-pickle' } },
			// Virtual rows: id + merged capabilities + the failover chain.
			{ id: 'main-coder', owned_by: 'virtual', freegw: { source: 'virtual', context_window: 262144, max_output: 65536, supports_tools: true, image_input: true, reasoning: true, candidates: [{ source: 'atomcode', id: 'glm5.3-flash' }, { source: 'opencode', id: 'big-pickle' }] } },
			{ id: 'fallback', owned_by: 'virtual', freegw: { source: 'virtual' } },
			{ id: '', freegw: { source: 'virtual' } },
			{ freegw: {} },
		],
	};
	const fetchCalls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		fetchCalls.push({ url, init });
		return { ok: true, json: async () => rows };
	};
	try {
		const source = new freegw.FreeGWSource({ enabled: true, baseUrl: 'http://127.0.0.1:8484', apiKey: '', refreshSeconds: 300 });
		const models = await source.models();
		assert.deepEqual(models.map((m) => m.id), ['main-coder', 'fallback']);
		assert.equal(models[0].source, 'freegw');
		assert.equal(models[0].name, 'Main Coder (FreeGW)');
		assert.equal(models[0].contextWindow, 262144);
		assert.equal(models[0].reasoning, true);
		assert.deepEqual(models[0].chain, ['atomcode/glm5.3-flash', 'opencode/big-pickle']);
		assert.equal(models[1].supportsTools, true); // default when metadata omits it
		assert.equal(fetchCalls[0].url, 'http://127.0.0.1:8484/v1/models');
		// Second call inside the refresh window is served from cache.
		assert.equal((await source.models()).length, 2);
		assert.equal(fetchCalls.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
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

test('catalog: per-platform sections, canonical dedup and stable sort', () => {
	const settings = {
		debug: false,
		atomcode: { enabled: true, home: '', hosts: [], clientVersion: '', models: [], allowRefresh: false },
		opencode: { enabled: true, baseUrl: 'https://opencode.ai/zen', refreshSeconds: 300 },
		cline: { enabled: true, baseUrl: '', home: '', clientType: '', clientVersion: '', allowRefresh: false, includeClinePass: false },
		freegw: { enabled: true, baseUrl: 'http://127.0.0.1:8484', apiKey: '', refreshSeconds: 120 },
	};
	const catalog = new Catalog(settings);

	// opencode / atomcode sections are sorted by canonical key.
	for (const source of ['opencode', 'atomcode']) {
		const keys = catalog.currentFor(source).map((g) => g.key);
		assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)), `${source} must be sorted by canonical key`);
	}

	// Cline section: the promo free fleet ("Try with limited usage at no
	// cost") is pinned to the top, the rest sorts by canonical key.
	const clineKeys = catalog.currentFor('cline').map((g) => g.key);
	assert.equal(clineKeys[0], 'mimo-v2.6-flash', 'the promo fleet entry must be first');
	const clineRest = clineKeys.slice(1); // static roster carries exactly one promo entry
	assert.deepEqual(clineRest, [...clineRest].sort((a, b) => a.localeCompare(b)), 'non-promo cline entries must be sorted');

	// Platform section order: OpenCode, AtomCode, Cline, FreeGW.
	assert.deepEqual(PLATFORMS.map((p) => p.source), ['opencode', 'atomcode', 'cline', 'freegw']);

	// FreeGW has no static roster: cold start (gateway not yet asked) is empty.
	assert.deepEqual(catalog.currentFor('freegw'), []);

	// Within a platform, decorated variants dedup into one canonical entry.
	const clineMimo = catalog.resolveFor('cline', 'mimo-v2.6-flash');
	assert.ok(clineMimo);
	assert.equal(clineMimo.candidates.length, 1);
	assert.equal(clineMimo.candidates[0].meta.source, 'cline');
	// The same underlying model lives under its own platform's section too.
	const openMimo = catalog.resolveFor('opencode', 'mimo-v2.6-flash');
	assert.ok(openMimo);
	assert.equal(openMimo.candidates[0].meta.source, 'opencode');
	// qwen3.8-27b exists on both atomcode and cline, as separate sections.
	assert.ok(catalog.resolveFor('atomcode', 'qwen3.8-27b'));
	assert.ok(catalog.resolveFor('cline', 'qwen3.8-27b'));
	// Legacy "source/id" ids from an old session still resolve on their platform.
	assert.ok(catalog.resolveFor('cline', 'cline/cline-free/mimo-v2.6-flash'));
	assert.ok(catalog.resolveFor('opencode', 'opencode/mimo-v2.6-flash-free'));
	// Cross-platform ids do not leak into the wrong section.
	assert.equal(catalog.resolveFor('opencode', 'qwen3.8-27b'), undefined);
	assert.equal(catalog.resolveFor('opencode', 'does-not-exist'), undefined);
	assert.ok(catalog.totalCount > 0);
});

test('estimateMessageTokens: text, tool calls and images all count', () => {
	const plain = estimateMessageTokens({ role: 'user', content: 'aaaa' });
	assert.equal(plain, 5); // 4 overhead + ceil(4/4)
	const withTool = estimateMessageTokens({
		role: 'assistant',
		content: 'bbbb',
		tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
	});
	assert.equal(withTool, 11); // 4 + 1 + (ceil((2+1+2)/4) + 4)
	const withImage = estimateMessageTokens({
		role: 'user',
		content: [
			{ type: 'text', text: 'aaaa' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
		],
	});
	assert.equal(withImage, 1105); // 4 + 1 + 1100
});

test('estimateMessageTokens: CJK text counts ~1 token per char', () => {
	const cjk = estimateMessageTokens({ role: 'user', content: '你好世界，测试！' });
	assert.equal(cjk, 12); // 4 overhead + 8 CJK chars incl. fullwidth punctuation
	const mixed = estimateMessageTokens({ role: 'user', content: 'abc你好' });
	assert.equal(mixed, 7); // 4 + 2 CJK + ceil(3/4)
});

test('truncateHistory: under budget returns the same array', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 100_000, maxOutput: 0 };
	const out = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	assert.equal(truncateHistory(out, meta), out);
});

test('truncateHistory: drops oldest turns at user boundaries, tool groups whole', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 70, maxOutput: 0 };
	const a = { role: 'user', content: 'aaaa' };
	const b = { role: 'assistant', content: 'bbbb', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
	const c = { role: 'tool', content: 'cccc', tool_call_id: 'c1' };
	const d = { role: 'assistant', content: 'dddd' };
	const e = { role: 'user', content: 'e'.repeat(200) };
	const f = { role: 'assistant', content: 'ffff' };
	const g = { role: 'user', content: 'gggg' };
	const result = truncateHistory([a, b, c, d, e, f, g], meta);
	// 91 tokens total; budget 70. The first message (original task) is
	// protected: keep a + the first user-boundary tail that fits with it —
	// e,f,g = 64 tokens, 5 + 64 = 69 <= 70 — and the b..d tool group is
	// dropped whole.
	assert.deepEqual(result, [a, e, f, g]);
	assert.equal(result[0].role, 'user');
});

test('truncateHistory: first message protected even when it forces a bigger cut', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 42, maxOutput: 0 };
	const p = { role: 'user', content: 'a'.repeat(20) };
	const q = { role: 'assistant', content: 'b'.repeat(20) };
	const r = { role: 'user', content: 'c'.repeat(20) };
	const s = { role: 'assistant', content: 'd'.repeat(20) };
	const t = { role: 'user', content: 'e'.repeat(20) };
	const v = { role: 'assistant', content: 'f'.repeat(20) };
	// 54 tokens total, budget 42. Without protecting p the cut lands at r
	// (tail 36 <= 42); reserving p's 9 tokens pushes it to t (9 + 18 = 27).
	const result = truncateHistory([p, q, r, s, t, v], meta);
	assert.deepEqual(result, [p, t, v]);
});

test('truncateHistory: falls back to first + current prompt when no boundary fits', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 30, maxOutput: 0 };
	const first = { role: 'user', content: 'a'.repeat(40) };
	const mid = { role: 'assistant', content: 'b'.repeat(40) };
	const last = { role: 'user', content: 'c'.repeat(40) };
	// 42 tokens total, budget 30; the only user boundary (index 0) is never a
	// cut, so nothing between first and last can be dropped piecemeal.
	// first + last = 28 <= 30 -> the task and the current prompt survive.
	const result = truncateHistory([first, mid, last], meta);
	assert.deepEqual(result, [first, last]);
});

test('truncateHistory: assistant lead is not protected across the cut', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 30, maxOutput: 0 };
	const lead = { role: 'assistant', content: 'a'.repeat(20) };
	const mid = { role: 'user', content: 'b'.repeat(20) };
	const tail = { role: 'assistant', content: 'c'.repeat(20) };
	const last = { role: 'user', content: 'd'.repeat(20) };
	// 36 tokens total, budget 30; the tail from mid is 27 <= 30 and an
	// assistant lead is not re-attached, so the plain cut applies.
	const result = truncateHistory([lead, mid, tail, last], meta);
	assert.deepEqual(result, [mid, tail, last]);
});

test('truncateHistory: keeps the current prompt even when alone over budget', () => {
	const meta = { id: 'm', source: 'opencode', contextWindow: 1, maxOutput: 0 };
	const out = [
		{ role: 'user', content: 'first turn, very long'.repeat(50) },
		{ role: 'assistant', content: 'answer' },
		{ role: 'user', content: 'current prompt' },
	];
	const result = truncateHistory(out, meta);
	assert.equal(result.length, 1);
	assert.deepEqual(result[0], out[2]);
});
