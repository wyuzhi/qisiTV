---
name: slot-test
description: 全插槽演示技能
---

# 全插槽演示技能

当用户希望验证插件工具、测试画布插槽节点或检查插件与助手是否连通时：

1. 调用 `slot_test_ping` 工具，传入问候信息 `message`。
2. 如用户要求在画布上放置测试节点，将 `createNode` 设为 `true`。
3. 向用户汇报工具回显结果与新建节点情况。
