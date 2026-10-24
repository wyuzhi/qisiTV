[简体中文](README.md) · [English](README.en.md)

<p align="center">
  <img src="web/public/qisitv-logo.jpg" width="160" alt="qisiTV">
</p>

<h1 align="center">qisiTV</h1>

A local-first AI video workspace based on [BeefTV](https://github.com/glanderness/BeefTV). Organize ideas, reference media, generation results and reusable workflows on a freeform canvas.

## A complete creative workspace

- Generate text, images, video and audio with separately configured qisi API and official LikeAI services.
- Organize media using nodes, connections, selection, zoom and a minimap.
- Refine and reuse results through media tools, workflows and the built-in creative assistant.
- Connect local Agents through MCP with independent client permissions.

See the [feature list](docs/content/docs/overview/features.mdx) and [feature parity design](docs/design/web-feature-parity.md). Model services charge for generation; installing, pairing or creating a project does not itself authorize paid calls.

## Web interface, local execution

The current source uses a hosted web interface backed by the qisiTV engine on the user's computer. Install the engine, open the website, confirm pairing and choose a project root. Each project has a real local folder containing its canvas and media. Browser cache is not the final storage. Engine database/cache storage and independent project folders are managed separately.

The engine reuses the upstream workspace, task queue, assistant host and media APIs. Old browser projects require explicit folder migration and authority transfer; two workspaces are never silently merged. Platform installers, model execution and release behavior still require their respective acceptance checks. See the [Web engine contract and validation boundaries](docs/design/web-engine-contract.md).

## External Agents

On the website's Agent page, choose Codex, WorkBuddy, Claude Desktop / Code, OpenClaw, Hermes, CodeBuddy, Cursor, VS Code or a generic stdio client. Generate a scoped `qisitv` MCP configuration and merge it into the client's existing configuration. The Agent and engine must run on the same computer.

`qisitv-connect open` starts and pairs the engine without requiring MCP first. In native engine mode, the older `qisitv-web` MCP is only a startup, pairing and session-discovery helper. Its old canvas tools refuse writes and direct users to the native `qisitv` configuration.

<details>
<summary>Previously used qisitv-web? Upgrade steps</summary>

1. Disable the old `qisitv-web` connection in each Agent client you used, and close any terminal running the old connector manually.
2. Wait about 30 seconds for the old service to exit. After an abnormal exit, this may take about 75 seconds.
3. Open the new qisiTV local engine and follow the website's connection prompts.
4. Select your Agent on the website's **qisiTV MCP** page and follow its instructions to configure the new `qisitv` connection.

</details>

## Local development

Requires Bun and Go 1.25. Clone this repository:

```bash
git clone https://github.com/wyuzhi/qisiTV.git
cd qisiTV
```

Run the backend with an explicitly isolated data directory, then run Vite in another terminal:

```bash
cd backend
CANVAS_BACKEND_ADDR=127.0.0.1:8080 \
CANVAS_BACKEND_DATA_DIR=../.local/project-workbench-debug \
go run ./cmd/server
```

```bash
cd web
bun install --frozen-lockfile
bun run dev
```

The frontend at localhost:3000 proxies API calls to the local backend. See [Quick Start](QUICKSTART.md) and the [engine contract](docs/design/web-engine-contract.md) for the separate native-engine architecture and packaging requirements.

## Security and license

Keep workspace APIs on loopback. Do not commit API keys, cookies, databases or local configuration. See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

Licenses have different scopes. Historical MIT content and independent qisiTV contributions retain their applicable MIT terms. New upstream content retains the [BeefTV Source Available License 1.0](licenses/BeefTV-Source-Available-1.0.txt); the complete repository must not be presented as MIT. Hosted use of covered content requires the applicable authorization. See [LICENSE](LICENSE), [NOTICE](NOTICE) and the [upstream synchronization record](docs/upstream-sync-20261024.md).
