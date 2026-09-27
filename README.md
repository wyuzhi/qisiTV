<p align="center">
  <img src="assets/readme/qisitv-wordmark.svg" width="640" alt="qisiTV — 本地优先、轻量、AI Native 的视频创作工作台">
</p>

<p align="center">Local-first, lightweight, AI-native video workspace.</p>

<p align="center">
  <a href="QUICKSTART.md">快速开始</a> ·
  <a href="docs/content/docs/overview/features.mdx">功能清单</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a> ·
  <a href="SECURITY.md">安全策略</a>
</p>

qisiTV 是一个开源的 AI 视频创作工作台，专注三个方向：

- **本地优先**：项目、画布、素材和任务默认保存在本机。
- **轻量**：单用户桌面应用优先，不依赖账号、团队 SaaS 或云存储。
- **AI Native**：用自由画布组织文字、图片、音频和视频生成与编辑流程。

## 产品演示

![qisiTV 本地 Agent 画布](assets/readme/qisitv-workspace.png)

> 项目仍在快速开发。数据结构和外部接口可能变化，建议在个人本地或可信环境中使用，不要将本地 workspace API 直接暴露到公网。

## 核心能力

- 自由画布：节点、连线、框选、缩放、小地图、撤销重做和本地导入导出。
- 多媒体生成：文本、图片、视频和音频任务，支持参考素材与批量生成。
- 创作工作流：剧本、角色、场景、分镜、时间线和字幕。
- 任务与素材：本地异步队列、取消、重试、日志、素材库和引用校验。
- 模型渠道：用户在本地配置文本、图片、视频和音频 Provider。
- 本地 Agent：通过 MCP 或 `qisitv` CLI 在 Codex 等工具中对话、操作画布和回填结果。

完整范围见[功能清单](docs/content/docs/overview/features.mdx)。

## 快速开始

### 环境要求

- [Bun](https://bun.sh/)
- [Go 1.25](https://go.dev/)
- macOS 桌面构建需要 Wails 所需的系统工具链
- Docker Compose 仅在使用容器时需要

### 桌面应用

```bash
git clone <repository-url> qisiTV
cd qisiTV
QISITV_GO_DIR=/path/to/go ./scripts/build-qisitv-release.sh
open backend/cmd/desktop/build/bin/qisiTV.app
```

Windows amd64 在 Windows 本机执行 `scripts/build-qisitv-windows-release.ps1`。产物是 `backend\cmd\desktop\build\bin\qisiTV.exe` 和旁边的 `plugin-packages\`。前提见 [`docs/desktop-release.md`](docs/desktop-release.md)。

首次启动后，在“模型配置”中添加自己的模型渠道。渠道可能连接外部供应商，但 qisiTV 本身不要求云端账号。

### Web 本地开发

```bash
# 终端一：后端
cd backend
CANVAS_BACKEND_ADDR=127.0.0.1:8080 \
CANVAS_BACKEND_DATA_DIR=../.local/workspace \
go run ./cmd/server

# 终端二：前端
cd web
bun install --frozen-lockfile
bun run dev
```

打开 <http://localhost:3000>。前端默认将 `/api` 代理到 `http://127.0.0.1:8080`；可通过 `VITE_API_PROXY_TARGET` 调整。

更多启动方式见 [`QUICKSTART.md`](QUICKSTART.md) 和[本地开发文档](docs/content/docs/backend/local-development.mdx)。

## 架构

```text
React / Wails UI
  ├─ Canvas, projects, assets and task center
  ├─ Zustand / localForage local state
  └─ Loopback HTTP + SSE
            │
            ▼
Go local backend
  ├─ Application and domain services
  ├─ SQLite and local asset storage
  ├─ Durable task workers
  └─ Provider adapters for user-configured model APIs
```

Wails 发布包内嵌前端静态资源，Go API 只应监听 loopback。详见[本地优先架构](docs/local-first-architecture.md)。

## 验证

```bash
cd web
bun run lint
bun test
bun run build

cd ..
sh plugin-packages/build-packages.sh
cd backend
go test ./...
```

## 安全与隐私

- 不要将本地 API 直接暴露到公网。
- 不要提交 API Key、Cookie、数据库、日志或本机配置。
- 使用真实密钥时，仅连接信任的 Provider 和 HTTPS 端点。
- 安全问题请按 [`SECURITY.md`](SECURITY.md) 报告，不要在公开 Issue 中粘贴敏感数据。

## 贡献

欢迎提交 Issue 和 Pull Request。开发流程、测试要求与提交规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

本项目以 [`LICENSE`](LICENSE) 中的条款发布。上游来源、保留声明与第三方归属见 [`NOTICE`](NOTICE)。
