# AI 角色替换工作室插件（`beeftv-plugin-character-replacement`）

`beeftv-plugin-character-replacement` 是面向短剧与影视后期的 AI 角色替换插件，采用经过真实验证的**「关键帧精准换人 + 视频元素替换（`replace_element`）」双阶段高保真管线**，并支持将替换后的镜头无损回插至全片时间线：

- **双阶段高保真管线**：
  1. **Step 2 关键帧人物替换**：基于原镜头关键帧（图1）与目标角色参考图（图2），编译包含精确方位（单人 / 左侧 / 中间 / 右侧）、5 档替换范围（完整人物 / 当前可见部分 / 脸部和头发 / 仅服装 / 手臂和手部）及遮挡保护约束的结构化提示词，或生成多人定位框 SVG 辅助图，产出构图、光影、手持道具与其余人物完全一致的换人关键帧。
  2. **Step 3 视频动作与角色替换**：将「原镜头视频 + Step 2 换好人的关键帧」同时连入下游视频节点，并自动配置 `videoEditOperation = "replace_element"`（画幅与时长自动跟随原视频），在 100% 保留原片动作、道具与对手戏演员的前提下完成视频级角色替换。
- **Step 4 全片时间线区间无损回插**：
  - 支持将替换完成的镜头按 `[startMs, endMs]` 切入原全片视频，自动构建「原片前段 → 替换镜头 → 原片后段」的 Timeline v2，并可一键保留原片连续同期声轨。
- **多入口集成**：
  - **画布节点（`character-replacement`）**：在画布内直接配置镜头角色映射并一键生成下游「关键帧换人 + 视频角色替换」节点与连线。
  - **替换工作室（`/p/beeftv-plugin-character-replacement` 与画布侧栏）**：四步式全流程工作台。
  - **创作助手工具（`character_replacement_arrange` / `character_replacement_splice_timeline`）与技能（`character-replacement`）**：支持通过自然语言对话让助手自动完成双阶段换人编排与全片回插。
