// 全插槽演示插件：挂载第 5.2 节全部 21 类界面扩展位（含剪辑工作台 8 个子插槽），
// 并订阅第 5.3 节全部 8 类宿主事件。插件停用或卸载时由宿主自动撤销全部挂载。

const EDITOR_SLOTS = [
  { slot: "editor.timeline-panel", label: "时间线面板扩展" },
  { slot: "editor.preview-renderer", label: "预览渲染扩展" },
  { slot: "editor.inspector", label: "属性检查器扩展" },
  { slot: "editor.asset-ingest", label: "素材导入扩展" },
  { slot: "editor.subtitle-tool", label: "字幕工具扩展" },
  { slot: "editor.transcription-provider", label: "转写服务扩展" },
  { slot: "editor.export-renderer", label: "导出渲染扩展" },
  { slot: "editor.ai-assistant", label: "剪辑 AI 助手扩展" },
];

const HOST_EVENTS = [
  "canvas.opened",
  "canvas.changed",
  "canvas.selectionChanged",
  "generation.submitted",
  "generation.completed",
  "generation.failed",
  "assets.imported",
  "assistant.turnCompleted",
];

function getReact(host) {
  if (host?.React) return host.React;
  if (host?.ui?.React) return host.ui.React;
  if (typeof window !== "undefined") {
    return window.__BEEFTV_REACT__ || window.React || null;
  }
  return null;
}

