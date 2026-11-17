export const inputStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(148, 163, 184, 0.35)",
  background: "rgba(15, 23, 42, 0.35)",
  color: "inherit",
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
};

export const STUDIO_STEP_TABS = [
  { step: 1, label: "1. 角色与范围绑定" },
  { step: 2, label: "2. 关键帧提示词与定位框" },
  { step: 3, label: "3. 视频动作替换管线" },
  { step: 4, label: "4. 全片区间无损回插" },
];

export function resolveBannerColors(tone) {
  if (tone === "error") {
    return {
      background: "rgba(239, 68, 68, 0.14)",
      border: "1px solid rgba(239, 68, 68, 0.45)",
      color: "#fca5a5",
    };
  }
  if (tone === "warning") {
    return {
      background: "rgba(245, 158, 11, 0.14)",
      border: "1px solid rgba(245, 158, 11, 0.45)",
      color: "#fcd34d",
    };
  }
  return {
    background: "rgba(16, 185, 129, 0.14)",
    border: "1px solid rgba(16, 185, 129, 0.35)",
    color: "inherit",
  };
}
