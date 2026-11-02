import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCENE_TEMPLATES = [
  {
    suffix: "极简棚拍主图",
    buildPrompt: (title: string, points: string) =>
      `电商高转化极简棚拍主图，主体为「${title}」，突出卖点：${points}。商业级柔光箱布光，立体阴影，主体居中清晰，细节锐利，高级纯净背景。`,
  },
  {
    suffix: "真实生活场景图",
    buildPrompt: (title: string, points: string) =>
      `电商真实生活场景主图，主体为「${title}」，核心卖点：${points}。自然柔和日光，贴合真实使用情境，画面富有生活品质感与代入感。`,
  },
  {
    suffix: "细节特写卖点图",
    buildPrompt: (title: string, points: string) =>
      `电商微距材质与细节特写图，展示「${title}」的核心工艺与卖点：${points}。浅景深，高质感纹理，清晰呈现材质细节与品质光泽。`,
  },
  {
    suffix: "氛围感海报主图",
    buildPrompt: (title: string, points: string) =>
      `电商视觉氛围海报主图，围绕「${title}」与核心卖点「${points}」构图，光影层次丰富，品牌视觉张力强，预留舒适视觉呼吸空间。`,
  },
];

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

export default function registerEcommerceHeroExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ecommerce_hero_arrange",
    label: "一键编排商品主图",
    description:
      "在当前画布创建「一键商品主图」节点及指定数量（1~4 张）的电商场景主图节点，自动建立连线，并可选择直接发起图片生成提议。",
    parameters: Type.Object({
      productTitle: Type.String({ description: "商品名称，例如「无线降噪耳机」" }),
      sellingPoints: Type.String({
        description: "核心卖点描述，例如「48dB 深度降噪、金属磨砂腔体、40 小时续航」",
      }),
      sceneCount: Type.Optional(
        Type.Number({
          description: "需要生成的场景图张数（1 到 4，默认 2）",
          minimum: 1,
          maximum: 4,
          default: 2,
        }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "当前画布版本号（未传时自动读取）" }),
      ),
      proposeGeneration: Type.Optional(
        Type.Boolean({
          description: "创建并连线后是否立即发起图片生成提议（canvas_generation_propose）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const count = Math.max(1, Math.min(4, Math.trunc(params.sceneCount ?? 2)));
      let revision = params.expectedRevision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
        const read = await ctx.executeTool("canvas_get", {});
        const readText = extractText(read.result);
        if (read.isError) {
          throw new Error(`读取画布失败：${readText}`);
        }
        revision = Number(/"revision"\s*:\s*(\d+)/.exec(readText)?.[1]);
      }
      if (!Number.isSafeInteger(revision)) {
        throw new Error("无法确定当前画布 revision");
      }

      const selectedScenes = SCENE_TEMPLATES.slice(0, count);
      const nodesToCreate = [
        {
          type: "ecommerce-hero",
          title: `${params.productTitle} · 商品主图配置`,
          prompt: `商品：${params.productTitle}\n卖点：${params.sellingPoints}\n场景数：${count} 张`,
        },
        ...selectedScenes.map((scene, index) => ({
          type: "image",
          title: `${params.productTitle} · 主图 ${index + 1}（${scene.suffix}）`,
          prompt: scene.buildPrompt(params.productTitle, params.sellingPoints),
        })),
      ];

      const createdRes = await ctx.executeTool("canvas_nodes_create", {
        expectedRevision: revision,
        nodes: nodesToCreate,
      });
      const createdText = extractText(createdRes.result);
      if (createdRes.isError) {
        throw new Error(`创建商品主图节点失败：${createdText}`);
      }

      const parsedCreated =
        (createdRes.result.structuredContent as Record<string, unknown> | undefined) ||
        parseJsonObject(createdText) ||
        {};
      const createdList = Array.isArray(parsedCreated.created)
        ? (parsedCreated.created as Array<{ id?: string; type?: string }>)
        : [];
      let currentRevision = Number(parsedCreated.revision ?? (revision as number) + 1);

      const heroNodeId = createdList[0]?.id || "";
      const createdImageNodeIds = createdList
        .slice(1)
        .map((item) => item?.id || "")
        .filter(Boolean);

      if (heroNodeId && createdImageNodeIds.length > 0) {
        for (const imageNodeId of createdImageNodeIds) {
          const edgeRes = await ctx.executeTool("canvas_edge_create", {
            fromNodeId: heroNodeId,
            toNodeId: imageNodeId,
            expectedRevision: currentRevision,
          });
          if (!edgeRes.isError) {
            const edgeText = extractText(edgeRes.result);
            const parsedEdge =
              (edgeRes.result.structuredContent as Record<string, unknown> | undefined) ||
              parseJsonObject(edgeText);
            if (Number.isSafeInteger( Number(parsedEdge?.revision))) {
              currentRevision = Number(parsedEdge?.revision);
            }
          }
        }
      }

      let proposalId: string | undefined;
      if (params.proposeGeneration && createdImageNodeIds.length > 0) {
        const proposeRes = await ctx.executeTool("canvas_generation_propose", {
          nodeIds: createdImageNodeIds,
          kind: "image",
          note: "一键商品主图生成提议",
        });
        const proposeText = extractText(proposeRes.result);
        if (proposeRes.isError) {
          throw new Error(`发起商品主图生成提议失败：${proposeText}`);
        }
        const parsedPropose =
          (proposeRes.result.structuredContent as Record<string, unknown> | undefined) ||
          parseJsonObject(proposeText);
        proposalId =
          typeof parsedPropose?.proposalId === "string"
            ? parsedPropose.proposalId
            : undefined;
      }

      return {
        content: [
          {
            type: "text",
            text: `已为「${params.productTitle}」编排 1 个商品主图节点与 ${createdImageNodeIds.length} 张场景主图节点${proposalId ? `，并已登记生成提议（${proposalId}）` : ""}。`,
          },
        ],
        details: {
          productTitle: params.productTitle,
          sellingPoints: params.sellingPoints,
          sceneCount: count,
          heroNodeId,
          createdImageNodeIds,
          revision: currentRevision,
          proposalId,
        },
      };
    },
  });
}
