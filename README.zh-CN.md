# AI Session Search

[English](./README.md) | 简体中文

[![GitHub Release](https://img.shields.io/github/v/release/lililib/ai-session-search)](https://github.com/lililib/ai-session-search/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

本地优先的 AI 编程会话搜索与上下文管理工具。自动发现多种编程工具的本地会话，并使用
SQLite FTS5 trigram 索引搜索自然语言、代码、路径、错误信息、标题和 Session ID；来源
会话始终保持只读。

![AI Session Search 界面](./docs/images/ai-session-search.png)

## 主要功能

- 跨来源、项目全文搜索，支持中文、日文、韩文、英文和代码子串
- 空格分隔多个关键词可逐步缩小范围，即使关键词分散在同一会话的不同消息中也能找到
- 上下文库支持整段内容的保存、搜索、分类和复制
- 收藏、重命名、收藏夹、筛选及可调整宽度的导航栏
- 复制 Session ID、自定义恢复命令或在支持的终端中直接恢复
- 后台增量索引、文件变化监听和自定义会话来源路径
- Web/桌面端共用数据，界面自动切换简体中文或英文

无需 API Key 或云端数据库。用户元数据和索引只保存在应用自己的 SQLite 数据库中。

## 桌面版

从 [GitHub Releases](https://github.com/lililib/ai-session-search/releases) 下载便携版：

- macOS Apple Silicon：`darwin-arm64.zip`
- macOS Intel：`darwin-x64.zip`
- Windows 10/11 x64：`AI.Session.Search-win32-x64-<version>.zip`

解压后直接运行，无需安装 Node.js。当前发布包尚未签名，首次打开时 macOS Gatekeeper
或 Windows SmartScreen 可能显示提示。

## 搜索语法

使用空格分隔记得的零散关键词，结果必须在同一个会话中包含全部关键词；关键词可以分别出现
在不同消息、标题或 Session ID 中。包含空格的完整短语使用引号包裹：

```text
推送 家中服务器
推送 "GitHub Actions" "home server"
35cb2091 部署
```

## 支持的客户端

| ID | 客户端 | 默认目录 |
| --- | --- | --- |
| `claude` | Claude Code | `~/.claude` |
| `codex` | Codex | `~/.codex` |
| `antigravity` | Antigravity | `~/.gemini` |
| `opencode` | OpenCode | `~/.local/share/opencode` |
| `copilot` | GitHub Copilot CLI | `~/.copilot` |
| `cursor` | Cursor | `~/.cursor` |
| `kimi` | Kimi Code | `~/.kimi-code` |

在“会话来源”中可以修改路径或启用/禁用客户端，无需重启。界面中保存的设置优先于 CLI
参数、环境变量和平台默认路径。

## Web / CLI

要求 Node.js 24+ 和 pnpm 11：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

打开 `http://localhost:3411`。

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `-p, --port <port>` | `PORT` | `3411` |
| `-h, --hostname <hostname>` | `HOSTNAME` | `localhost` |
| `--claude-dir <path>` | `AI_SESSION_CLAUDE_HOME` / `CLAUDE_CONFIG_DIR` | `~/.claude` |
| `--codex-dir <path>` | `AI_SESSION_CODEX_HOME` / `CODEX_HOME` | `~/.codex` |
| `--provider-dir <provider=path>` | `AI_SESSION_<PROVIDER>_HOME` | 来源默认目录 |
| `--data-dir <path>` | `AI_SESSION_DATA_DIR` / `XDG_DATA_HOME` | 平台应用数据目录 |
| `--providers <ids>` | `AI_SESSION_PROVIDERS` | `auto` |
| `--no-watch` | — | 默认监听文件变化 |

默认数据目录在 macOS 为 `~/Library/Application Support/ai-session-search`，Windows 为
`%LOCALAPPDATA%\\ai-session-search`，Linux 为 `~/.local/share/ai-session-search`，Web 与桌面端共用。

## 开发

```bash
corepack pnpm dev
corepack pnpm desktop:start
corepack pnpm desktop:make
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

搜索架构参考并改编自
[d-kimuson/claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer)。详见
[NOTICE.md](./NOTICE.md)。项目采用 [MIT License](./LICENSE)。
