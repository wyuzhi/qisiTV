// 一键商品主图插件客户端入口：
// 1. 挂载 ecommerce-hero 画布节点（支持填写商品名称、图片地址、选择场景风格与出图张数，点击一键在画布创建场景主图节点）
// 2. 挂载 canvas.addNodeMenu（「一键商品主图」）
// 3. 挂载 assistant.toolCard（美化 ecommerce_hero_arrange 工具在助手面板里的结果卡片）

const SCENE_STYLES = [
  { value: "studio", label: "棚拍质感", promptPrefix: "电商商业棚拍主图，柔光箱立体布光，纯净高级背景" },
  { value: "lifestyle", label: "生活场景", promptPrefix: "电商真实生活场景主图，自然日光，高代入感生活美学" },
  { value: "festival", label: "节日促销", promptPrefix: "电商大促氛围主图，喜庆高级光影，突出核心视觉焦点" },
];

const SCENE_COUNTS = [1, 2, 4];

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
  if (!React) return;
  const h = React.createElement;

  function EcommerceHeroNodeCard(props) {
    const pluginData = props?.node?.metadata?.pluginData || {};
    const [productTitle, setProductTitle] = React.useState(
      pluginData.productTitle || props?.node?.title || "新款主推商品",
    );
    const [imageUrl, setImageUrl] = React.useState(pluginData.imageUrl || "");
    const [sceneStyle, setSceneStyle] = React.useState(
      pluginData.sceneStyle || SCENE_STYLES[0].value,
    );
    const [sceneCount, setSceneCount] = React.useState(
      Number(pluginData.sceneCount) || 2,
    );
    const [submitting, setSubmitting] = React.useState(false);
    const [statusMessage, setStatusMessage] = React.useState("");

    const syncPluginData = (patch) => {
      const next = {
        productTitle,
        imageUrl,
        sceneStyle,
        sceneCount,
        ...patch,
      };
      props?.updateNodeData?.(next);
    };

    const handleCreateSceneNodes = async () => {
      setSubmitting(true);
      setStatusMessage("");
      try {
        const styleItem =
          SCENE_STYLES.find((item) => item.value === sceneStyle) ||
          SCENE_STYLES[0];
        const count = SCENE_COUNTS.includes(Number(sceneCount))
          ? Number(sceneCount)
          : 2;

        let canvasId =
          props?.projectId ||
          host.context?.getCanvasId?.() ||
          (typeof window !== "undefined"
            ? window.location.pathname.split("/").filter(Boolean).pop()
            : "");
        let expectedRevision = host.context?.getCanvasRevision?.();

        if (canvasId && !Number.isSafeInteger(expectedRevision) && host.ops?.call) {
          const readRes = await host.ops.call("canvas.get", { canvasId });
          expectedRevision = readRes?.result?.canvas?.revision ?? readRes?.revision;
        }

        const drafts = Array.from({ length: count }, (_, idx) => ({
          type: "image",
          title: `${productTitle || "商品"} · ${styleItem.label} #${idx + 1}`,
          prompt: `${styleItem.promptPrefix}，商品主体：${productTitle || "主推商品"}，第 ${idx + 1} 视角构图${imageUrl ? `，参考商品图：${imageUrl}` : ""}。`,
        }));

        if (host.ops?.call && canvasId && Number.isSafeInteger(expectedRevision)) {
          await host.ops.call("canvas.nodes.create", {
            canvasId,
            expectedRevision,
            nodes: drafts,
          });
        }
        setStatusMessage(`已创建 ${count} 个${styleItem.label}主图节点`);
        host.ui?.notify?.(
          `已为「${productTitle || "商品"}」生成 ${count} 个主图节点`,
          "success",
        );
      } catch (err) {
        const msg = err?.message || "创建主图节点失败";
        setStatusMessage(msg);
        host.ui?.notify?.(msg, "error");
      } finally {
        setSubmitting(false);
      }
    };

    return h(
      "div",
      {
        "data-testid": "ecommerce-hero-node",
        "data-plugin-node": "ecommerce-hero",
        style: {
          height: "100%",
          width: "100%",
          padding: "36px 14px 12px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 12,
        },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            },
          },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: 13 } },
            "🛍️ 一键商品主图",
          ),
          h(
            "span",
            { style: { fontSize: 11, opacity: 0.65 } },
            `${sceneCount} 张场景图`,
          ),
        ),
        h("input", {
          type: "text",
          "data-testid": "ecommerce-hero-title-input",
          value: productTitle,
          onChange: (e) => {
            setProductTitle(e.target.value);
            syncPluginData({ productTitle: e.target.value });
          },
          placeholder: "输入商品名称（如：复古蓝牙音箱）",
          style: {
            width: "100%",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid rgba(148, 163, 184, 0.35)",
            background: "transparent",
            color: "inherit",
            boxSizing: "border-box",
          },
        }),
        h("input", {
          type: "url",
          "data-testid": "ecommerce-hero-image-input",
          value: imageUrl,
          onChange: (e) => {
            setImageUrl(e.target.value);
            syncPluginData({ imageUrl: e.target.value });
          },
          placeholder: "粘贴商品白底图 URL 或连接上游图片节点",
          style: {
            width: "100%",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid rgba(148, 163, 184, 0.35)",
            background: "transparent",
            color: "inherit",
            boxSizing: "border-box",
          },
        }),
        h(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: { opacity: 0.75, whiteSpace: "nowrap" } }, "风格："),
          h(
            "select",
            {
              "data-testid": "ecommerce-hero-style-select",
              value: sceneStyle,
              onChange: (e) => {
                setSceneStyle(e.target.value);
                syncPluginData({ sceneStyle: e.target.value });
              },
              style: {
                flex: 1,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background: "transparent",
                color: "inherit",
              },
            },
            SCENE_STYLES.map((item) =>
              h("option", { key: item.value, value: item.value }, item.label),
            ),
          ),
          h("span", { style: { opacity: 0.75, whiteSpace: "nowrap" } }, "张数："),
          h(
            "div",
            { style: { display: "flex", gap: 4 } },
            SCENE_COUNTS.map((count) =>
              h(
                "button",
                {
                  key: count,
                  type: "button",
                  "data-testid": `ecommerce-hero-count-${count}`,
                  onClick: () => {
                    setSceneCount(count);
                    syncPluginData({ sceneCount: count });
                  },
                  style: {
                    padding: "3px 8px",
                    borderRadius: 5,
                    border: "1px solid rgba(59, 130, 246, 0.4)",
                    background:
                      sceneCount === count
                        ? "rgba(59, 130, 246, 0.22)"
                        : "transparent",
                    color: "inherit",
                    fontWeight: sceneCount === count ? 600 : 400,
                    cursor: "pointer",
                  },
                },
                `${count}张`,
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        statusMessage
          ? h(
              "div",
              {
                "data-testid": "ecommerce-hero-status",
                style: { fontSize: 11, opacity: 0.85 },
              },
              statusMessage,
            )
          : null,
        h(
          "button",
          {
            type: "button",
            "data-testid": "ecommerce-hero-submit-btn",
            disabled: submitting,
            onClick: handleCreateSceneNodes,
            style: {
              width: "100%",
              padding: "7px 12px",
              borderRadius: 8,
              border: "1px solid rgba(59, 130, 246, 0.5)",
              background: "rgba(59, 130, 246, 0.2)",
              color: "inherit",
              fontWeight: 600,
              cursor: submitting ? "wait" : "pointer",
            },
          },
          submitting ? "正在创建主图节点…" : "生成主图节点",
        ),
      ),
    );
  }

  host.contribute("canvas.node", {
    id: "ecommerce-hero",
    type: "ecommerce-hero",
    label: "一键商品主图",
    title: "一键商品主图",
    defaultTitle: "商品主图",
    description: "上传商品白底图/实拍图，选择场景张数并生成电商主图",
    defaultWidth: 320,
    defaultHeight: 280,
    defaultSize: { width: 320, height: 280 },
    acceptsInputKind: "image",
    renderer: "client",
    schema: {
      type: "object",
      properties: {
        productTitle: { type: "string" },
        imageUrl: { type: "string" },
        sceneStyle: { type: "string" },
        sceneCount: { type: "number" },
      },
    },
    render: EcommerceHeroNodeCard,
    component: EcommerceHeroNodeCard,
  });

  host.contribute("canvas.addNodeMenu", {
    id: "ecommerce-hero-add",
    label: "一键商品主图",
    title: "一键商品主图",
    nodeType: "ecommerce-hero",
    section: "node",
    defaultOrder: 89,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.("ecommerce-hero"),
    run: (ctx) => ctx?.handlers?.onAddExtensionNode?.("ecommerce-hero"),
  });

  host.contribute("assistant.toolCard", {
    id: "ecommerce-hero-tool-card",
    toolName: "ecommerce_hero_arrange",
    label: "一键编排商品主图",
    render: ({ args, result, status }) =>
      h(
        "div",
        {
          "data-testid": "ecommerce-hero-tool-card",
          style: {
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid rgba(16, 185, 129, 0.35)",
            background: "rgba(16, 185, 129, 0.1)",
            fontSize: 12,
          },
        },
        h(
          "div",
          { style: { fontWeight: 600 } },
          `🛍️ 一键商品主图编排 · ${args?.productTitle || "商品"}`,
        ),
        h(
          "div",
          { style: { marginTop: 4, opacity: 0.85 } },
          `卖点：${args?.sellingPoints || "未填写"} · 场景张数：${args?.sceneCount ?? 2} 张 · 状态：${status || "completed"}`,
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
