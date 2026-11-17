import {
  buildCharacterReplacementPackage,
  buildTimelineRangeReplacement,
  uniqueNodeTitle,
} from "./compiler.js";

let lastKnownCanvasId = "";

export function rememberCanvasId(host, canvasId) {
  const clean = String(canvasId || "").trim();
  if (!clean || clean === "[object Promise]") return;
  lastKnownCanvasId = clean;
  host?.storage?.set?.("lastCanvasId", clean);
}

export function resolveActiveCanvasId(host, explicitCanvasId) {
  const explicit = String(explicitCanvasId || "").trim();
  if (explicit && explicit !== "[object Promise]") return explicit;
  const fromContext = String(host?.context?.getCanvasId?.() || "").trim();
  if (fromContext && fromContext !== "[object Promise]") {
    rememberCanvasId(host, fromContext);
    return fromContext;
  }
  if (typeof host?.storage?.get === "function") {
    const rawStorage = host.storage.get("lastCanvasId");
    if (typeof rawStorage === "string") {
      const clean = rawStorage.trim();
      if (clean && clean !== "[object Promise]") {
        lastKnownCanvasId = clean;
        return clean;
      }
    }
    return "";
  }
  return lastKnownCanvasId;
}

export async function resolveActiveCanvasIdAsync(host, explicitCanvasId) {
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

async function createInitialCanvasDocument(host, canvasId, title) {
  const now = new Date().toISOString();
  const doc = {
    id: canvasId,
    title,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 120, y: 120, zoom: 1 },
    directorScenes: [],
  };
  return host.ops.call("canvas.document.commit", {
    canvasId,
    expectedRevision: 0,
    document: doc,
  });
}

export async function arrangeCharacterReplacementOnCanvas(host, config = {}) {
  let sourceKeyframeNodeId = String(config.sourceKeyframeNodeId || "").trim();
  let targetCharacterNodeId = String(config.targetCharacterNodeId || "").trim();
  let locationGuideNodeId = String(config.locationGuideNodeId || "").trim();
  let sourceVideoNodeId = String(config.sourceVideoNodeId || "").trim();
  const controlNodeId = String(config.controlNodeId || "").trim();

  const missingReferences = [];
  if (!sourceKeyframeNodeId) missingReferences.push("sourceKeyframeNodeId（原关键帧图节点）");
  if (!targetCharacterNodeId) missingReferences.push("targetCharacterNodeId（目标角色参考图节点）");
  if (!sourceVideoNodeId) missingReferences.push("sourceVideoNodeId（原镜头视频节点）");
  if (config.requireReferences && missingReferences.length > 0) {
    throw new Error(`缺少必需的上游参考节点：${missingReferences.join("、")}`);
  }

  const shotTitle = String(config.shotTitle || "镜头 1").trim() || "镜头 1";
  let canvasId = await resolveActiveCanvasIdAsync(host, config.canvasId);
  if (!canvasId && config.autoCreateCanvas) {
    canvasId = `canvas-char-${Date.now().toString(36)}`;
    await createInitialCanvasDocument(host, canvasId, `${shotTitle} · AI 角色替换画布`);
  }
  if (!canvasId) {
    throw new Error("请先打开一个画布或在替换工作室填写目标画布 ID 后再执行角色替换编排");
  }
  rememberCanvasId(host, canvasId);

  let snap;
  try {
    snap = await host.ops.call("canvas.get", { canvasId });
  } catch (err) {
    if (config.autoCreateCanvas) {
      await createInitialCanvasDocument(host, canvasId, `${shotTitle} · AI 角色替换画布`);
      snap = await host.ops.call("canvas.get", { canvasId });
    } else {
      throw err;
    }
  }
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

  if (config.autoCreateInputNodes) {
    const inputDrafts = [];
    const inputSlotOrder = [];
    if (!sourceKeyframeNodeId) {
      inputSlotOrder.push("sourceKeyframe");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 原视频关键帧（图1）`, existingTitles),
        type: "image",
        prompt: `原视频被替换人物关键帧：${String(config.sourceDescription || "原镜头人物").trim()}`,
      });
    }
    if (!targetCharacterNodeId) {
      inputSlotOrder.push("targetCharacter");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 目标角色参考图（图2）`, existingTitles),
        type: "image",
        prompt: `目标替换角色正面清晰参考图：${String(config.targetDescription || "目标角色").trim()}`,
      });
    }
    if (config.promptMode === "positioning" && !locationGuideNodeId) {
      inputSlotOrder.push("locationGuide");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 人物框选定位图（图3）`, existingTitles),
        type: "image",
        prompt: "多人场景人物红框定位辅助图（A框标识待替换人物区域）",
      });
    }
    if (!sourceVideoNodeId) {
      inputSlotOrder.push("sourceVideo");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 原镜头视频（视频1）`, existingTitles),
        type: "video",
        prompt: `原镜头待替换视频片段：${String(config.sourceDescription || "原镜头人物动作与运镜").trim()}`,
      });
    }
    if (inputDrafts.length > 0) {
      const createdInputs = await host.ops.call("canvas.nodes.create", {
        canvasId,
        expectedRevision: revision,
        nodes: inputDrafts,
      });
      revision = Number(createdInputs?.revision ?? revision + 1);
      const createdInputList = Array.isArray(createdInputs?.created) ? createdInputs.created : [];
      inputSlotOrder.forEach((slot, idx) => {
        const createdId = createdInputList[idx]?.id || "";
        if (!createdId) return;
        if (slot === "sourceKeyframe") sourceKeyframeNodeId = createdId;
        if (slot === "targetCharacter") targetCharacterNodeId = createdId;
        if (slot === "locationGuide") locationGuideNodeId = createdId;
        if (slot === "sourceVideo") sourceVideoNodeId = createdId;
      });
      missingReferences.length = 0;
      if (!sourceKeyframeNodeId) missingReferences.push("sourceKeyframeNodeId（原关键帧图节点）");
      if (!targetCharacterNodeId) missingReferences.push("targetCharacterNodeId（目标角色参考图节点）");
      if (!sourceVideoNodeId) missingReferences.push("sourceVideoNodeId（原镜头视频节点）");
    }
  }

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
    sourceKeyframeNodeId,
    targetCharacterNodeId,
    locationGuideNodeId,
    sourceVideoNodeId,
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
