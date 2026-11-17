import { inputStyle } from "./ui-shared.js";

/**
 * 渲染工作室 Step 4：全片时间线无损区间回插面板。
 */
export function renderTimelineSpliceStep(h, {
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
  onSpliceTimeline,
}) {
  return h(
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
        onClick: () => void onSpliceTimeline(),
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
      working ? "正在写入全片时间线…" : "一键将替换镜头无损回插至全片时间线",
    ),
  );
}
