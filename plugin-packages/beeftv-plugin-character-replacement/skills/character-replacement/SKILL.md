---
name: character-replacement
description: AI 视频角色替换与全片区间回插技能：针对单人/多人镜头执行「关键帧精准换人 + Seedance 2.5 视频元素替换」双阶段高保真替换，并将替换后的镜头无损回插至全片时间线。
---

# AI 角色替换工作室（`character-replacement`）

## 适用场景

- 用户希望把已有视频片段或短剧镜头中的某个角色（单人画面，或双人/多人同框中的左侧、中间、右侧人物）替换为新的目标角色形象。
- 用户需要控制替换范围：`full-person`（完整人物含外观和服装）、`visible-part`（当前可见部分）、`face-hair`（仅脸部和头发）、`clothing`（仅服装）、`arm-hand`（手臂和手部）。
- 用户希望保持原视频中的运镜、人物动作节奏、手持道具（如文件夹、冷兵器等）以及画面中其他未替换角色 100% 不变。
- 用户在替换完单个或若干个镜头后，希望把替换好的镜头按时间区间（`startMs ~ endMs`）完整回插到原全片时间线中并保留原片连续原声。

## 双阶段高保真编排步骤

1. **识别现场素材节点**：
   - 原镜头关键帧图片节点 `sourceKeyframeNodeId`（作为图1：提供原镜头构图、光影、遮挡关系与其余人物）。
   - 目标新角色参考图节点 `targetCharacterNodeId`（作为图2：提供新角色面部与服装特征）。
   - 原镜头视频节点 `sourceVideoNodeId`（提供原视频运镜与动作轨迹）。
2. **调用 `character_replacement_arrange` 工具**：
   - 传入 `shotTitle`、`position`（`single` / `left` / `center` / `right`）、`genderHint`（`person` / `male` / `female`）、`sourceDescription`（如「穿黑色西装的男人」）、`targetDescription`（如「戴银框眼镜、穿酒红色丝绒西装的年轻霸总」）与 `replacementScope`。
   - 传入 `sourceKeyframeNodeId`、`targetCharacterNodeId` 和 `sourceVideoNodeId`，工具会自动：
     1. 编译结构化防串脸关键帧替换提示词，创建 Step 2 关键帧换人 `image` 节点；
     2. 编译视频角色替换提示词，创建 Step 3 视频替换 `video` 节点并自动配置 `videoEditOperation: "replace_element"`（锁定时长与画幅跟随原视频）；
     3. 建立 `[原关键帧 + 目标角色图] -> [关键帧换人节点]` 与 `[原镜头视频 + 关键帧换人节点] -> [视频角色替换节点]` 的完整参考连线。
   - 若上游参考节点已就绪且用户要求直接生成，可将 `proposeGeneration` 设为 `true` 发起生成提议。
3. **全片时间线区间无损回插（可选 Step 4）**：
   - 当替换镜头视频节点生成完成后，调用 `character_replacement_splice_timeline`，传入 `fullVideoNodeId`、`fullDurationMs` 与 `replacements: [{ nodeId, startMs, endMs }]`。
   - 工具会自动将原全片切分为「原片前段 → 替换镜头 → 原片后段」并写入画布 Timeline v2，默认保留原片完整连续音轨，随后可直接调用 `canvas_timeline_deliver` 渲染交付完整成片。
