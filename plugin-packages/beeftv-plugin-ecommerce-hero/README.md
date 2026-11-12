# 一键商品主图插件（`beeftv-plugin-ecommerce-hero`）

`beeftv-plugin-ecommerce-hero` 是面向电商视觉创作的样板插件，集成了画布节点、助手工具、技能与助手工具结果卡片：

- **画布节点（`ecommerce-hero`）**：支持输入商品名称、粘贴商品白底图 URL 或连接上游图片节点、选择场景风格（棚拍质感 / 生活场景 / 节日促销）和出图张数（1 / 2 / 4 张），点击「生成主图节点」即可通过 `host.ops.call("canvas.nodes.create", ...)` 在画布上批量建立场景主图节点。
- **助手工具（`ecommerce_hero_arrange`）**：自动创建 `ecommerce-hero` 节点与 1~4 个下游 `image` 场景图节点、建立连线，并支持直接调用 `canvas_generation_propose` 登记付费生成提议。
- **助手技能（`ecommerce-hero`）**：指导创作助手按高转化电商主图规范拆解卖点与场景构图。
