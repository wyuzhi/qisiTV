// AI 角色替换工作室客户端入口：
// 1. 挂载 character-replacement 画布节点（支持配置原人物位置/特征、目标角色、5 档替换范围、定位模式与上下游节点 ID，实时持久化至 pluginData，一键编排「关键帧换人 -> 视频元素替换」双阶段节点管线）
// 2. 挂载替换工作室独立页（/p/beeftv-plugin-character-replacement）与画布侧栏（支持目标画布绑定、多镜头配置、定位框 SVG 预览、一键推送画布与全片时间线区间无损回插）
// 3. 挂载助手工具卡片（character_replacement_arrange 与 character_replacement_splice_timeline）

export {
  GENDER_HINTS,
  PERSON_POSITIONS,
  PROMPT_MODES,
  REPLACEMENT_SCOPES,
  buildCharacterReplacementPackage,
  buildLocationGuideSvgDataUrl,
  buildTimelineRangeReplacement,
  compileCharacterReplacementPrompt,
  compileVideoReplacementPrompt,
  normalizeGenderHint,
  normalizePosition,
  normalizePromptMode,
  normalizeReplacementScope,
  uniqueNodeTitle,
} from "./compiler.js";

export {
  arrangeCharacterReplacementOnCanvas,
  spliceReplacedShotsIntoTimeline,
} from "./canvas-arrangement.js";

import { rememberCanvasId } from "./canvas-arrangement.js";
import { createCharacterReplacementNodeCard } from "./node-card.js";
import { createCharacterReplacementStudioWorkbench } from "./studio-workbench.js";

export function activate(host) {
  const React = host.React;
  const h = React ? React.createElement : () => null;
  const CharacterReplacementNodeCard = createCharacterReplacementNodeCard(host, React);
  const CharacterReplacementStudioWorkbench = createCharacterReplacementStudioWorkbench(
    host,
    React,
  );

  // 1. canvas.node — 角色替换画布节点
  host.contribute("canvas.node", {
    id: "character-replacement",
    type: "character-replacement",
    label: "角色替换",
    title: "AI 角色替换",
    defaultTitle: "AI 角色替换",
    defaultWidth: 380,
    defaultHeight: 460,
    defaultSize: { width: 380, height: 460 },
    renderer: "client",
    render: CharacterReplacementNodeCard,
    component: CharacterReplacementNodeCard,
  });

  // 2. canvas.addNodeMenu — 添加节点菜单入口
  host.contribute("canvas.addNodeMenu", {
    id: "character-replacement-add",
    label: "AI 角色替换",
    title: "AI 角色替换",
    nodeType: "character-replacement",
    section: "node",
    defaultOrder: 48,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.("character-replacement"),
    run: (ctx) => ctx?.handlers?.onAddExtensionNode?.("character-replacement"),
  });

  // 3. canvas.toolbar.main — 画布主工具栏按钮
  host.contribute("canvas.toolbar.main", {
    id: "character-replacement-toolbar",
    label: "角色替换工作室",
    title: "打开 AI 角色替换工作室",
    category: "create",
    defaultVisible: true,
    defaultOrder: 48,
    onClick: () => {
      const currentCanvasId = host.context?.getCanvasId?.();
      if (currentCanvasId) rememberCanvasId(host, currentCanvasId);
      host.ui?.navigate?.("/p/beeftv-plugin-character-replacement");
    },
    run: () => {
      const currentCanvasId = host.context?.getCanvasId?.();
      if (currentCanvasId) rememberCanvasId(host, currentCanvasId);
      host.ui?.navigate?.("/p/beeftv-plugin-character-replacement");
    },
  });

  // 4. canvas.sidePanel — 画布侧栏面板
  host.contribute("canvas.sidePanel", {
    id: "character-replacement-side-panel",
    label: "角色替换",
    title: "AI 角色替换工作室",
    order: 48,
    render: () => h(CharacterReplacementStudioWorkbench, { compact: true }),
    component: () => h(CharacterReplacementStudioWorkbench, { compact: true }),
  });

  // 5. app.page — 独立全屏工作台页面
  host.contribute("app.page", {
    id: "character-replacement-studio-page",
    path: "/p/beeftv-plugin-character-replacement",
    title: "AI 角色替换工作室",
    label: "AI 角色替换工作室",
    render: () => h(CharacterReplacementStudioWorkbench, { compact: false }),
    component: () => h(CharacterReplacementStudioWorkbench, { compact: false }),
  });

  // 6. app.sidebar — 全局导航入口
  host.contribute("app.sidebar", {
    id: "character-replacement-sidebar",
    label: "角色替换工作室",
    path: "/p/beeftv-plugin-character-replacement",
    order: 48,
  });

  // 7. assistant.toolCard — 角色替换管线编排工具卡片
  host.contribute("assistant.toolCard", {
    id: "character-replacement-tool-card",
    toolName: "character_replacement_arrange",
    label: "AI 角色替换管线编排",
    render: ({ args, result, status }) =>
      h(
        "div",
        {
          "data-testid": "character-replacement-tool-card",
          style: {
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(16, 185, 129, 0.38)",
            background: "rgba(16, 185, 129, 0.1)",
            fontSize: 12,
          },
        },
        h(
          "div",
          { style: { fontWeight: 600 } },
          `🎭 AI 角色替换 · ${args?.shotTitle || "当前镜头"}`,
        ),
        h(
          "div",
          { style: { marginTop: 4, opacity: 0.85 } },
          `范围：${args?.replacementScope || "full-person"} · 位置：${args?.position || "single"} · 状态：${status || "completed"}`,
        ),
        result
          ? h(
              "div",
              { style: { marginTop: 4, opacity: 0.75 } },
              typeof result === "string" ? result : JSON.stringify(result),
            )
          : null,
      ),
  });

  // 8. assistant.toolCard — 全片时间线区间回插工具卡片
  host.contribute("assistant.toolCard", {
    id: "character-replacement-splice-tool-card",
    toolName: "character_replacement_splice_timeline",
    label: "全片角色替换区间回插",
    render: ({ args, result, status }) =>
      h(
        "div",
        {
          "data-testid": "character-replacement-splice-tool-card",
          style: {
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(59, 130, 246, 0.38)",
            background: "rgba(59, 130, 246, 0.1)",
            fontSize: 12,
          },
        },
        h(
          "div",
          { style: { fontWeight: 600 } },
          `🎬 全片区间回插 · 原片节点 ${args?.fullVideoNodeId || ""}`,
        ),
        h(
          "div",
          { style: { marginTop: 4, opacity: 0.85 } },
          `替换镜头数：${Array.isArray(args?.replacements) ? args.replacements.length : 0} · 状态：${status || "completed"}`,
        ),
        result
          ? h(
              "div",
              { style: { marginTop: 4, opacity: 0.75 } },
              typeof result === "string" ? result : JSON.stringify(result),
            )
          : null,
      ),
  });
}

export default activate;
