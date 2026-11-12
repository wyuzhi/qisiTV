// AI 角色替换工作室核心编译器：
// 1. 关键帧换人提示词编译器（支持常规描述定位、SVG 定位框辅助、手动模式，以及 5 档替换范围）
// 2. 多人定位图 SVG 生成器（供多人物同框防串脸定位参考）
// 3. 第二阶段视频角色替换（replace_element）提示词编译器
// 4. 全片时间线无损区间回插（Timeline v2 切片、原声保留与已有字幕/音轨合并）构建器

export const REPLACEMENT_SCOPES = [
  { value: "full-person", label: "完整人物（外观+服装）", phrase: "完整人物" },
  { value: "visible-part", label: "当前可见部分", phrase: "当前可见部分" },
  { value: "face-hair", label: "脸部和头发", phrase: "脸部和头发" },
  { value: "clothing", label: "仅服装", phrase: "服装" },
  { value: "arm-hand", label: "手臂和手部", phrase: "手臂和手部" },
];

export const PERSON_POSITIONS = [
  { value: "single", label: "单人画面（唯一主角）" },
  { value: "left", label: "左侧人物（双人/多人左位）" },
  { value: "center", label: "中间人物（三人/多人中位）" },
  { value: "right", label: "右侧人物（双人/多人右位）" },
];

export const GENDER_HINTS = [
  { value: "person", label: "人物（不限性别）", noun: "人" },
  { value: "male", label: "男性角色", noun: "男人" },
  { value: "female", label: "女性角色", noun: "女人" },
];

export const PROMPT_MODES = [
  { value: "regular", label: "常规位置描述（推荐）" },
  { value: "positioning", label: "SVG 定位框辅助（多人同框）" },
  { value: "manual", label: "自定义提示词" },
];

export const MARKER_HEX_COLORS = [
  "#ef4444",
  "#06b6d4",
  "#eab308",
  "#22c55e",
  "#a855f7",
  "#f97316",
  "#ec4899",
  "#3b82f6",
];

const SCOPE_MAP = new Map(REPLACEMENT_SCOPES.map((item) => [item.value, item.phrase]));
const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function cleanText(value) {
  return String(value ?? "").trim();
}

export function uniqueNodeTitle(baseTitle, existingTitles) {
  const clean = cleanText(baseTitle) || "节点";
  const set = existingTitles instanceof Set ? existingTitles : new Set();
  if (!set.has(clean)) {
    set.add(clean);
    return clean;
  }
  let suffix = 2;
  while (set.has(`${clean} #${suffix}`)) {
    suffix += 1;
  }
  const candidate = `${clean} #${suffix}`;
  set.add(candidate);
  return candidate;
}

export function normalizeReplacementScope(scope) {
  const normalized = cleanText(scope).toLowerCase();
  return SCOPE_MAP.has(normalized) ? normalized : "full-person";
}

export function normalizePosition(position) {
  const normalized = cleanText(position).toLowerCase();
  if (normalized === "left" || normalized === "center" || normalized === "right" || normalized === "single") {
    return normalized;
  }
  return "single";
}

export function normalizeGenderHint(genderHint) {
  const raw = cleanText(genderHint).toLowerCase();
  if (["male", "man", "男", "男性", "男人"].includes(raw)) return "male";
  if (["female", "woman", "女", "女性", "女人"].includes(raw)) return "female";
  return "person";
}

export function normalizePromptMode(mode) {
  const raw = cleanText(mode).toLowerCase();
  if (raw === "positioning" || raw === "manual") return raw;
  return "regular";
}

function genderNounFor(genderHint) {
  const normalized = normalizeGenderHint(genderHint);
  if (normalized === "male") return "男人";
  if (normalized === "female") return "女人";
  return "人";
}

function positionPrefixFor(position) {
  const normalized = normalizePosition(position);
  if (normalized === "left") return "左边的";
  if (normalized === "center") return "中间的";
  if (normalized === "right") return "右边的";
  return "中的";
}

