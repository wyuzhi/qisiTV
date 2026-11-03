// AI 角色替换工作室客户端入口：
// 1. 挂载 character-replacement 画布节点（支持配置原人物位置/特征、目标角色、5 档替换范围、定位模式与上下游节点 ID，实时持久化至 pluginData，一键编排「关键帧换人 -> 视频元素替换」双阶段节点管线）
// 2. 挂载替换工作室独立页（/p/beeftv-plugin-character-replacement）与画布侧栏（支持目标画布绑定、多镜头配置、定位框 SVG 预览、一键推送画布与全片时间线区间无损回插）
// 3. 挂载助手工具卡片（character_replacement_arrange 与 character_replacement_splice_timeline）

import {
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
};

let lastKnownCanvasId = "";

function rememberCanvasId(host, canvasId) {
  const clean = String(canvasId || "").trim();
  if (!clean || clean === "[object Promise]") return;
  lastKnownCanvasId = clean;
  host?.storage?.set?.("lastCanvasId", clean);
}

function resolveActiveCanvasId(host, explicitCanvasId) {
  const explicit = String(explicitCanvasId || "").trim();
  if (explicit && explicit !== "[object Promise]") return explicit;
  const fromContext = String(host?.context?.getCanvasId?.() || "").trim();
  if (fromContext && fromContext !== "[object Promise]") {
    rememberCanvasId(host, fromContext);
    return fromContext;
  }
  const rawStorage = host?.storage?.get?.("lastCanvasId");
  if (typeof rawStorage === "string") {
    const clean = rawStorage.trim();
    if (clean && clean !== "[object Promise]") {
      lastKnownCanvasId = clean;
      return clean;
    }
  }
  return lastKnownCanvasId;
}

async function resolveActiveCanvasIdAsync(host, explicitCanvasId) {
  const syncId = resolveActiveCanvasId(host, explicitCanvasId);
  if (syncId) return syncId;
  try {
    const stored = await host?.storage?.get?.("lastCanvasId");
    if (typeof stored === "string") {
      const clean = stored.trim();
      if (clean && clean !== "[object Promise]") {
        lastKnownCanvasId = clean;
        return clean;
      }
    }
  } catch {
    // ignore storage read error
  }
  return "";
}

