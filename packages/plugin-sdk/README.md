# `@beeftv/plugin-sdk`

BeefTV 插件开发 SDK，提供：

- `package.json` 中 `beeftv` 清单字段的完整 TypeScript 类型定义（`PluginManifest`）
- 浏览器端 `activate(host)` 的宿主接口类型（`BeefTVPluginHost`）
- 全部 21 个界面扩展位（`BeefTVSlotMap`）与 8 类宿主事件（`BeefTVEventMap`）
- 助手端 `pi` 扩展工具定义辅助函数（`definePiExtension`、`PiExtensionAPI`）

## 快速上手

```js
import { definePlugin } from "@beeftv/plugin-sdk";

export default definePlugin((host) => {
  host.contribute("app.command", {
    id: "hello-beeftv",
    label: "向 BeefTV 问好",
    onSelect: () => host.ui.notify("你好，BeefTV！", "success"),
  });
});
```