export function describeSourceSubject(
  entry = {},
  index = 0,
  total = 1,
  promptMode = "regular",
  hasLocationGuideImage = true,
) {
  const markerLabel = cleanText(entry.markerLabel) || String.fromCharCode(65 + (index % 26));
  const customSource = cleanText(entry.sourceDescription);
  if (promptMode === "positioning") {
    const orderText =
      total > 1
        ? `从左到右第${index + 1}个`
        : entry.position === "left"
          ? "左侧区域"
          : entry.position === "right"
            ? "右侧区域"
            : entry.position === "center"
              ? "中间区域"
              : "画面中";
    if (hasLocationGuideImage) {
      const detail = customSource ? `（${customSource}，定位图${markerLabel}框）` : `（定位图${markerLabel}框）`;
      return `中${orderText}${detail}的人物`;
    }
    const detail = customSource ? `（${customSource}）` : "";
    return `中${orderText}${detail}的人物`;
  }
  const prefix = positionPrefixFor(entry.position);
  const noun = genderNounFor(entry.genderHint);
  if (customSource) {
    if (
      customSource.startsWith("左边") ||
      customSource.startsWith("右边") ||
      customSource.startsWith("中间") ||
      customSource.startsWith("从左到右")
    ) {
      return `中${customSource}`;
    }
    return `${prefix}${customSource}`;
  }
  if (total > 3) {
    return `从左到右第${index + 1}个${noun}`;
  }
  return `${prefix}${noun}`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizeMarkerColor(rawColor, fallbackIndex = 0) {
  const candidate = cleanText(rawColor);
  if (SAFE_HEX_COLOR_RE.test(candidate)) {
    return candidate;
  }
  const safeIdx = Math.abs(Math.trunc(Number(fallbackIndex) || 0)) % MARKER_HEX_COLORS.length;
  return MARKER_HEX_COLORS[safeIdx];
}

function normalizeBbox(bbox, index = 0, total = 1) {
  if (bbox && typeof bbox === "object") {
    const x = Number(bbox.x);
    const y = Number(bbox.y);
    const width = Number(bbox.width);
    const height = Number(bbox.height);
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return {
        x: Math.max(0, Math.min(0.95, x)),
        y: Math.max(0, Math.min(0.95, y)),
        width: Math.max(0.05, Math.min(1 - Math.max(0, x), width)),
        height: Math.max(0.05, Math.min(1 - Math.max(0, y), height)),
      };
    }
  }
  const slotWidth = Math.min(0.36, 0.78 / Math.max(1, total));
  const gap = (1 - slotWidth * Math.max(1, total)) / (Math.max(1, total) + 1);
  return {
    x: Number((gap + index * (slotWidth + gap)).toFixed(3)),
    y: 0.14,
    width: Number(slotWidth.toFixed(3)),
    height: 0.74,
  };
}

