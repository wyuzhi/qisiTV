# `@beeftv/plugin-sdk`

BeefTV 插件开发 SDK，提供：

- `package.json` 里 `beeftv` 一段的类型（`PluginManifest`）
- 浏览器端 `activate(host)` 的宿主接口类型（`BeefTVPluginHost`）
- 全部界面扩展位（`BeefTVSlotMap`）与宿主事件（`BeefTVEventMap`）
- 用 JS 写生成服务时的 `submit` / `query` 类型（`defineProvider`、`ProviderModule`）
- 助手端 `pi` 扩展工具定义辅助函数（`definePiExtension`、`PiExtensionAPI`）

## 清单

插件 ID、版本、说明和作者直接取 `package.json` 的 `name`、`version`、`description`、`author`，`beeftv` 里只写 BeefTV 自己的东西：

```json
{
  "name": "beeftv-plugin-sticky-note",
  "version": "0.1.0",
  "description": "在画布上放一张便签",
  "keywords": ["beeftv-plugin"],
  "beeftv": {
    "name": "画布便签",
    "client": "./client/index.js",
    "contributes": {
      "canvasNodes": [
        { "id": "sticky-note", "label": "画布便签", "defaultTitle": "便签", "renderer": "client", "defaultSize": { "width": 240, "height": 180 } }
      ]
    }
  }
}
```

写了别的键（比如 `beeftv.id`、顶层 `canvasNodes`、节点的 `type`）时，BeefTV 不会安装，并逐项说明该怎么改。

## 怎么用

BeefTV 直接加载插件里的 JS 文件，不经过打包，所以文件里不能 `import "@beeftv/plugin-sdk"`。把 SDK 装成开发依赖（`npm i -D @beeftv/plugin-sdk`），用 JSDoc 拿到编辑器提示；用 TypeScript 或打包工具的插件也可以直接用 `definePlugin`、`defineProvider`，打包后发布。

## 界面插件

```js
/** @param {import("@beeftv/plugin-sdk").BeefTVPluginHost} host */
export function activate(host) {
  host.contribute("app.command", {
    id: "hello-beeftv",
    label: "向 BeefTV 问好",
    onSelect: () => host.ui.notify("你好，BeefTV！", "success"),
  });
}
```

## 用 JS 写生成服务

在清单里登记 `"providers": [{ "id": "my-service", "label": "我的服务", "capabilities": ["image"], "scopes": ["user.custom-channel"], "module": "./provider.js" }]`（只支持图片、视频、音频），然后在 `provider.js` 里：

```js
/** @type {import("@beeftv/plugin-sdk").ProviderModule["submit"]} */
export async function submit(request, ctx) {
  const response = await fetch(`${ctx.config.baseUrl}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.config.apiKey}` },
    body: JSON.stringify({ prompt: request.prompt }),
    signal: ctx.signal,
  });
  if (!response.ok) return { status: "failed", message: `服务商返回 HTTP ${response.status}` };
  return { taskId: (await response.json()).id, status: "pending" };
}

/** @type {import("@beeftv/plugin-sdk").ProviderModule["query"]} */
export async function query(taskId, request, ctx) {
  const task = await (await fetch(`${ctx.config.baseUrl}/tasks/${taskId}`, { signal: ctx.signal })).json();
  if (task.state === "done") return { taskId, status: "succeeded", result: { images: [{ url: task.imageUrl }] } };
  return { taskId, status: "processing" };
}
```

这个文件跑在 BeefTV 后端旁边的 Node 进程里。BeefTV 负责记任务、重启后继续查询、把结果下载进工作区；插件只管跟服务商说话。
