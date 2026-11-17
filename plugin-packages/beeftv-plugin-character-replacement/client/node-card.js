import {
  PERSON_POSITIONS,
  PROMPT_MODES,
  REPLACEMENT_SCOPES,
  buildCharacterReplacementPackage,
  normalizeGenderHint,
  normalizePosition,
  normalizePromptMode,
  normalizeReplacementScope,
} from "./compiler.js";
import { arrangeCharacterReplacementOnCanvas } from "./canvas-arrangement.js";
import { inputStyle } from "./ui-shared.js";

/**
 * 构建角色替换画布节点卡片组件。
 */
export function createCharacterReplacementNodeCard(host, React) {
  const h = React ? React.createElement : () => null;

  return function CharacterReplacementNodeCard(props) {
    const node = props?.node || {};
    const pluginData = node?.metadata?.pluginData || {};

    const [shotTitle, setShotTitle] = React.useState(
      () => String(pluginData.shotTitle || node.title || "镜头 1"),
    );
    const [position, setPosition] = React.useState(
      () => normalizePosition(pluginData.position || "left"),
    );
    const [genderHint] = React.useState(
      () => normalizeGenderHint(pluginData.genderHint || "person"),
    );
    const [sourceDescription, setSourceDescription] = React.useState(
      () => String(pluginData.sourceDescription || ""),
    );
    const [targetDescription, setTargetDescription] = React.useState(
      () => String(pluginData.targetDescription || ""),
    );
    const [replacementScope, setReplacementScope] = React.useState(
      () => normalizeReplacementScope(pluginData.replacementScope || "full-person"),
    );
    const [promptMode, setPromptMode] = React.useState(
      () => normalizePromptMode(pluginData.promptMode || "regular"),
    );
    const [manualPrompt, setManualPrompt] = React.useState(
      () => String(pluginData.manualPrompt || ""),
    );
    const [sourceKeyframeNodeId, setSourceKeyframeNodeId] = React.useState(
      () => String(pluginData.sourceKeyframeNodeId || ""),
    );
    const [targetCharacterNodeId, setTargetCharacterNodeId] = React.useState(
      () => String(pluginData.targetCharacterNodeId || ""),
    );
    const [locationGuideNodeId, setLocationGuideNodeId] = React.useState(
      () => String(pluginData.locationGuideNodeId || ""),
    );
    const [sourceVideoNodeId, setSourceVideoNodeId] = React.useState(
      () => String(pluginData.sourceVideoNodeId || ""),
    );
    const [submitting, setSubmitting] = React.useState(false);
    const [statusText, setStatusText] = React.useState("");

    React.useEffect(() => {
      const currentCanvasId = host.context?.getCanvasId?.();
      if (currentCanvasId) {
        host.storage?.set?.("lastCanvasId", currentCanvasId);
      }
    }, []);

    const syncPluginData = (patch) => {
      props?.updateNodeData?.({
        shotTitle,
        position,
        genderHint,
        sourceDescription,
        targetDescription,
        replacementScope,
        promptMode,
        manualPrompt,
        sourceKeyframeNodeId,
        targetCharacterNodeId,
        locationGuideNodeId,
        sourceVideoNodeId,
        ...patch,
      });
    };

    const compiled = React.useMemo(
      () =>
        buildCharacterReplacementPackage({
          position,
          genderHint,
          sourceDescription,
          targetDescription,
          replacementScope,
          promptMode,
          manualPrompt,
          hasLocationGuideImage: Boolean(locationGuideNodeId),
        }),
      [
        position,
        genderHint,
        sourceDescription,
        targetDescription,
        replacementScope,
        promptMode,
        manualPrompt,
        locationGuideNodeId,
      ],
    );

    const handleArrange = React.useCallback(async () => {
      setSubmitting(true);
      setStatusText("");
      try {
        const res = await arrangeCharacterReplacementOnCanvas(host, {
          controlNodeId: node.id,
          shotTitle,
          position,
          genderHint,
          sourceDescription,
          targetDescription,
          replacementScope,
          promptMode,
          manualPrompt,
          sourceKeyframeNodeId,
          targetCharacterNodeId,
          locationGuideNodeId,
          sourceVideoNodeId,
        });
        const warnSuffix =
          res.missingReferences?.length > 0
            ? `（提示：尚未绑定 ${res.missingReferences.join("、")}，生成前请手动连线）`
            : "";
        const msg = `已创建两阶段换人节点：关键帧 (${res.keyframeNodeId}) → 视频元素替换 (${res.videoNodeId})${warnSuffix}`;
        setStatusText(msg);
        host.ui?.notify?.(msg, "success");
      } catch (err) {
        const msg = err?.message || "创建角色替换管线失败";
        setStatusText(msg);
        host.ui?.notify?.(msg, "error");
      } finally {
        setSubmitting(false);
      }
    }, [
      node.id,
      shotTitle,
      position,
      genderHint,
      sourceDescription,
      targetDescription,
      replacementScope,
      promptMode,
      manualPrompt,
      sourceKeyframeNodeId,
      targetCharacterNodeId,
      locationGuideNodeId,
      sourceVideoNodeId,
    ]);

    return h(
      "div",
      {
        "data-testid": "character-replacement-node",
        "data-plugin-node": "character-replacement",
        style: {
          width: "100%",
          height: "100%",
          padding: 14,
          paddingTop: 38,
          borderRadius: 12,
          background:
            "linear-gradient(155deg, rgba(16, 185, 129, 0.14), rgba(59, 130, 246, 0.12))",
          border: "1px solid rgba(16, 185, 129, 0.38)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 8,
          boxSizing: "border-box",
          overflow: "auto",
        },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 7 } },
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
            { style: { fontSize: 13, fontWeight: 700 } },
            "🎭 AI 角色替换（关键帧+视频双阶段）",
          ),
          h(
            "button",
            {
              type: "button",
              "data-testid": "character-replacement-open-studio-btn",
              onClick: (e) => {
                e.stopPropagation();
                const currentCanvasId = host.context?.getCanvasId?.();
                if (currentCanvasId) {
                  host.storage?.set?.("lastCanvasId", currentCanvasId);
                }
                host.ui?.navigate?.("/p/beeftv-plugin-character-replacement");
              },
              style: {
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid rgba(16, 185, 129, 0.45)",
                background: "rgba(16, 185, 129, 0.18)",
                color: "inherit",
                cursor: "pointer",
              },
            },
            "打开替换工作室",
          ),
        ),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 } },
          h("input", {
            type: "text",
            "data-testid": "character-replacement-shot-input",
            value: shotTitle,
            placeholder: "镜头名称（如：镜头 1）",
            onChange: (e) => {
              setShotTitle(e.target.value);
              syncPluginData({ shotTitle: e.target.value });
            },
            onClick: (e) => e.stopPropagation(),
            style: inputStyle,
          }),
          h(
            "select",
            {
              "data-testid": "character-replacement-scope-select",
              value: replacementScope,
              onChange: (e) => {
                setReplacementScope(e.target.value);
                syncPluginData({ replacementScope: e.target.value });
              },
              onClick: (e) => e.stopPropagation(),
              style: inputStyle,
            },
            REPLACEMENT_SCOPES.map((s) =>
              h("option", { key: s.value, value: s.value }, s.label),
            ),
          ),
        ),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 } },
          h(
            "select",
            {
              "data-testid": "character-replacement-position-select",
              value: position,
              onChange: (e) => {
                setPosition(e.target.value);
                syncPluginData({ position: e.target.value });
              },
              onClick: (e) => e.stopPropagation(),
              style: inputStyle,
            },
            PERSON_POSITIONS.map((p) =>
              h("option", { key: p.value, value: p.value }, p.label),
            ),
          ),
          h(
            "select",
            {
              "data-testid": "character-replacement-mode-select",
              value: promptMode,
              onChange: (e) => {
                setPromptMode(e.target.value);
                syncPluginData({ promptMode: e.target.value });
              },
              onClick: (e) => e.stopPropagation(),
              style: inputStyle,
            },
            PROMPT_MODES.map((m) =>
              h("option", { key: m.value, value: m.value }, m.label),
            ),
          ),
        ),
        h("input", {
          type: "text",
          "data-testid": "character-replacement-source-desc-input",
          value: sourceDescription,
          placeholder: "原画面被替换人物特征（如：穿黑西装的男人）",
          onChange: (e) => {
            setSourceDescription(e.target.value);
            syncPluginData({ sourceDescription: e.target.value });
          },
          onClick: (e) => e.stopPropagation(),
          style: inputStyle,
        }),
        h("input", {
          type: "text",
          "data-testid": "character-replacement-target-desc-input",
          value: targetDescription,
          placeholder: "目标新角色描述（如：戴银框眼镜酒红西装霸总）",
          onChange: (e) => {
            setTargetDescription(e.target.value);
            syncPluginData({ targetDescription: e.target.value });
          },
          onClick: (e) => e.stopPropagation(),
          style: inputStyle,
        }),
        promptMode === "manual"
          ? h("textarea", {
              "data-testid": "character-replacement-manual-prompt-input",
              value: manualPrompt,
              placeholder: "输入自定义关键帧换人提示词…",
              rows: 2,
              onChange: (e) => {
                setManualPrompt(e.target.value);
                syncPluginData({ manualPrompt: e.target.value });
              },
              onClick: (e) => e.stopPropagation(),
              style: { ...inputStyle, resize: "vertical" },
            })
          : null,
        promptMode === "positioning"
          ? h("input", {
              type: "text",
              "data-testid": "character-replacement-guide-node-input",
              value: locationGuideNodeId,
              placeholder: "定位图节点 ID（连接后作为图3）",
              onChange: (e) => {
                setLocationGuideNodeId(e.target.value);
                syncPluginData({ locationGuideNodeId: e.target.value });
              },
              onClick: (e) => e.stopPropagation(),
              style: inputStyle,
            })
          : null,
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 } },
          h("input", {
            type: "text",
            "data-testid": "character-replacement-keyframe-node-input",
            value: sourceKeyframeNodeId,
            placeholder: "原关键帧节点ID",
            onChange: (e) => {
              setSourceKeyframeNodeId(e.target.value);
              syncPluginData({ sourceKeyframeNodeId: e.target.value });
            },
            onClick: (e) => e.stopPropagation(),
            style: inputStyle,
          }),
          h("input", {
            type: "text",
            "data-testid": "character-replacement-target-node-input",
            value: targetCharacterNodeId,
            placeholder: "目标角色图节点ID",
            onChange: (e) => {
              setTargetCharacterNodeId(e.target.value);
              syncPluginData({ targetCharacterNodeId: e.target.value });
            },
            onClick: (e) => e.stopPropagation(),
            style: inputStyle,
          }),
          h("input", {
            type: "text",
            "data-testid": "character-replacement-video-node-input",
            value: sourceVideoNodeId,
            placeholder: "原视频节点ID",
            onChange: (e) => {
              setSourceVideoNodeId(e.target.value);
              syncPluginData({ sourceVideoNodeId: e.target.value });
            },
            onClick: (e) => e.stopPropagation(),
            style: inputStyle,
          }),
        ),
        h(
          "div",
          {
            "data-testid": "character-replacement-prompt-preview",
            style: {
              padding: "6px 8px",
              borderRadius: 6,
              background: "rgba(15, 23, 42, 0.45)",
              fontSize: 11,
              lineHeight: 1.4,
              maxHeight: 68,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              opacity: 0.9,
            },
          },
          compiled.prompt,
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        statusText
          ? h(
              "div",
              {
                "data-testid": "character-replacement-status",
                style: { fontSize: 11, opacity: 0.88, lineHeight: 1.35 },
              },
              statusText,
            )
          : null,
        h(
          "button",
          {
            type: "button",
            "data-testid": "character-replacement-submit-btn",
            disabled: submitting,
            onClick: (e) => {
              e.stopPropagation();
              void handleArrange();
            },
            style: {
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              background: "#10b981",
              color: "#ffffff",
              fontSize: 12,
              fontWeight: 600,
              cursor: submitting ? "wait" : "pointer",
            },
          },
          submitting ? "正在编排双阶段替换节点…" : "一键编排关键帧+视频替换管线",
        ),
      ),
    );
  };
}
