# 画布便签插件（`beeftv-plugin-sticky-note`）

`beeftv-plugin-sticky-note` 是 BeefTV 插件开发的入门模板插件，完整展示了一个标准插件包的四要素：

1. `package.json`：声明 `beeftv` 清单与 `pi` 扩展/技能路径。
2. `extensions/index.ts`：注册 `sticky_note_create` 与 `sticky_note_update` 助手工具，通过 `ctx.executeTool` 调用 Go 业务操作。
3. `skills/sticky-note/SKILL.md`：指导创作助手如何拆分要点并创建便签。
4. `client/index.js`：通过 `activate(host)` 和 `host.contribute` 注册可换色、可编辑的画布便签节点与「添加节点」菜单项。
