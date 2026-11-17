import {
  GENDER_HINTS,
  PERSON_POSITIONS,
  PROMPT_MODES,
  REPLACEMENT_SCOPES,
  buildCharacterReplacementPackage,
} from "./compiler.js";
import {
  arrangeCharacterReplacementOnCanvas,
  resolveActiveCanvasId,
  resolveActiveCanvasIdAsync,
  spliceReplacedShotsIntoTimeline,
} from "./canvas-arrangement.js";
import { renderTimelineSpliceStep } from "./studio-timeline-step.js";
import { STUDIO_STEP_TABS, inputStyle, resolveBannerColors } from "./ui-shared.js";

/**
 * 构建 AI 角色替换工作室工作台组件（支持独立全屏页与画布侧栏）。
 */
export function createCharacterReplacementStudioWorkbench(host, React) {
  const h = React ? React.createElement : () => null;

  return function CharacterReplacementStudioWorkbench({ compact = false } = {}) {
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
          autoCreateCanvas: true,
          autoCreateInputNodes: true,
        });
        if (res.canvasId) setTargetCanvasId(res.canvasId);
        if (res.sourceKeyframeNodeId) setSourceKeyframeNodeId(res.sourceKeyframeNodeId);
        if (res.targetCharacterNodeId) setTargetCharacterNodeId(res.targetCharacterNodeId);
        if (res.locationGuideNodeId) setLocationGuideNodeId(res.locationGuideNodeId);
        if (res.sourceVideoNodeId) setSourceVideoNodeId(res.sourceVideoNodeId);
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

    const bannerColors = resolveBannerColors(studioMessageTone);

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
            placeholder: "目标画布 ID（留空自动绑定或新建）",
            style: { ...inputStyle, width: compact ? 160 : 210 },
          }),
          targetCanvasId
            ? h(
                "button",
                {
                  type: "button",
                  "data-testid": "studio-open-canvas-btn",
                  onClick: () => host.ui?.navigate?.(`/canvas/${encodeURIComponent(targetCanvasId)}`),
                  style: {
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: "1px solid rgba(16, 185, 129, 0.55)",
                    background: "rgba(16, 185, 129, 0.16)",
                    color: "#10b981",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  },
                },
                "打开目标画布 →",
              )
            : null,
          STUDIO_STEP_TABS.map((tab) =>
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
        : renderTimelineSpliceStep(h, {
            fullVideoNodeId,
            setFullVideoNodeId,
            fullDurationSec,
            setFullDurationSec,
            replacedVideoNodeId,
            setReplacedVideoNodeId,
            rangeStartSec,
            setRangeStartSec,
            rangeEndSec,
            setRangeEndSec,
            keepOriginalAudio,
            setKeepOriginalAudio,
            working,
            onSpliceTimeline: handleSpliceTimeline,
          }),

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
  };
}