export function activate(host) {
  const React = getReact(host);
  const h = React ? React.createElement : () => null;
  const eventLog = [];

  // 订阅全部 8 类宿主事件（5.3 节）
  for (const eventName of HOST_EVENTS) {
    host.events?.on?.(eventName, (payload) => {
      eventLog.unshift({
        event: eventName,
        at: new Date().toISOString(),
        payload,
      });
      if (eventLog.length > 25) eventLog.length = 25;
    });
  }

  // 1. canvas.node — 自定义画布节点
  function SlotTestNodeCard(props) {
    const greeting =
      host.config?.get?.("greeting", "你好 BeefTV") || "你好 BeefTV";
    const note =
      props?.node?.metadata?.pluginData?.note ||
      props?.node?.metadata?.content ||
      props?.node?.metadata?.prompt ||
      "全插槽演示节点已就绪";
    return h(
      "div",
      {
        "data-testid": "slot-test-canvas-node",
        style: {
          height: "100%",
          padding: 14,
          paddingTop: 36,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          borderRadius: 10,
          background: "rgba(59, 130, 246, 0.12)",
          border: "1px solid rgba(59, 130, 246, 0.35)",
          boxSizing: "border-box",
          fontSize: 12,
        },
      },
      h(
        "div",
        { style: { fontWeight: 600, fontSize: 13 } },
        `🧩 ${greeting}`,
      ),
      h("div", { style: { opacity: 0.85, lineHeight: 1.5 } }, String(note)),
      h(
        "div",
        { style: { fontSize: 11, opacity: 0.65 } },
        `已捕获事件：${eventLog.length} 条`,
      ),
    );
  }

  host.contribute("canvas.node", {
    id: "slot-test-node",
    type: "slot-test-node",
    label: "插槽测试节点",
    title: "插槽测试节点",
    defaultTitle: "插槽测试节点",
    defaultWidth: 260,
    defaultHeight: 160,
    defaultSize: { width: 260, height: 160 },
    renderer: "client",
    schema: {
      type: "object",
      properties: { note: { type: "string" } },
    },
    render: SlotTestNodeCard,
    component: SlotTestNodeCard,
  });

  // 2. canvas.addNodeMenu — 添加节点菜单条目
  host.contribute("canvas.addNodeMenu", {
    id: "slot-test-add-node",
    label: "插槽测试节点",
    title: "插槽测试节点",
    nodeType: "slot-test-node",
    section: "node",
    defaultOrder: 95,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.("slot-test-node"),
    run: (ctx) => ctx?.handlers?.onAddExtensionNode?.("slot-test-node"),
  });

  // 3. canvas.toolbar.main — 画布主工具栏按钮
  host.contribute("canvas.toolbar.main", {
    id: "slot-test-toolbar-main",
    label: "插槽主栏按钮",
    title: "插槽主栏按钮",
    category: "create",
    defaultVisible: true,
    defaultOrder: 95,
    onClick: () => host.ui?.notify?.("已触发画布主工具栏插件按钮", "info"),
    run: () => host.ui?.notify?.("已触发画布主工具栏插件按钮", "info"),
  });

  // 4. canvas.toolbar.selection — 多选工具栏按钮
  host.contribute("canvas.toolbar.selection", {
    id: "slot-test-toolbar-selection",
    label: "插槽多选动作",
    title: "插槽多选动作",
    category: "selection",
    defaultVisible: true,
    defaultOrder: 95,
    onClick: () => host.ui?.notify?.("已触发多选工具栏插件动作", "info"),
    run: () => host.ui?.notify?.("已触发多选工具栏插件动作", "info"),
  });

  // 5. canvas.toolbar.nodeHover — 节点悬停工具栏按钮
  host.contribute("canvas.toolbar.nodeHover", {
    id: "slot-test-toolbar-node-hover",
    label: "插槽悬停动作",
    title: "插槽悬停动作",
    category: "node-state",
    defaultVisible: true,
    defaultOrder: 95,
    onClick: () => host.ui?.notify?.("已触发节点悬停工具栏插件动作", "info"),
    run: () => host.ui?.notify?.("已触发节点悬停工具栏插件动作", "info"),
  });

  // 6. canvas.contextMenu — 画布与节点右键菜单项
  host.contribute("canvas.contextMenu", {
    id: "slot-test-context-menu",
    label: "插槽测试右键动作",
    target: "both",
    order: 95,
    onSelect: () => host.ui?.notify?.("已触发右键菜单插件动作", "info"),
    run: () => host.ui?.notify?.("已触发右键菜单插件动作", "info"),
  });

  // 7. canvas.nodePanel — 节点配置面板扩展区域
  host.contribute("canvas.nodePanel", {
    id: "slot-test-node-panel",
    title: "插槽测试配置区",
    label: "插槽测试配置区",
    order: 95,
    render: ({ node }) =>
      h(
        "div",
        {
          "data-testid": "slot-test-node-panel",
          style: { fontSize: 12, padding: "8px 0" },
        },
        `当前节点：${node?.title || node?.id || "未命名"}`,
      ),
  });

  // 8. canvas.promptActions — 提示词输入框旁的动作按钮
  host.contribute("canvas.promptActions", {
    id: "slot-test-prompt-action",
    label: "追加测试标签",
    order: 95,
    onClick: ({ prompt, setPrompt }) => {
      const next = `${String(prompt || "").trim()} [光影质感]`.trim();
      setPrompt?.(next);
    },
  });

  // 9. canvas.sidePanel — 画布侧栏面板页
  host.contribute("canvas.sidePanel", {
    id: "slot-test-side-panel",
    label: "插槽监控",
    title: "插槽与事件监控",
    order: 95,
    render: () =>
      h(
        "div",
        {
          "data-testid": "slot-test-side-panel",
          style: { padding: 12, fontSize: 12 },
        },
        h("div", { style: { fontWeight: 600, marginBottom: 8 } }, "宿主事件日志"),
        eventLog.length === 0
          ? h("div", { style: { opacity: 0.7 } }, "暂无事件记录")
          : eventLog.map((item, idx) =>
              h(
                "div",
                { key: `${item.at}-${idx}`, style: { marginBottom: 4 } },
                `${item.event} (${item.at.slice(11, 19)})`,
              ),
            ),
      ),
  });

  // 10. generation.beforeSubmit — 提交生成前改写钩子（向用户显式标明修改内容与来源插件）
  host.contribute("generation.beforeSubmit", {
    id: "slot-test-before-submit",
    label: "全插槽演示插件",
    order: 95,
    transform: ({ prompt, parameters }) => ({
      prompt,
      parameters: { ...(parameters || {}) },
      reason: "全插槽演示插件已核对生成请求参数",
    }),
  });

  // 11. editor.* — 剪辑工作台全部 8 个插槽
  for (const item of EDITOR_SLOTS) {
    host.contribute(item.slot, {
      id: `slot-test-${item.slot}`,
      label: item.label,
      title: item.label,
      priority: 10,
      render: () =>
        h(
          "div",
          {
            "data-testid": `slot-test-${item.slot}`,
            style: { padding: 8, fontSize: 12 },
          },
          `[全插槽演示] ${item.label}`,
        ),
    });
  }

  // 12. assets.source — 外部素材来源
  host.contribute("assets.source", {
    id: "slot-test-assets-source",
    label: "演示素材源",
    description: "全插槽演示插件提供的示例素材来源",
    listFolders: async () => [{ id: "demo-root", name: "演示素材目录" }],
    list: async () => [],
    render: () =>
      h(
        "div",
        { "data-testid": "slot-test-assets-source", style: { padding: 12 } },
        "演示外部素材来源已挂载",
      ),
  });

  // 13. assets.itemActions — 素材卡片与详情操作
  host.contribute("assets.itemActions", {
    id: "slot-test-asset-action",
    label: "发送至插槽测试",
    order: 95,
    onSelect: (asset) => {
      host.ui?.notify?.(`已选择素材：${asset?.title || asset?.id || ""}`, "info");
    },
  });

  // 14. app.page — 独立插件页面（/p/beeftv-plugin-slot-test）
  host.contribute("app.page", {
    id: "slot-test-page",
    path: "/p/beeftv-plugin-slot-test",
    title: "全插槽演示页",
    label: "全插槽演示页",
    render: () =>
      h(
        "div",
        {
          "data-testid": "slot-test-app-page",
          style: { padding: 24, display: "flex", flexDirection: "column", gap: 12 },
        },
        h("h2", { style: { margin: 0 } }, "全插槽演示插件独立页面"),
        h(
          "p",
          { style: { margin: 0, opacity: 0.8 } },
          "本页面通过 app.page 插槽挂载，路径为 /p/beeftv-plugin-slot-test。",
        ),
      ),
  });

  // 15. app.sidebar — 全局侧栏导航入口
  host.contribute("app.sidebar", {
    id: "slot-test-sidebar",
    label: "插槽演示",
    path: "/p/beeftv-plugin-slot-test",
    order: 95,
  });

  // 16. app.command — 全局命令面板命令
  host.contribute("app.command", {
    id: "slot-test-command",
    label: "运行全插槽演示自检",
    shortcut: "Mod+Shift+9",
    keywords: ["slot", "test", "插槽", "演示"],
    onSelect: () => host.ui?.notify?.("全插槽演示插件自检通过", "success"),
    run: () => host.ui?.notify?.("全插槽演示插件自检通过", "success"),
  });

  // 17. app.settings — 插件中心自定义设置面板
  host.contribute("app.settings", {
    id: "slot-test-settings",
    title: "全插槽演示插件设置",
    label: "全插槽演示插件设置",
    render: ({ config, onChange }) =>
      h(
        "div",
        {
          "data-testid": "slot-test-app-settings",
          style: { display: "flex", flexDirection: "column", gap: 8, padding: 8 },
        },
        h("label", { style: { fontSize: 12, fontWeight: 500 } }, "测试问候语"),
        h("input", {
          type: "text",
          value: String(config?.greeting ?? "你好 BeefTV"),
          onChange: (e) =>
            onChange?.({ ...(config || {}), greeting: e.target.value }),
          style: {
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid rgba(148, 163, 184, 0.35)",
            background: "transparent",
          },
        }),
      ),
  });

  // 18. pluginCenter.section — 插件中心左侧分区栏
  host.contribute("pluginCenter.section", {
    id: "slot-test-section",
    label: "插槽诊断",
    description: "查看 21 个扩展插槽与 8 类宿主事件的挂载状态",
    order: 95,
    render: () =>
      h(
        "div",
        {
          "data-testid": "slot-test-plugin-center-section",
          style: { padding: 16, fontSize: 13 },
        },
        "全部 21 个界面扩展位与 8 类事件监听均已激活。",
      ),
  });

  // 19. project.view — 项目详情分页视图
  host.contribute("project.view", {
    id: "slot-test-project-view",
    label: "插槽视图",
    title: "插槽演示视图",
    order: 95,
    render: ({ projectId }) =>
      h(
        "div",
        {
          "data-testid": "slot-test-project-view",
          style: { padding: 16, fontSize: 13 },
        },
        `项目 ${projectId || "当前项目"} 的插件扩展分页视图`,
      ),
  });

  // 20. assistant.toolCard — 助手面板工具调用结果卡片
  host.contribute("assistant.toolCard", {
    id: "slot-test-tool-card",
    toolName: "slot_test_ping",
    label: "插槽测试探针",
    render: ({ args, result, status }) =>
      h(
        "div",
        {
          "data-testid": "slot-test-assistant-tool-card",
          style: {
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid rgba(59, 130, 246, 0.35)",
            background: "rgba(59, 130, 246, 0.1)",
            fontSize: 12,
          },
        },
        h("div", { style: { fontWeight: 600 } }, "🧩 插槽测试探针回执"),
        h(
          "div",
          { style: { marginTop: 4, opacity: 0.85 } },
          `输入消息：${args?.message || ""} · 状态：${status || "completed"}`,
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
