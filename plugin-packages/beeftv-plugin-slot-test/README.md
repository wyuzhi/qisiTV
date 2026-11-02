# 全插槽演示插件（`beeftv-plugin-slot-test`）

`beeftv-plugin-slot-test` 是 BeefTV 插件系统的完整参考实现与回归验证插件，覆盖：

- **全部界面挂点**：画布节点、添加节点菜单、三条画布工具栏、右键菜单、节点配置面板、提示词输入框动作、画布侧栏、生成前钩子、剪辑工作台全部 8 个插槽、外部素材源、素材项动作、独立页面、全局侧栏、全局命令、自定义设置面板、插件中心栏目、项目详情分页、助手工具结果卡片。
- **全部宿主事件**：`generation.submitted`、`generation.completed`、`generation.failed`、`assets.imported`、`assistant.turnCompleted`。
- **助手工具与技能**：提供 `slot_test_ping` 工具与 `slot-test` 技能。
