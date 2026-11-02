// 画布便签插件客户端入口：通过 activate(host) 与 host.contribute 注册便签节点和菜单入口。

const STICKY_THEMES = [
  { key: "amber", label: "暖黄", bg: "#fef08a", text: "#713f12", border: "#facc15" },
  { key: "mint", label: "薄荷", bg: "#bbf7d0", text: "#14532d", border: "#4ade80" },
  { key: "sky", label: "晴空", bg: "#bae6fd", text: "#0c4a6e", border: "#38bdf8" },
  { key: "rose", label: "樱粉", bg: "#fecdd3", text: "#881337", border: "#fb7185" },
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
  if (!React) return;
  const h = React.createElement;

  function StickyNoteCard(props) {
    const initialData = props?.node?.metadata?.pluginData || {};
    const initialText =
      initialData.content ||
      props?.node?.metadata?.content ||
      props?.node?.metadata?.prompt ||
      "点击输入便签内容…";
    const initialColor = initialData.color || "amber";

    const [text, setText] = React.useState(initialText);
    const [colorKey, setColorKey] = React.useState(initialColor);

    React.useEffect(() => {
      const nextText =
        props?.node?.metadata?.pluginData?.content ||
        props?.node?.metadata?.content ||
        props?.node?.metadata?.prompt;
      if (typeof nextText === "string" && nextText.length > 0) {
        setText(nextText);
      }
    }, [
      props?.node?.metadata?.pluginData?.content,
      props?.node?.metadata?.content,
      props?.node?.metadata?.prompt,
    ]);

    const palette =
      STICKY_THEMES.find((item) => item.key === colorKey) || STICKY_THEMES[0];

    const handleTextChange = (e) => {
      const nextValue = e.target.value;
      setText(nextValue);
      props?.updateNodeData?.({ content: nextValue, color: colorKey });
      props?.onContentChange?.(props?.node?.id, nextValue);
    };

    const handleColorSelect = (nextColor) => {
      setColorKey(nextColor);
      props?.updateNodeData?.({ content: text, color: nextColor });
    };

    return h(
      "div",
      {
        "data-testid": "sticky-note-card",
        "data-plugin-node": "sticky-note",
        style: {
          height: "100%",
          width: "100%",
          padding: "36px 14px 12px",
          background: palette.bg,
          color: palette.text,
          border: `1px solid ${palette.border}`,
          borderRadius: 10,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 8,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
        },
      },
      h("textarea", {
        "data-testid": "sticky-note-textarea",
        value: text,
        onChange: handleTextChange,
        placeholder: "写下灵感、待办或审片批注…",
        style: {
          flex: 1,
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          color: palette.text,
          fontSize: 13,
          lineHeight: 1.55,
          fontFamily: "inherit",
        },
      }),
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 4,
            borderTop: "1px solid rgba(0, 0, 0, 0.08)",
          },
        },
        h(
          "span",
          { style: { fontSize: 11, opacity: 0.75, fontWeight: 500 } },
          "📌 画布便签",
        ),
        h(
          "div",
          { style: { display: "flex", gap: 6 } },
          STICKY_THEMES.map((item) =>
            h("button", {
              key: item.key,
              type: "button",
              title: `切换为${item.label}`,
              "data-testid": `sticky-note-color-${item.key}`,
              onClick: () => handleColorSelect(item.key),
              style: {
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: item.bg,
                border:
                  item.key === colorKey
                    ? `2px solid ${item.text}`
                    : `1px solid ${item.border}`,
                cursor: "pointer",
                padding: 0,
              },
            }),
          ),
        ),
      ),
    );
  }

  host.contribute("canvas.node", {
    id: "sticky-note",
    type: "sticky-note",
    label: "画布便签",
    title: "画布便签",
    defaultTitle: "便签",
    defaultWidth: 240,
    defaultHeight: 180,
    defaultSize: { width: 240, height: 180 },
    renderer: "client",
    schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        color: { type: "string" },
      },
    },
    render: StickyNoteCard,
    component: StickyNoteCard,
  });

  host.contribute("canvas.addNodeMenu", {
    id: "sticky-note-add",
    label: "画布便签",
    title: "画布便签",
    nodeType: "sticky-note",
    section: "node",
    defaultOrder: 88,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.("sticky-note"),
    run: (ctx) => ctx?.handlers?.onAddExtensionNode?.("sticky-note"),
  });
}

export default activate;
