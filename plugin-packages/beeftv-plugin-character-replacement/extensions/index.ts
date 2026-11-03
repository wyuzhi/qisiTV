import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildCharacterReplacementPackage,
  buildTimelineRangeReplacement,
  normalizeGenderHint,
  normalizePosition,
  normalizePromptMode,
  normalizeReplacementScope,
  uniqueNodeTitle,
} from "../client/compiler.js";

function extractText(result: { content?: Array<{ text?: string }> }): string {
  return (result?.content || [])
    .map((part) => ("text" in part && part.text ? part.text : ""))
    .join("");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseCanvasSnapshot(readRes: {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  result?: {
    content?: Array<{ text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}): {
  revision: number | undefined;
  nodes: Array<Record<string, unknown>>;
  timeline: Record<string, unknown> | null;
} {
  const readText = extractText(readRes?.result || {});
  if (readRes?.isError) {
    throw new Error(`读取画布失败：${readText}`);
  }
  const structured =
    (readRes?.result?.structuredContent as Record<string, unknown> | undefined) ||
    (readRes?.structuredContent as Record<string, unknown> | undefined) ||
    parseJsonObject(readText) ||
    {};
  const canvasObj =
    structured.canvas && typeof structured.canvas === "object"
      ? (structured.canvas as Record<string, unknown>)
      : structured;

  const rawRev = canvasObj.revision ?? structured.revision;
  const revision = Number.isSafeInteger(Number(rawRev))
    ? Number(rawRev)
    : Number(/"revision"\s*:\s*(\d+)/.exec(readText)?.[1]);
  const nodes = Array.isArray(canvasObj.nodes)
    ? (canvasObj.nodes as Array<Record<string, unknown>>)
    : [];
  const timeline =
    canvasObj.timeline && typeof canvasObj.timeline === "object"
      ? (canvasObj.timeline as Record<string, unknown>)
      : null;

  return { revision, nodes, timeline };
}

export default function registerCharacterReplacementExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "character_replacement_arrange",
    label: "一键编排 AI 角色替换双阶段管线",
    description:
      "在当前画布创建「AI 角色替换」配置节点、Step 2 关键帧人物替换图片节点与 Step 3 视频元素替换（replace_element）节点，自动连接原关键帧、目标角色参考图、可选定位图与原视频，并可选直接发起生成提议。",
    parameters: Type.Object({
      shotTitle: Type.String({
        description: "镜头名称，例如「镜头 1」或「雨夜拔剑特写」",
      }),
      sourceDescription: Type.String({
        description: "原画面中被替换人物的特征描述，例如「穿黑西装的男人」或「银甲男剑客」",
      }),
      targetDescription: Type.String({
        description: "目标替换角色的外貌与服装描述，例如「戴银框眼镜、穿酒红色丝绒西装的年轻霸总」",
      }),
      position: Type.Optional(
        Type.String({
          description: "目标人物在画面中的位置：single（单人）| left（左侧）| center（中间）| right（右侧）",
          default: "single",
        }),
      ),
      genderHint: Type.Optional(
        Type.String({
          description: "人物性别提示：person（不限）| male（男）| female（女）",
          default: "person",
        }),
      ),
      replacementScope: Type.Optional(
        Type.String({
          description:
            "替换范围：full-person（完整人物）| visible-part（当前可见部分）| face-hair（脸部和头发）| clothing（仅服装）| arm-hand（手臂和手部）",
          default: "full-person",
        }),
      ),
      promptMode: Type.Optional(
        Type.String({
          description:
            "提示词模式：regular（常规位置描述）| positioning（SVG 定位框辅助）| manual（自定义提示词）",
          default: "regular",
        }),
      ),
      manualPrompt: Type.Optional(
        Type.String({
          description: "当 promptMode 为 manual 时的自定义关键帧换人提示词",
        }),
      ),
      sourceKeyframeNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的原视频关键帧图片节点 ID（将自动作为图1连接到关键帧换人节点）",
        }),
      ),
      targetCharacterNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的目标角色参考图节点 ID（将自动作为图2连接到关键帧换人节点）",
        }),
      ),
      locationGuideNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的人物定位框图节点 ID（在 positioning 模式下将作为图3连接到关键帧换人节点）",
        }),
      ),
      sourceVideoNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的原镜头视频节点 ID（将自动连接到 Step 3 视频角色替换节点）",
        }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "当前画布版本号（未传时自动读取）" }),
      ),
      proposeGeneration: Type.Optional(
        Type.Boolean({
          description: "创建并连线后是否立即发起关键帧换人生成提议（canvas_generation_propose）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const shotTitle = String(params.shotTitle || "镜头 1").trim() || "镜头 1";
      const position = normalizePosition(params.position || "single");
      const genderHint = normalizeGenderHint(params.genderHint || "person");
      const replacementScope = normalizeReplacementScope(params.replacementScope || "full-person");
      const promptMode = normalizePromptMode(params.promptMode || "regular");
      const manualPrompt = String(params.manualPrompt || "").trim();
      const sourceDescription = String(params.sourceDescription || "").trim();
      const targetDescription = String(params.targetDescription || "").trim();

      const srcKeyframeId = String(params.sourceKeyframeNodeId || "").trim();
      const targetCharId = String(params.targetCharacterNodeId || "").trim();
      const locationGuideId = String(params.locationGuideNodeId || "").trim();
      const srcVideoId = String(params.sourceVideoNodeId || "").trim();

      const missingReferences: string[] = [];
      if (!srcKeyframeId) missingReferences.push("sourceKeyframeNodeId");
      if (!targetCharId) missingReferences.push("targetCharacterNodeId");
      if (!srcVideoId) missingReferences.push("sourceVideoNodeId");

      if (params.proposeGeneration && (!srcKeyframeId || !targetCharId)) {
        throw new Error(
          "发起关键帧换人生成提议（proposeGeneration=true）时必须提供 sourceKeyframeNodeId 与 targetCharacterNodeId",
        );
      }

      const read = await ctx.executeTool("canvas_get", {});
      const snap = parseCanvasSnapshot(read);
      const revision =
        Number.isSafeInteger(params.expectedRevision) && (params.expectedRevision as number) >= 0
          ? (params.expectedRevision as number)
          : snap.revision;
      if (!Number.isSafeInteger(revision)) {
        throw new Error("无法确定当前画布 revision");
      }

      const existingTitles = new Set(
        snap.nodes
          .map((item) => String(item?.title || "").trim())
          .filter(Boolean),
      );

      const compiled = buildCharacterReplacementPackage({
        position,
        genderHint,
        sourceDescription,
        targetDescription,
        replacementScope,
        promptMode,
        manualPrompt,
        hasLocationGuideImage: Boolean(locationGuideId),
      });

      const controlTitle = uniqueNodeTitle(`${shotTitle} · 角色替换配置`, existingTitles);
      const keyframeTitle = uniqueNodeTitle(`${shotTitle} · 关键帧换人`, existingTitles);
      const videoTitle = uniqueNodeTitle(`${shotTitle} · 视频角色替换`, existingTitles);

      const nodesToCreate = [
        {
          type: "character-replacement",
          title: controlTitle,
          prompt: `镜头：${shotTitle}\n原人物：${sourceDescription || position}\n目标角色：${targetDescription}\n范围：${replacementScope}`,
          pluginData: {
            shotTitle,
            position,
            genderHint,
            sourceDescription,
            targetDescription,
            replacementScope,
            promptMode,
            manualPrompt,
            sourceKeyframeNodeId: srcKeyframeId,
            targetCharacterNodeId: targetCharId,
            locationGuideNodeId: locationGuideId,
            sourceVideoNodeId: srcVideoId,
          },
        },
        {
          type: "image",
          title: keyframeTitle,
          prompt: compiled.prompt,
        },
        {
          type: "video",
          title: videoTitle,
          prompt: compiled.videoPrompt,
        },
      ];

      const createdRes = await ctx.executeTool("canvas_nodes_create", {
        expectedRevision: revision,
        nodes: nodesToCreate,
      });
      const createdText = extractText(createdRes.result);
      if (createdRes.isError) {
        throw new Error(`创建角色替换节点失败：${createdText}`);
      }

      const parsedCreated =
        (createdRes.result.structuredContent as Record<string, unknown> | undefined) ||
        parseJsonObject(createdText) ||
        {};
      const createdList = Array.isArray(parsedCreated.created)
        ? (parsedCreated.created as Array<{ id?: string; type?: string }>)
        : [];
      let currentRevision = Number(parsedCreated.revision ?? (revision as number) + 1);

      const controlNodeId = createdList[0]?.id || "";
      const keyframeNodeId = createdList[1]?.id || "";
      const videoNodeId = createdList[2]?.id || "";

      if (videoNodeId) {
        const configureRes = await ctx.executeTool("canvas_node_configure", {
          nodeId: videoNodeId,
          kind: "video",
          expectedRevision: currentRevision,
          patch: {
            videoEditOperation: "replace_element",
          },
        });
        if (!configureRes.isError) {
          const cfgText = extractText(configureRes.result);
          const parsedCfg =
            (configureRes.result.structuredContent as Record<string, unknown> | undefined) ||
            parseJsonObject(cfgText);
          if (Number.isSafeInteger(Number(parsedCfg?.revision))) {
            currentRevision = Number(parsedCfg?.revision);
          }
        }
      }

      const edges: Array<[string, string]> = [];

      if (srcKeyframeId && keyframeNodeId) {
        edges.push([srcKeyframeId, keyframeNodeId]);
      }
      if (targetCharId && keyframeNodeId && targetCharId !== srcKeyframeId) {
        edges.push([targetCharId, keyframeNodeId]);
      }
      if (
        locationGuideId &&
        keyframeNodeId &&
        locationGuideId !== srcKeyframeId &&
        locationGuideId !== targetCharId
      ) {
        edges.push([locationGuideId, keyframeNodeId]);
      }
      if (controlNodeId && keyframeNodeId) {
        edges.push([controlNodeId, keyframeNodeId]);
      }
      if (srcVideoId && videoNodeId) {
        edges.push([srcVideoId, videoNodeId]);
      }
      if (keyframeNodeId && videoNodeId) {
        edges.push([keyframeNodeId, videoNodeId]);
      }

      for (const [fromNodeId, toNodeId] of edges) {
        if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
        const edgeRes = await ctx.executeTool("canvas_edge_create", {
          fromNodeId,
          toNodeId,
          expectedRevision: currentRevision,
        });
        if (!edgeRes.isError) {
          const edgeText = extractText(edgeRes.result);
          const parsedEdge =
            (edgeRes.result.structuredContent as Record<string, unknown> | undefined) ||
            parseJsonObject(edgeText);
          if (Number.isSafeInteger(Number(parsedEdge?.revision))) {
            currentRevision = Number(parsedEdge?.revision);
          }
        }
      }

      let proposalId: string | undefined;
      if (params.proposeGeneration && keyframeNodeId) {
        const proposeRes = await ctx.executeTool("canvas_generation_propose", {
          nodeIds: [keyframeNodeId],
          kind: "image",
          ...(srcVideoId && videoNodeId
            ? { productionNodeIds: [keyframeNodeId, videoNodeId] }
            : {}),
          note: `AI 角色替换（${shotTitle}）：先生成换人关键帧，再执行视频元素替换`,
        });
        const proposeText = extractText(proposeRes.result);
        if (proposeRes.isError) {
          throw new Error(`发起角色替换生成提议失败：${proposeText}`);
        }
        const parsedPropose =
          (proposeRes.result.structuredContent as Record<string, unknown> | undefined) ||
          parseJsonObject(proposeText);
        proposalId =
          typeof parsedPropose?.proposalId === "string"
            ? parsedPropose.proposalId
            : undefined;
      }

      const missingNote =
        missingReferences.length > 0
          ? `（提示：尚未绑定 ${missingReferences.join("、")}，生成前请先连接对应参考节点）`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `已为「${shotTitle}」编排 AI 角色替换双阶段管线：关键帧换人节点（${keyframeNodeId}）→ 视频元素替换节点（${videoNodeId}，videoEditOperation=replace_element）${proposalId ? `，并已登记生成提议（${proposalId}）` : ""}${missingNote}。`,
          },
        ],
        details: {
          shotTitle,
          position,
          replacementScope,
          controlNodeId,
          keyframeNodeId,
          videoNodeId,
          keyframePrompt: compiled.prompt,
          videoPrompt: compiled.videoPrompt,
          missingReferences,
          revision: currentRevision,
          proposalId,
        },
      };
    },
  });

  pi.registerTool({
    name: "character_replacement_splice_timeline",
    label: "将角色替换后的镜头视频无损回插至全片时间线",
    description:
      "根据原全片视频节点、全片总时长及一个或多个替换后的镜头视频区间（startMs~endMs），构建「原片前段 → 替换镜头 → 原片后段」的无损 Timeline v2 并写入画布时间线（保留画布既有字幕/BGM 轨道）。",
    parameters: Type.Object({
      fullVideoNodeId: Type.String({
        description: "原全片视频节点 ID",
      }),
      fullDurationMs: Type.Optional(
        Type.Number({
          description: "原全片视频总时长（毫秒，如 15000；未传时自动读取原全片节点的 durationMs）",
          minimum: 100,
        }),
      ),
      replacements: Type.Array(
        Type.Object({
          nodeId: Type.String({ description: "替换完成后的镜头视频节点 ID" }),
          startMs: Type.Number({ description: "在原全片中的起始毫秒（如 3000）", minimum: 0 }),
          endMs: Type.Number({ description: "在原全片中的结束毫秒（如 8000）", minimum: 100 }),
        }),
        { minItems: 1, description: "需要回插的替换镜头区间列表" },
      ),
      keepOriginalAudio: Type.Optional(
        Type.Boolean({
          description: "是否保留原全片完整连续音轨（默认 true，静音视频片段轨并叠加原片完整音频轨）",
          default: true,
        }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "当前画布版本号（未传时自动读取）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const read = await ctx.executeTool("canvas_get", {});
      const snap = parseCanvasSnapshot(read);
      const revision =
        Number.isSafeInteger(params.expectedRevision) && (params.expectedRevision as number) >= 0
          ? (params.expectedRevision as number)
          : snap.revision;
      if (!Number.isSafeInteger(revision)) {
        throw new Error("无法确定当前画布 revision");
      }

      const nodeDurationMap = new Map<string, number>();
      for (const node of snap.nodes) {
        const id = String(node?.id || "").trim();
        const metadata =
          node?.metadata && typeof node.metadata === "object"
            ? (node.metadata as Record<string, unknown>)
            : {};
        const dur = Number(metadata.durationMs);
        if (id && Number.isFinite(dur) && dur > 0) {
          nodeDurationMap.set(id, Math.round(dur));
        }
      }

      const fullVideoNodeId = String(params.fullVideoNodeId || "").trim();
      const detectedFullDurationMs = nodeDurationMap.get(fullVideoNodeId);
      const callerFullDurationMs = Number(params.fullDurationMs);
      let resolvedFullDurationMs = callerFullDurationMs;
      if (Number.isFinite(detectedFullDurationMs) && (detectedFullDurationMs as number) > 0) {
        if (!Number.isFinite(callerFullDurationMs) || callerFullDurationMs <= 0) {
          resolvedFullDurationMs = detectedFullDurationMs as number;
        } else if (Math.abs(callerFullDurationMs - (detectedFullDurationMs as number)) > 250) {
          throw new Error(
            `传入的全片总时长（${callerFullDurationMs}ms）与原全片节点实际时长（${detectedFullDurationMs}ms）不一致`,
          );
        }
      }

      const enrichedReplacements = params.replacements.map((item) => ({
        ...item,
        sourceDurationMs: nodeDurationMap.get(String(item.nodeId || "").trim()),
      }));

      const timeline = buildTimelineRangeReplacement({
        fullVideoNodeId,
        fullDurationMs: resolvedFullDurationMs,
        replacements: enrichedReplacements,
        keepOriginalAudio: params.keepOriginalAudio !== false,
        existingTimeline: snap.timeline,
      });

      const updateRes = await ctx.executeTool("canvas_timeline_update", {
        expectedRevision: revision,
        timeline,
      });
      const updateText = extractText(updateRes.result);
      if (updateRes.isError) {
        throw new Error(`更新全片时间线失败：${updateText}`);
      }

      const parsedUpdate =
        (updateRes.result.structuredContent as Record<string, unknown> | undefined) ||
        parseJsonObject(updateText);
      const nextRevision = Number(parsedUpdate?.revision ?? (revision as number) + 1);

      return {
        content: [
          {
            type: "text",
            text: `已将 ${params.replacements.length} 个替换镜头无损回插至全片时间线（共生成 ${timeline.clips.length} 个片段，画布版本 r${nextRevision}）。`,
          },
        ],
        details: {
          fullVideoNodeId,
          fullDurationMs: resolvedFullDurationMs,
          clipCount: timeline.clips.length,
          revision: nextRevision,
          timeline,
        },
      };
    },
  });
}
