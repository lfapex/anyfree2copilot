# anyfree2copilot

**把 OpenCode、Cline、AtomCode 背后的免费模型直接搬进 GitHub Copilot Chat。**

这是一个 VS Code 扩展——不需要再单独跑一个本地网关进程。它**按平台各注册一个**
BYOK 语言模型 provider，三家的免费通道在 Copilot Chat 模型选择器里各自成区——
**OpenCode Zen (Free)**、**Cline (Free)**、**AtomCode (Free)**——agent 模式、
工具调用、MCP 等 Copilot 全部能力照常可用。

| 来源 | 免费模型 | 鉴权 | 通道 |
| --- | --- | --- | --- |
| **AtomCode**（AtomGit CodingPlan） | `qwen3.8-27b`、`glm5.3-flash` 等，自动从 CLI 的 `config.toml` 发现 | 你自己已登录的 AtomCode CLI（`atomcode login` → `~/.atomcode/auth.toml`），请求带 `atomcode-signing-v1` 签名 | `llm-api.atomgit.com/v1`（故障切换：`api-ai.gitcode.com/v1`） |
| **OpenCode Zen** 匿名通道 | `big-pickle`、`mimo-v2.6-flash-free`、`ling-3.1-flash-free`、`nemotron-3.5-lightning-free` 等（在线发现） | 无需账号，伪装成 OpenCode CLI 的匿名通道 | `opencode.ai/zen/v1` |
| **Cline**（桌面端账号） | `cline-free/deepseek-v4.1-flash`、`cline-free/mimo-v2.6-flash`、`qwen/qwen3.8-27b:free`、`nvidia/nemotron-3.5-lightning:free` 等（20+ 在线发现） | 你自己已登录的 Cline 桌面端（`~/.cline/data/settings/providers.json`），完整客户端身份头 | `api.cline.bot/api/v1` |

免费模型目录在线发现，网络或登录态不可用时回退到内置验证过的静态名单。

## 为什么做成扩展？

参考 [deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)：
不用再跑一个独立网关进程、再让 Copilot 指向自定义 OpenAI 端点，扩展直接接入
Copilot Chat 自身使用的 provider API。零运行时依赖——纯 VS Code API + Node 内置模块。

上游获取逻辑（AtomCode 请求签名、Zen 匿名通道请求形状、Cline 身份头、免费目录发现）
沿用作者的本地网关项目 *freegw* 的方案；签名算法由 MIT 协议的
atomgit-opencode-bridge / Atom2Api 项目独立公开。免费判定纪律（元数据优先、
deprecated 一票否决、先验证后暴露）参考
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh)。

## 每个平台一个分区

每个平台在模型选择器里独立成区，找模型一目了然。分区内部，同一上游 ID 的装饰
变体会合并为一个规范条目（Cline `cline-free/mimo-v2.6-flash` 与
`vendor/mimo-v2.6-flash:free`），条目按规范 ID 字母序稳定排列；请求先在平台内
重试（AtomCode 会轮换网关地址），失败才报错。同一个模型出现在多个平台的分区里
是有意为之——想用哪家的通道就选哪个。

## 只保留真正免费的模型

元数据不可全信（models.dev 给 `deepseek-v4-flash-free` 标价 0，但匿名通道实测
返回 `400 Model is unavailable`——它只对认证的 Zen 账号免费）。形似免费但匿名
通道实测不可用的模型会被拉黑：

| 拉黑 ID | 原因（2026-10-06 实测） |
| --- | --- |
| `deepseek-v4-flash-free` | 匿名通道 HTTP 400 "Model is unavailable" |
| `jev-1.13-free` | HTTP 500 —— 走 SystemOne 专用端点，非 chat completions |
| `muse-spark-*` | 仅 Responses API 通道 |

## 快速开始

### 前置条件

- VS Code 1.116+，装好 GitHub Copilot Chat（Copilot 免费档即可）
- 按来源：
  - **AtomCode** — 安装 [AtomCode CLI](https://atomcode.atomgit.com) 并执行 `atomcode login`
  - **OpenCode** — 什么都不用装，Zen 免费通道是匿名的
  - **Cline** — 安装 Cline 桌面应用并登录（保持登录状态）

### 安装与使用

1. 构建 VSIX（或直接到 Releases 下载）：
   ```sh
   npm install && npm run compile && npm run package   # -> dist/anyfree2copilot-<ver>.vsix
   ```
2. 安装：`code --install-extension dist/anyfree2copilot-<ver>.vsix`
3. 打开 Copilot Chat，点开模型选择器，从 **OpenCode Zen (Free)**、
   **Cline (Free)** 或 **AtomCode (Free)** 分区里选模型。

如果某个来源没出现，在命令面板运行 **AnyFree: Show Source Status**，
它会告诉你扩展在找哪个登录文件、出了什么问题；**AnyFree: Refresh Model Catalog**
会重新扫描在线目录。

## 设置

全部位于 `anyfree.*`：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sources.atomcode.enabled` | `true` | 暴露 AtomCode 模型 |
| `sources.opencode.enabled` | `true` | 暴露 OpenCode Zen 模型 |
| `sources.cline.enabled` | `true` | 暴露 Cline 模型 |
| `atomcode.home` | `""` | AtomCode 主目录（`~/.atomcode`，尊重 `ATOMCODE_HOME`） |
| `atomcode.hosts` | llm-api / api-ai | AtomGit LLM 网关地址，按序尝试 |
| `atomcode.clientVersion` | `""` | `X-AtomCode-Ver` 取值（留空 = 验证过的默认 `5.2.1`） |
| `atomcode.allowRefresh` | `true` | 令牌过期时通过 `acs.atomgit.com/oauth/refresh` 换新 |
| `atomcode.models` | `[]` | 模型 ID 白名单（空 = 全部发现） |
| `opencode.baseUrl` | `https://opencode.ai/zen` | Zen 基础地址 |
| `opencode.refreshSeconds` | `300` | 目录刷新周期（秒） |
| `cline.home` | `""` | Cline 桌面端主目录（`~/.cline`，尊重 `CLINE_HOME`） |
| `cline.baseUrl` | `https://api.cline.bot/api/v1` | Cline API 基础地址 |
| `cline.clientType` / `cline.clientVersion` | `""` | 身份头取值（留空 = 验证过的默认值） |
| `cline.allowRefresh` | `true` | 文件令牌过期时换新（不会踢掉桌面端会话） |
| `cline.includeClinePass` | `false` | 同时暴露订阅制的 `clinePass` 模型桶 |
| `debug` | `false` | 详细日志（输出面板："AnyFree for Copilot"） |

## 注意与限制

- 免费通道是各服务的**限时政策**，随时可能调整或下线；上游本身有限流。
- 目录以各来源的**在线名单**为准；内置静态名单只用于冷启动/故障兜底，
  上游下架的模型会随之消失，不会一直残留。
- AtomCode/Cline 使用**你自己已登录的 CLI/桌面端凭证**；每次请求时从磁盘读取，
  换发的令牌只存内存，CLI/桌面应用始终拥有自己的鉴权文件。
- OpenCode 匿名通道按客户端身份限流，重度使用可能触发冷却。
- 图片仅提供给具备 `imageInput` 能力的模型；上游返回的思维链会作为 Copilot
  的 thinking 部分展示。

请自行斟酌使用，并遵守 AtomCode、OpenCode、Cline 的服务条款。

## 许可证

[MIT](LICENSE)