export async function arrangeCharacterReplacementOnCanvas(host, config = {}) {
  const canvasId = await resolveActiveCanvasIdAsync(host, config.canvasId);
  if (!canvasId) {
    throw new Error("请先打开一个画布或在替换工作室填写目标画布 ID 后再执行角色替换编排");
  }
  rememberCanvasId(host, canvasId);

  const sourceKeyframeNodeId = String(config.sourceKeyframeNodeId || "").trim();
  const targetCharacterNodeId = String(config.targetCharacterNodeId || "").trim();
  const locationGuideNodeId = String(config.locationGuideNodeId || "").trim();
  const sourceVideoNodeId = String(config.sourceVideoNodeId || "").trim();
  const controlNodeId = String(config.controlNodeId || "").trim();

  const missingReferences = [];
  if (!sourceKeyframeNodeId) missingReferences.push("sourceKeyframeNodeId（原关键帧图节点）");
  if (!targetCharacterNodeId) missingReferences.push("targetCharacterNodeId（目标角色参考图节点）");
  if (!sourceVideoNodeId) missingReferences.push("sourceVideoNodeId（原镜头视频节点）");
  if (config.requireReferences && missingReferences.length > 0) {
    throw new Error(`缺少必需的上游参考节点：${missingReferences.join("、")}`);
  }

  const snap = await host.ops.call("canvas.get", { canvasId });
  let revision = Number(snap?.revision ?? snap?.canvas?.revision ?? 1);
  const existingNodes = Array.isArray(snap?.nodes)
    ? snap.nodes
    : Array.isArray(snap?.canvas?.nodes)
      ? snap.canvas.nodes
      : [];
  const existingTitles = new Set(
    existingNodes
      .map((item) => String(item?.title || "").trim())
      .filter(Boolean),
  );

  const shotTitle = String(config.shotTitle || "镜头 1").trim() || "镜头 1";
  const hasLocationGuideImage =
    config.hasLocationGuideImage !== undefined
      ? Boolean(config.hasLocationGuideImage)
      : Boolean(locationGuideNodeId);
  const compiled = buildCharacterReplacementPackage({
    ...config,
    hasLocationGuideImage,
  });
  const keyframeTitle = uniqueNodeTitle(`${shotTitle} · 关键帧换人`, existingTitles);
  const videoTitle = uniqueNodeTitle(`${shotTitle} · 视频角色替换`, existingTitles);

  const created = await host.ops.call("canvas.nodes.create", {
    canvasId,
    expectedRevision: revision,
    nodes: [
      {
        title: keyframeTitle,
        type: "image",
        prompt: compiled.prompt,
      },
      {
        title: videoTitle,
        type: "video",
        prompt: compiled.videoPrompt,
      },
    ],
  });
  revision = Number(created?.revision ?? revision + 1);
  const createdList = Array.isArray(created?.created) ? created.created : [];
  const keyframeNodeId = createdList[0]?.id || "";
  const videoNodeId = createdList[1]?.id || "";

  if (videoNodeId) {
    const configured = await host.ops.call("canvas.node.configure", {
      canvasId,
      nodeId: videoNodeId,
      kind: "video",
      expectedRevision: revision,
      patch: {
        videoEditOperation: "replace_element",
      },
    });
    revision = Number(configured?.revision ?? revision + 1);
  }

  const edgesToCreate = [];

  if (sourceKeyframeNodeId && keyframeNodeId) {
    edgesToCreate.push([sourceKeyframeNodeId, keyframeNodeId]);
  }
  if (targetCharacterNodeId && keyframeNodeId && targetCharacterNodeId !== sourceKeyframeNodeId) {
    edgesToCreate.push([targetCharacterNodeId, keyframeNodeId]);
  }
  if (
    locationGuideNodeId &&
    keyframeNodeId &&
    locationGuideNodeId !== sourceKeyframeNodeId &&
    locationGuideNodeId !== targetCharacterNodeId
  ) {
    edgesToCreate.push([locationGuideNodeId, keyframeNodeId]);
  }
  if (
    controlNodeId &&
    keyframeNodeId &&
    controlNodeId !== sourceKeyframeNodeId &&
    controlNodeId !== targetCharacterNodeId &&
    controlNodeId !== locationGuideNodeId
  ) {
    edgesToCreate.push([controlNodeId, keyframeNodeId]);
  }
  if (sourceVideoNodeId && videoNodeId) {
    edgesToCreate.push([sourceVideoNodeId, videoNodeId]);
  }
  if (keyframeNodeId && videoNodeId) {
    edgesToCreate.push([keyframeNodeId, videoNodeId]);
  }

  for (const [fromNodeId, toNodeId] of edgesToCreate) {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
    const edgeRes = await host.ops.call("canvas.edge.create", {
      canvasId,
      fromNodeId,
      toNodeId,
      expectedRevision: revision,
    });
    revision = Number(edgeRes?.revision ?? revision);
  }

  return {
    canvasId,
    revision,
    keyframeNodeId,
    videoNodeId,
    keyframePrompt: compiled.prompt,
    videoPrompt: compiled.videoPrompt,
    locationGuide: compiled.locationGuide,
    missingReferences,
  };
}