export function buildLocationGuideSvgDataUrl({ frame = {}, people = [] } = {}) {
  const svgWidth = 1200;
  const frameW = Number(frame?.width) > 0 ? Number(frame.width) : 16;
  const frameH = Number(frame?.height) > 0 ? Number(frame.height) : 9;
  const svgHeight = Math.max(1, Math.round((svgWidth * frameH) / frameW));

  const gridPaths = [0.25, 0.5, 0.75]
    .map(
      (ratio) =>
        `<path d="M${Math.round(svgWidth * ratio)} 0V${svgHeight} M0 ${Math.round(svgHeight * ratio)}H${svgWidth}"/>`,
    )
    .join("");

  const normalizedPeople = Array.isArray(people) ? people : [];
  const boxesMarkup = normalizedPeople
    .map((person, index) => {
      const label = cleanText(person?.label || person?.markerLabel) || String.fromCharCode(65 + (index % 26));
      const bbox = normalizeBbox(person?.bbox ?? person?.box, index, normalizedPeople.length);
      const x = Math.round(bbox.x * svgWidth);
      const y = Math.round(bbox.y * svgHeight);
      const w = Math.round(bbox.width * svgWidth);
      const h = Math.round(bbox.height * svgHeight);
      const color = sanitizeMarkerColor(person?.color, person?.markerIndex ?? index);
      return `<g data-person-label="${escapeXml(label)}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="8"/><rect x="${x}" y="${y}" width="72" height="72" rx="8" fill="${color}"/><text x="${x + 36}" y="${y + 55}" text-anchor="middle" fill="#0f172a" font-family="Arial, sans-serif" font-size="56" font-weight="800">${escapeXml(label)}</text></g>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}"><rect width="100%" height="100%" fill="#090d16"/><g stroke="#ffffff" stroke-opacity="0.18" stroke-width="2">${gridPaths}</g>${boxesMarkup}</svg>`;
  return {
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: svgWidth,
    height: svgHeight,
    personCount: normalizedPeople.length,
  };
}

export function buildCharacterReplacementPackage(input = {}) {
  const promptMode = normalizePromptMode(input.promptMode);
  const removeSubtitlesAndLogo = input.removeSubtitlesAndLogo !== false;
  const hasLocationGuideImage =
    promptMode === "positioning" &&
    (input.hasLocationGuideImage === undefined
      ? true
      : Boolean(input.hasLocationGuideImage));

  const rawPeople =
    Array.isArray(input.people) && input.people.length > 0
      ? input.people
      : [
          {
            id: cleanText(input.personId) || "person-1",
            position: input.position ?? input.personPosition,
            genderHint: input.genderHint,
            sourceDescription: input.sourceDescription,
            targetDescription: input.targetDescription,
            replacementScope: input.replacementScope,
            bbox: input.bbox ?? input.box,
          },
        ];

  const bindings = rawPeople.slice(0, 8).map((person, index) => {
    const scope = normalizeReplacementScope(person?.replacementScope ?? input.replacementScope);
    const scopePhrase = SCOPE_MAP.get(scope) || "完整人物";
    const position = normalizePosition(
      person?.position ?? person?.personPosition ?? input.position ?? input.personPosition,
    );
    const genderHint = normalizeGenderHint(person?.genderHint ?? input.genderHint);
    const markerLabel = cleanText(person?.markerLabel) || String.fromCharCode(65 + (index % 26));
    const referenceSlot = Number(person?.referenceSlot) > 1 ? Number(person.referenceSlot) : index + 2;
    const referenceLabel = `图${referenceSlot}`;
    const targetDescription = cleanText(person?.targetDescription ?? input.targetDescription);
    const sourceDescription = cleanText(person?.sourceDescription ?? input.sourceDescription);
    const bbox = normalizeBbox(person?.bbox ?? person?.box ?? input.bbox ?? input.box, index, rawPeople.length);

    return {
      personId: cleanText(person?.id) || `person-${index + 1}`,
      position,
      genderHint,
      markerLabel,
      referenceSlot,
      referenceLabel,
      replacementScope: scope,
      scopePhrase,
      sourceDescription,
      targetDescription,
      bbox,
    };
  });

  const locationGuideSlot = hasLocationGuideImage ? bindings.length + 2 : 0;
  const locationGuide =
    promptMode === "positioning"
      ? buildLocationGuideSvgDataUrl({
          frame: input.frame,
          people: bindings.map((item, idx) => ({
            label: item.markerLabel,
            markerIndex: idx,
            bbox: item.bbox,
          })),
        })
      : null;

  if (promptMode === "manual" && cleanText(input.manualPrompt)) {
    const manual = cleanText(input.manualPrompt);
    return {
      promptMode,
      prompt: manual,
      videoPrompt: compileVideoReplacementPrompt(input),
      bindings,
      locationGuide,
      locationGuideSlot,
    };
  }

  const lines = [];
  if (hasLocationGuideImage) {
    lines.push(
      `任务：把图1中指定的人物替换成对应参考图中的人物。图${locationGuideSlot}为人物定位图。`,
    );
  } else {
    lines.push("任务：把图1中的对应人物替换成参考图中的人物。");
  }

  for (let i = 0; i < bindings.length; i += 1) {
    const item = bindings[i];
    const subjectText = describeSourceSubject(
      item,
      i,
      bindings.length,
      promptMode,
      hasLocationGuideImage,
    );
    const targetDetail = item.targetDescription ? `（${item.targetDescription}）` : "";
    if (item.replacementScope === "full-person") {
      lines.push(`把图1${subjectText}替换成${item.referenceLabel}中的人物${targetDetail}，包含外观和服装。`);
    } else {
      lines.push(
        `把图1${subjectText}的${item.scopePhrase}替换成${item.referenceLabel}中人物${targetDetail}的对应部分。`,
      );
    }
  }

  if (promptMode === "positioning") {
    lines.push(
      "去掉画面中的字幕和LOGO。保留原人物的位置、大小、姿态和遮挡关系，除字幕和LOGO外，其余人物及未指定部分保持不变，不补画画外或被遮挡部分。",
    );
    lines.push("背景和光线保持不变。");
  } else {
    lines.push(
      "保留原人物的位置、大小、姿态和遮挡关系，除字幕和LOGO外，其余人物及未指定部分保持不变，不补画画外或被遮挡部分。",
    );
    if (removeSubtitlesAndLogo) {
      lines.push("去掉画面字幕和LOGO。");
    }
  }

  const prompt = lines.filter(Boolean).join("\n");
  return {
    promptMode,
    prompt,
    videoPrompt: compileVideoReplacementPrompt(input),
    bindings,
    locationGuide,
    locationGuideSlot,
  };
}

export function compileCharacterReplacementPrompt(input = {}) {
  return buildCharacterReplacementPackage(input).prompt;
}

export function compileVideoReplacementPrompt(input = {}) {
  const customVideoPrompt = cleanText(input.videoPrompt);
  if (customVideoPrompt) return customVideoPrompt;

  const position = normalizePosition(input.position ?? input.personPosition);
  const genderHint = normalizeGenderHint(input.genderHint);
  const sourceDesc = cleanText(input.sourceDescription);
  const targetDesc = cleanText(input.targetDescription);
  const extraNotes = cleanText(input.extraNotes);
  const scope = normalizeReplacementScope(input.replacementScope);
  const scopePhrase = SCOPE_MAP.get(scope) || "完整人物";

  const subject = describeSourceSubject(
    { position, genderHint, sourceDescription: sourceDesc },
    0,
    1,
    "regular",
  ).replace(/^中/, "");

  const targetClause = targetDesc ? `参考图中的目标人物（${targetDesc}）` : "参考图中的对应人物";
  const scopeClause =
    scope === "full-person"
      ? `将原视频${subject}完整替换为${targetClause}`
      : `将原视频${subject}的${scopePhrase}替换为${targetClause}的对应部分`;
  const extraClause = extraNotes ? `，${extraNotes}` : "";

  return `${scopeClause}${extraClause}，严格保持原视频的镜头运动、人物动作节奏、手持道具、场景光影以及画面中其余人物完全不变。`;
}

export function buildTimelineRangeReplacement({
  fullVideoNodeId,
  fullDurationMs,
  replacements = [],
  keepOriginalAudio = false,
  existingTimeline = null,
  output = undefined,
} = {}) {
  const sourceNodeId = cleanText(fullVideoNodeId);
  const totalMs = Math.round(Number(fullDurationMs));
  if (!sourceNodeId) {
    throw new Error("缺少原全片视频节点 ID（fullVideoNodeId）");
  }
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new Error("原全片视频总时长（fullDurationMs）必须为大于 0 的毫秒整数");
  }
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new Error("至少需要提供 1 个替换镜头区间（replacements）");
  }

  const normalized = replacements
    .map((item, idx) => {
      const nodeId = cleanText(item?.nodeId || item?.replacedVideoNodeId);
      const startMs = Math.round(Number(item?.startMs));
      const endMs = Math.round(Number(item?.endMs));
      const sourceDurationMs = Math.round(Number(item?.sourceDurationMs));
      if (!nodeId) {
        throw new Error(`第 ${idx + 1} 个替换区间缺少替换视频节点 ID`);
      }
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
        throw new Error(`第 ${idx + 1} 个替换区间时间范围无效（${startMs}ms ~ ${endMs}ms）`);
      }
      if (endMs > totalMs) {
        throw new Error(`第 ${idx + 1} 个替换区间结束时间（${endMs}ms）超出全片总时长（${totalMs}ms）`);
      }
      const durationMs = endMs - startMs;
      return {
        nodeId,
        startMs,
        endMs,
        durationMs,
        sourceDurationMs:
          Number.isFinite(sourceDurationMs) && sourceDurationMs >= durationMs ? sourceDurationMs : durationMs,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].startMs < normalized[i - 1].endMs) {
      throw new Error(
        `替换区间不能重叠：区间 ${i}（${normalized[i - 1].startMs}~${normalized[i - 1].endMs}ms）与区间 ${i + 1}（${normalized[i].startMs}~${normalized[i].endMs}ms）冲突`,
      );
    }
  }

  const videoTrackId = "track-video-main";
  const audioTrackId = "track-audio-original";
  const managedTrackIds = new Set([videoTrackId, audioTrackId]);

  const tracks = [
    {
      id: videoTrackId,
      kind: "video",
      label: "视频主轨",
      order: 0,
      visible: true,
      muted: Boolean(keepOriginalAudio),
    },
  ];

  const clips = [];
  let cursorMs = 0;
  let clipIndex = 1;

  for (const rep of normalized) {
    if (rep.startMs > cursorMs) {
      const gapMs = rep.startMs - cursorMs;
      clips.push({
        id: `clip-orig-${clipIndex++}`,
        kind: "video",
        trackId: videoTrackId,
        nodeId: sourceNodeId,
        startMs: cursorMs,
        durationMs: gapMs,
        sourceStartMs: cursorMs,
        sourceDurationMs: totalMs,
      });
    }
    clips.push({
      id: `clip-rep-${clipIndex++}`,
      kind: "video",
      trackId: videoTrackId,
      nodeId: rep.nodeId,
      startMs: rep.startMs,
      durationMs: rep.durationMs,
      sourceStartMs: 0,
      sourceDurationMs: rep.sourceDurationMs,
    });
    cursorMs = rep.endMs;
  }

  if (cursorMs < totalMs) {
    clips.push({
      id: `clip-orig-${clipIndex++}`,
      kind: "video",
      trackId: videoTrackId,
      nodeId: sourceNodeId,
      startMs: cursorMs,
      durationMs: totalMs - cursorMs,
      sourceStartMs: cursorMs,
      sourceDurationMs: totalMs,
    });
  }

  if (keepOriginalAudio) {
    tracks.push({
      id: audioTrackId,
      kind: "audio",
      label: "原片音轨",
      order: 1,
      visible: true,
      muted: false,
    });
    clips.push({
      id: "clip-orig-full-audio",
      kind: "audio",
      trackId: audioTrackId,
      nodeId: sourceNodeId,
      startMs: 0,
      durationMs: totalMs,
      sourceStartMs: 0,
      sourceDurationMs: totalMs,
    });
  }

  // Merge preserved non-video tracks (subtitles, extra BGM/audio, text overlays) from existingTimeline
  if (existingTimeline && typeof existingTimeline === "object") {
    const prevTracks = Array.isArray(existingTimeline.tracks) ? existingTimeline.tracks : [];
    const prevClips = Array.isArray(existingTimeline.clips) ? existingTimeline.clips : [];
    const preservedTrackIds = new Set();

    for (const track of prevTracks) {
      if (!track || typeof track !== "object") continue;
      const trackId = cleanText(track.id);
      if (!trackId || managedTrackIds.has(trackId) || track.kind === "video") continue;
      preservedTrackIds.add(trackId);
      tracks.push({
        ...track,
        order: typeof track.order === "number" ? Math.max(tracks.length, track.order) : tracks.length,
      });
    }

    for (const clip of prevClips) {
      if (!clip || typeof clip !== "object") continue;
      if (preservedTrackIds.has(cleanText(clip.trackId))) {
        clips.push({ ...clip });
      }
    }
  }

  const timeline = {
    version: 2,
    durationMs: totalMs,
    tracks,
    clips,
  };
  const resolvedOutput = output !== undefined ? output : existingTimeline?.output;
  if (resolvedOutput !== undefined) {
    timeline.output = resolvedOutput;
  }
  return timeline;
}
