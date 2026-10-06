# opencodecline2copilot

**Use the free models behind OpenCode, Cline and AtomCode directly in GitHub Copilot Chat.**

This is a VS Code extension — no local proxy server to babysit. It registers a
BYOK language-model provider, so the free lanes of the three coding tools show
up as normal entries in the Copilot Chat model picker, with agent mode, tool
calling, MCP and everything else Copilot gives you.

| Source | Free models | Auth | Lane |
| --- | --- | --- | --- |
| **AtomCode** (AtomGit CodingPlan) | `qwen3.8-27b`, `glm5.3-flash`, more auto-discovered from the CLI's `config.toml` | Your own AtomCode CLI login (`atomcode login` → `~/.atomcode/auth.toml`), requests signed with `atomcode-signing-v1` | `llm-api.atomgit.com/v1` (failover: `api-ai.gitcode.com/v1`) |
| **OpenCode Zen** anonymous lane | `big-pickle`, `mimo-v2.6-flash-free`, `ling-3.1-flash-free`, `nemotron-3.5-lightning-free`, … (live-discovered) | None — anonymous lane dressed as the OpenCode CLI | `opencode.ai/zen/v1` |
| **Cline** (desktop account) | `cline-free/deepseek-v4.1-flash`, `cline-free/mimo-v2.6-flash`, `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3.5-lightning:free`, … (20+ live-discovered) | Your own Cline desktop login (`~/.cline/data/settings/providers.json`), full client identity header set | `api.cline.bot/api/v1` |

Free catalogs are discovered live and fall back to a verified static roster
when the network (or your login state) is unavailable.

## Why an extension?

Inspired by [deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot):
instead of running a separate gateway process and pointing Copilot at a
custom OpenAI endpoint, the extension plugs into the same provider API Copilot
Chat itself uses. Zero runtime dependencies — pure VS Code API + Node built-ins.

The upstream acquisition logic (AtomCode request signing, Zen anonymous-lane
shape, Cline identity headers, free-catalog discovery) follows the approach of
the author's local gateway project *freegw*; the signing algorithm was
independently documented by the MIT-licensed atomgit-opencode-bridge /
Atom2Api projects. The free-verdict discipline (metadata first, deprecated
models never, verify-before-promote) follows
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh).

## One entry per model, not per source

The same model sold under different ids across sources — AtomCode
`qwen3.8-27b`, Cline `qwen/qwen3.8-27b:free`, Zen `mimo-v2.6-flash-free` vs
Cline `cline-free/mimo-v2.6-flash` — is advertised **once** under a canonical
id. Each entry's candidate chain spans every source carrying the model, and a
request fails over across the chain (rotating AtomCode's hosts first). The
picker is sorted by canonical id for a stable order.

## Keeping actually-free models only

Metadata cannot always be trusted (models.dev marks `deepseek-v4-flash-free`
cost 0, yet the anonymous lane answers `400 Model is unavailable` — it is free
only for authenticated Zen accounts). Models that look free but fail a live
probe of the anonymous lane are blocklisted:

| Blocked id | Reason (probed 2026-10-06) |
| --- | --- |
| `deepseek-v4-flash-free` | HTTP 400 "Model is unavailable" on the anonymous lane |
| `jev-1.13-free` | HTTP 500 — rides the SystemOne endpoint, not chat completions |
| `muse-spark-*` | Responses-API-only lane |

## Getting started

### Prerequisites

- VS Code 1.116 or later with GitHub Copilot Chat (the free Copilot tier works)
- Per source:
  - **AtomCode** — install the [AtomCode CLI](https://atomcode.atomgit.com) and run `atomcode login`
  - **OpenCode** — nothing; the Zen free lane is anonymous
  - **Cline** — install the Cline desktop app and sign in (keep it logged in)

### Install & use

1. Build a VSIX (or grab one from Releases):
   ```sh
   npm install && npm run compile && npm run package   # -> dist/opencodecline2copilot-<ver>.vsix
   ```
2. Install it: `code --install-extension dist/opencodecline2copilot-<ver>.vsix`
3. Open Copilot Chat, click the model picker, and pick models under
   **OpenCode · Cline · AtomCode**.

If a source is missing, run **Free Models: Show Source Status** from the
Command Palette — it tells you exactly which login file the extension looked
for and what went wrong. **Free Models: Refresh Model Catalog** re-scans the
live catalogs.

## Settings

All under `opencodecline.*`:

| Setting | Default | Description |
| --- | --- | --- |
| `sources.atomcode.enabled` | `true` | Expose AtomCode models |
| `sources.opencode.enabled` | `true` | Expose OpenCode Zen models |
| `sources.cline.enabled` | `true` | Expose Cline models |
| `atomcode.home` | `""` | AtomCode home dir (`~/.atomcode`, honours `ATOMCODE_HOME`) |
| `atomcode.hosts` | llm-api / api-ai | AtomGit LLM gateway hosts, tried in order |
| `atomcode.clientVersion` | `""` | `X-AtomCode-Ver` value (empty = verified default `5.2.1`) |
| `atomcode.allowRefresh` | `true` | Mint fresh access tokens via `acs.atomgit.com/oauth/refresh` when stale |
| `atomcode.models` | `[]` | Model id allowlist (empty = all discovered) |
| `opencode.baseUrl` | `https://opencode.ai/zen` | Zen base URL |
| `opencode.refreshSeconds` | `300` | Catalog refresh cadence |
| `cline.home` | `""` | Cline desktop home dir (`~/.cline`, honours `CLINE_HOME`) |
| `cline.baseUrl` | `https://api.cline.bot/api/v1` | Cline API base URL |
| `cline.clientType` / `cline.clientVersion` | `""` | Identity header values (empty = verified defaults) |
| `cline.allowRefresh` | `true` | Mint fresh access tokens when the file token is stale (never kicks the desktop session) |
| `cline.includeClinePass` | `false` | Also expose the subscription-gated `clinePass` bucket |
| `debug` | `false` | Verbose logging (Output: "Free Models for Copilot") |

## Notes & limitations

- Free lanes are **limited-time offers** of the respective services and can
  change or disappear at any moment; models are rate-limited by the upstreams.
- The picker reflects each source's **live catalog** once it answers; the
  built-in static roster is only a cold-start/failure fallback, so delisted
  models disappear instead of lingering.
- AtomCode/Cline request the **credentials of your own logged-in CLI/desktop
  session**; tokens are read from disk per request, minted refresh tokens live
  in memory only, and the CLI/desktop apps keep owning their auth files.
- The OpenCode anonymous lane may log/free-tier-throttle by client identity;
  heavy use can get your IP cooled down.
- Images are only offered to models with `imageInput` capability; thinking
  output is surfaced as Copilot "thinking" parts when the upstream sends it.

Use at your own discretion and respect the terms of service of AtomCode,
OpenCode and Cline.

## License

[MIT](LICENSE)