export async function spliceReplacedShotsIntoTimeline(host, params = {}) {
  const canvasId = await resolveActiveCanvasIdAsync(host, params.canvasId);
  if (!canvasId) {
    throw new Error("请先打开目标画布或在替换工作室填写目标画布 ID 后再执行全片时间线回插");
  }
  rememberCanvasId(host, canvasId);

  const snap = await host.ops.call("canvas.get", { canvasId });
  const revision = Number(snap?.revision ?? snap?.canvas?.revision ?? 1);
  const existingNodes = Array.isArray(snap?.nodes)
    ? snap.nodes
    : Array.isArray(snap?.canvas?.nodes)
      ? snap.canvas.nodes
      : [];
  const existingTimeline = snap?.canvas?.timeline ?? snap?.timeline ?? null;

  const nodeDurationMap = new Map();
  for (const node of existingNodes) {
    const id = String(node?.id || "").trim();
    const dur = Number(node?.metadata?.durationMs);
    if (id && Number.isFinite(dur) && dur > 0) {
      nodeDurationMap.set(id, Math.round(dur));
    }
  }

  const fullVideoNodeId = String(params.fullVideoNodeId || "").trim();
  const detectedFullDurationMs = nodeDurationMap.get(fullVideoNodeId);
  const callerFullDurationMs = Number(params.fullDurationMs);
  let resolvedFullDurationMs = callerFullDurationMs;
  if (Number.isFinite(detectedFullDurationMs) && detectedFullDurationMs > 0) {
    if (!Number.isFinite(callerFullDurationMs) || callerFullDurationMs <= 0) {
      resolvedFullDurationMs = detectedFullDurationMs;
    } else if (Math.abs(callerFullDurationMs - detectedFullDurationMs) > 250) {
      throw new Error(
        `填写的全片总时长（${callerFullDurationMs}ms）与原全片节点实际时长（${detectedFullDurationMs}ms）不一致，请核对后重试`,
      );
    }
  }

  const enrichedReplacements = Array.isArray(params.replacements)
    ? params.replacements.map((item) => {
        const repNodeId = String(item?.nodeId || item?.replacedVideoNodeId || "").trim();
        const detectedRepDur = nodeDurationMap.get(repNodeId);
        return {
          ...item,
          sourceDurationMs: item?.sourceDurationMs ?? detectedRepDur,
        };
      })
    : [];

  const timeline = buildTimelineRangeReplacement({
    ...params,
    fullDurationMs: resolvedFullDurationMs,
    replacements: enrichedReplacements,
    existingTimeline: params.existingTimeline !== undefined ? params.existingTimeline : existingTimeline,
  });

  const updated = await host.ops.call("canvas.timeline.update", {
    canvasId,
    expectedRevision: revision,
    timeline,
  });
  return {
    canvasId,
    revision: Number(updated?.revision ?? revision + 1),
    timeline,
  };
}

const inputStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(148, 163, 184, 0.35)",
  background: "rgba(15, 23, 42, 0.35)",
  color: "inherit",
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
};

export function activate(host) {
  const React = host.React;
  const h = React ? React.createElement : () => null;

  function CharacterReplacementNodeCard(props) {
    const node = props?.node || {};
    const pluginData = node?.metadata?.pluginData || {};

    const [shotTitle, setShotTitle] = React.useState(
      () => String(pluginData.shotTitle || node.title || "镜头 1"),
    );
    const [position, setPosition] = React.useState(
      () => normalizePosition(pluginData.position || "left"),
    );
    const [genderHint, setGenderHint] = React.useState(
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
  }

  function CharacterReplacementStudioWorkbench({ compact = false } = {}) {
    const [targetCanvasId, setTargetCanvasId] = React.useState(() =>
      resolveActiveCanvasId(host, ""),
    );
    React.useEffect(() => {
      let active = true;
      resolveActiveCanvasIdAsync(host, "").then((resolved) => {
        if (active && resolved) {
          setTargetCanvasId((prev) => prev || resolved);
        }
      });
      return () => {
        active = false;
      };
    }, []);
    const [activeStep, setActiveStep] = React.useState(1);
    const [shotTitle, setShotTitle] = React.useState("镜头 1");
    const [position, setPosition] = React.useState("left");
    const [genderHint, setGenderHint] = React.useState("male");
    const [sourceDescription, setSourceDescription] = React.useState("穿黑色西装的男人");
    const [targetDescription, setTargetDescription] = React.useState(
      "戴银框眼镜、穿酒红色丝绒西装的年轻霸总",
    );
    const [replacementScope, setReplacementScope] = React.useState("full-person");
    const [promptMode, setPromptMode] = React.useState("regular");
    const [manualPrompt, setManualPrompt] = React.useState("");
    const [sourceKeyframeNodeId, setSourceKeyframeNodeId] = React.useState("");
    const [targetCharacterNodeId, setTargetCharacterNodeId] = React.useState("");
    const [locationGuideNodeId, setLocationGuideNodeId] = React.useState("");
    const [sourceVideoNodeId, setSourceVideoNodeId] = React.useState("");

    // Step 4: 全片时间线区间回插状态
    const [fullVideoNodeId, setFullVideoNodeId] = React.useState("");
    const [fullDurationSec, setFullDurationSec] = React.useState("");
    const [replacedVideoNodeId, setReplacedVideoNodeId] = React.useState("");
    const [rangeStartSec, setRangeStartSec] = React.useState("1");
    const [rangeEndSec, setRangeEndSec] = React.useState("3");
    const [keepOriginalAudio, setKeepOriginalAudio] = React.useState(true);
    const [studioMessage, setStudioMessage] = React.useState("");
    const [studioMessageTone, setStudioMessageTone] = React.useState("success");
    const [working, setWorking] = React.useState(false);

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
          hasLocationGuideImage:
            promptMode === "positioning" && Boolean(locationGuideNodeId),
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

    const handlePushPipeline = React.useCallback(async () => {
      setWorking(true);
      setStudioMessage("");
      try {
        const res = await arrangeCharacterReplacementOnCanvas(host, {
          canvasId: targetCanvasId,
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
        setReplacedVideoNodeId(res.videoNodeId);
        const hasMissing = res.missingReferences?.length > 0;
        const warnText = hasMissing
          ? `（注意：尚未绑定 ${res.missingReferences.join("、")}，生成前请在画布连线）`
          : "";
        const msg = `已在画布（${res.canvasId}）创建「${shotTitle}」两阶段替换管线：关键帧节点 ${res.keyframeNodeId} → 视频元素替换节点 ${res.videoNodeId}${warnText}`;
        setStudioMessageTone(hasMissing ? "warning" : "success");
        setStudioMessage(msg);
        host.ui?.notify?.(msg, hasMissing ? "warning" : "success");
      } catch (err) {
        const msg = err?.message || "推送画布管线失败";
        setStudioMessageTone("error");
        setStudioMessage(msg);
        host.ui?.notify?.(msg, "error");
      } finally {
        setWorking(false);
      }
    }, [
      targetCanvasId,
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

    const handleSpliceTimeline = React.useCallback(async () => {
      setWorking(true);
      setStudioMessage("");
      try {
        const parsedSec = Number(fullDurationSec);
        const fullDurationMs =
          Number.isFinite(parsedSec) && parsedSec > 0
            ? Math.round(parsedSec * 1000)
            : undefined;
        const startMs = Math.round(Number(rangeStartSec) * 1000);
        const endMs = Math.round(Number(rangeEndSec) * 1000);
        const res = await spliceReplacedShotsIntoTimeline(host, {
          canvasId: targetCanvasId,
          fullVideoNodeId,
          fullDurationMs,
          keepOriginalAudio,
          replacements: [
            {
              nodeId: replacedVideoNodeId,
              startMs,
              endMs,
            },
          ],
        });
        const msg = `已将替换视频 (${replacedVideoNodeId}) 无损回插至画布（${res.canvasId}）全片时间线 ${rangeStartSec}s ~ ${rangeEndSec}s（共 ${res.timeline.clips.length} 个片段，版本 r${res.revision}）`;
        setStudioMessageTone("success");
        setStudioMessage(msg);
        host.ui?.notify?.(msg, "success");
      } catch (err) {
        const msg = err?.message || "回插全片时间线失败";
        setStudioMessageTone("error");
        setStudioMessage(msg);
        host.ui?.notify?.(msg, "error");
      } finally {
        setWorking(false);
      }
    }, [
      targetCanvasId,
      fullVideoNodeId,
      fullDurationSec,
      replacedVideoNodeId,
      rangeStartSec,
      rangeEndSec,
      keepOriginalAudio,
    ]);

    const bannerColors =
      studioMessageTone === "error"
        ? {
            background: "rgba(239, 68, 68, 0.14)",
            border: "1px solid rgba(239, 68, 68, 0.45)",
            color: "#fca5a5",
          }
        : studioMessageTone === "warning"
          ? {
              background: "rgba(245, 158, 11, 0.14)",
              border: "1px solid rgba(245, 158, 11, 0.45)",
              color: "#fcd34d",
            }
          : {
              background: "rgba(16, 185, 129, 0.14)",
              border: "1px solid rgba(16, 185, 129, 0.35)",
              color: "inherit",
            };

    return h(
      "div",
      {
        "data-testid": compact
          ? "character-replacement-side-panel"
          : "character-replacement-studio-page",
        style: {
          padding: compact ? 12 : 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          maxWidth: compact ? "100%" : 980,
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          },
        },
        h(
          "div",
          null,
          h(
            "h2",
            { style: { margin: 0, fontSize: compact ? 16 : 20, fontWeight: 700 } },
            "🎭 AI 角色替换工作室",
          ),
          h(
            "p",
            { style: { margin: "4px 0 0", fontSize: 12, opacity: 0.78 } },
            "两阶段高保真角色替换：Step 1 角色映射与范围锁定 → Step 2 关键帧精准换人 → Step 3 Seedance 2.5 视频元素替换 → Step 4 全片时间线无损回插",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("input", {
            type: "text",
            "data-testid": "studio-target-canvas-input",
            value: targetCanvasId,
            onChange: (e) => {
              setTargetCanvasId(e.target.value);
              if (e.target.value.trim()) {
                host.storage?.set?.("lastCanvasId", e.target.value.trim());
              }
            },
            placeholder: "目标画布 ID（自动读取当前画布）",
            style: { ...inputStyle, width: compact ? 160 : 210 },
          }),
          [
            { step: 1, label: "1. 角色与范围绑定" },
            { step: 2, label: "2. 关键帧提示词与定位框" },
            { step: 3, label: "3. 视频动作替换管线" },
            { step: 4, label: "4. 全片区间无损回插" },
          ].map((tab) =>
            h(
              "button",
              {
                key: tab.step,
                type: "button",
                "data-testid": `studio-step-tab-${tab.step}`,
                onClick: () => setActiveStep(tab.step),
                style: {
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(16, 185, 129, 0.4)",
                  background:
                    activeStep === tab.step
                      ? "rgba(16, 185, 129, 0.22)"
                      : "transparent",
                  color: "inherit",
                  fontSize: 12,
                  fontWeight: activeStep === tab.step ? 600 : 400,
                  cursor: "pointer",
                },
              },
              tab.label,
            ),
          ),
        ),
      ),

      // Step 1 ~ 3 配置与提示词预览卡片
      activeStep !== 4
        ? h(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: compact ? "1fr" : "1.1fr 0.9fr",
                gap: 16,
              },
            },
            h(
              "div",
              {
                style: {
                  padding: 16,
                  borderRadius: 12,
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                },
              },
              h(
                "div",
                { style: { fontWeight: 600, fontSize: 14 } },
                "镜头与角色绑定参数",
              ),
              h(
                "div",
                { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                h("input", {
                  type: "text",
                  "data-testid": "studio-shot-title-input",
                  value: shotTitle,
                  onChange: (e) => setShotTitle(e.target.value),
                  placeholder: "镜头名称",
                  style: inputStyle,
                }),
                h(
                  "select",
                  {
                    "data-testid": "studio-scope-select",
                    value: replacementScope,
                    onChange: (e) => setReplacementScope(e.target.value),
                    style: inputStyle,
                  },
                  REPLACEMENT_SCOPES.map((s) =>
                    h("option", { key: s.value, value: s.value }, s.label),
                  ),
                ),
              ),
              h(
                "div",
                {
                  style: {
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8,
                  },
                },
                h(
                  "select",
                  {
                    "data-testid": "studio-position-select",
                    value: position,
                    onChange: (e) => setPosition(e.target.value),
                    style: inputStyle,
                  },
                  PERSON_POSITIONS.map((p) =>
                    h("option", { key: p.value, value: p.value }, p.label),
                  ),
                ),
                h(
                  "select",
                  {
                    "data-testid": "studio-gender-select",
                    value: genderHint,
                    onChange: (e) => setGenderHint(e.target.value),
                    style: inputStyle,
                  },
                  GENDER_HINTS.map((g) =>
                    h("option", { key: g.value, value: g.value }, g.label),
                  ),
                ),
                h(
                  "select",
                  {
                    "data-testid": "studio-prompt-mode-select",
                    value: promptMode,
                    onChange: (e) => setPromptMode(e.target.value),
                    style: inputStyle,
                  },
                  PROMPT_MODES.map((m) =>
                    h("option", { key: m.value, value: m.value }, m.label),
                  ),
                ),
              ),
              h("input", {
                type: "text",
                "data-testid": "studio-source-desc-input",
                value: sourceDescription,
                onChange: (e) => setSourceDescription(e.target.value),
                placeholder: "原视频被替换人物描述（如：左边穿黑西装的男人）",
                style: inputStyle,
              }),
              h("input", {
                type: "text",
                "data-testid": "studio-target-desc-input",
                value: targetDescription,
                onChange: (e) => setTargetDescription(e.target.value),
                placeholder: "目标替换角色描述（如：戴银框眼镜酒红丝绒西装霸总）",
                style: inputStyle,
              }),
              promptMode === "manual"
                ? h("textarea", {
                    "data-testid": "studio-manual-prompt-input",
                    value: manualPrompt,
                    onChange: (e) => setManualPrompt(e.target.value),
                    placeholder: "输入自定义关键帧换人提示词…",
                    rows: 3,
                    style: { ...inputStyle, resize: "vertical" },
                  })
                : null,
              promptMode === "positioning"
                ? h("input", {
                    type: "text",
                    "data-testid": "studio-guide-node-input",
                    value: locationGuideNodeId,
                    onChange: (e) => setLocationGuideNodeId(e.target.value),
                    placeholder: "定位图节点 ID（连接后作为图3）",
                    style: inputStyle,
                  })
                : null,
              h(
                "div",
                {
                  style: {
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8,
                  },
                },
                h("input", {
                  type: "text",
                  value: sourceKeyframeNodeId,
                  onChange: (e) => setSourceKeyframeNodeId(e.target.value),
                  placeholder: "原关键帧节点 ID（可选）",
                  style: inputStyle,
                }),
                h("input", {
                  type: "text",
                  value: targetCharacterNodeId,
                  onChange: (e) => setTargetCharacterNodeId(e.target.value),
                  placeholder: "目标角色图节点 ID（可选）",
                  style: inputStyle,
                }),
                h("input", {
                  type: "text",
                  value: sourceVideoNodeId,
                  onChange: (e) => setSourceVideoNodeId(e.target.value),
                  placeholder: "原镜头视频节点 ID（可选）",
                  style: inputStyle,
                }),
              ),
              h(
                "button",
                {
                  type: "button",
                  "data-testid": "studio-push-canvas-btn",
                  disabled: working,
                  onClick: () => void handlePushPipeline(),
                  style: {
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: "none",
                    background: "#10b981",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: working ? "wait" : "pointer",
                  },
                },
                working
                  ? "正在向目标画布编排节点…"
                  : "一键在目标画布生成「关键帧换人 + 视频替换」双阶段管线",
              ),
            ),
            h(
              "div",
              {
                style: {
                  padding: 16,
                  borderRadius: 12,
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                },
              },
              h(
                "div",
                { style: { fontWeight: 600, fontSize: 14 } },
                "编译后双阶段提示词预览",
              ),
              h(
                "div",
                { style: { fontSize: 12, opacity: 0.78 } },
                "阶段一（Step 2 关键帧人物替换提示词）：",
              ),
              h(
                "pre",
                {
                  "data-testid": "studio-compiled-image-prompt",
                  style: {
                    margin: 0,
                    padding: 10,
                    borderRadius: 8,
                    background: "rgba(15, 23, 42, 0.55)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  },
                },
                compiled.prompt,
              ),
              h(
                "div",
                { style: { fontSize: 12, opacity: 0.78 } },
                "阶段二（Step 3 Seedance 2.5 元素替换 replace_element 提示词）：",
              ),
              h(
                "pre",
                {
                  "data-testid": "studio-compiled-video-prompt",
                  style: {
                    margin: 0,
                    padding: 10,
                    borderRadius: 8,
                    background: "rgba(15, 23, 42, 0.55)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  },
                },
                compiled.videoPrompt,
              ),
              compiled.locationGuide
                ? h(
                    "div",
                    {
                      "data-testid": "studio-location-guide-preview",
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      },
                    },
                    h(
                      "span",
                      { style: { fontSize: 12, opacity: 0.8 } },
                      `多人定位辅助图（${compiled.locationGuide.width}x${compiled.locationGuide.height}）：`,
                    ),
                    h("img", {
                      src: compiled.locationGuide.dataUrl,
                      alt: "人物定位图",
                      style: {
                        width: "100%",
                        maxHeight: 160,
                        objectFit: "contain",
                        borderRadius: 8,
                        border: "1px solid rgba(148, 163, 184, 0.3)",
                      },
                    }),
                  )
                : null,
            ),
          )
        : // Step 4: 全片时间线无损区间回插面板
          h(
            "div",
            {
              "data-testid": "studio-step4-timeline-panel",
              style: {
                padding: 16,
                borderRadius: 12,
                border: "1px solid rgba(148, 163, 184, 0.25)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              },
            },
            h(
              "div",
              { style: { fontWeight: 600, fontSize: 15 } },
              "Step 4 · 全片时间线区间无损回插（完整插入全片）",
            ),
            h(
              "p",
              { style: { margin: 0, fontSize: 12, opacity: 0.8 } },
              "将替换完成的单镜头视频节点按精确起止秒数切入原全片视频，自动生成「原片前段 → 替换镜头 → 原片后段」的完整时间线，保留画布既有字幕/BGM 轨道，并可选择保留原片连续同期声轨。",
            ),
            h(
              "div",
              { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
              h("input", {
                type: "text",
                "data-testid": "studio-full-video-node-input",
                value: fullVideoNodeId,
                onChange: (e) => setFullVideoNodeId(e.target.value),
                placeholder: "原全片视频节点 ID（必填）",
                style: inputStyle,
              }),
              h("input", {
                type: "number",
                "data-testid": "studio-full-duration-input",
                value: fullDurationSec,
                onChange: (e) => setFullDurationSec(e.target.value),
                placeholder: "原全片总时长（秒，留空自动读取节点时长）",
                style: inputStyle,
              }),
            ),
            h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 10,
                },
              },
              h("input", {
                type: "text",
                "data-testid": "studio-replaced-video-node-input",
                value: replacedVideoNodeId,
                onChange: (e) => setReplacedVideoNodeId(e.target.value),
                placeholder: "替换后镜头视频节点 ID（必填）",
                style: inputStyle,
              }),
              h("input", {
                type: "number",
                "data-testid": "studio-range-start-input",
                value: rangeStartSec,
                onChange: (e) => setRangeStartSec(e.target.value),
                placeholder: "替换起点（秒，如 3）",
                style: inputStyle,
              }),
              h("input", {
                type: "number",
                "data-testid": "studio-range-end-input",
                value: rangeEndSec,
                onChange: (e) => setRangeEndSec(e.target.value),
                placeholder: "替换终点（秒，如 8）",
                style: inputStyle,
              }),
            ),
            h(
              "label",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  cursor: "pointer",
                },
              },
              h("input", {
                type: "checkbox",
                "data-testid": "studio-keep-audio-checkbox",
                checked: keepOriginalAudio,
                onChange: (e) => setKeepOriginalAudio(e.target.checked),
              }),
              "保留原全片连续原声轨（静音视频片段轨，叠加完整原片音轨防接缝断音）",
            ),
            h(
              "button",
              {
                type: "button",
                "data-testid": "studio-splice-timeline-btn",
                disabled: working,
                onClick: () => void handleSpliceTimeline(),
                style: {
                  padding: "10px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontWeight: 600,
                  cursor: working ? "wait" : "pointer",
                },
              },
              working
                ? "正在写入全片时间线…"
                : "一键将替换镜头无损回插至全片时间线",
            ),
          ),

      studioMessage
        ? h(
            "div",
            {
              "data-testid": "studio-status-banner",
              role: studioMessageTone === "error" ? "alert" : "status",
              style: {
                padding: "10px 14px",
                borderRadius: 8,
                fontSize: 12,
                ...bannerColors,
              },
            },
            studioMessage,
          )
        : null,
    );
  }

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
