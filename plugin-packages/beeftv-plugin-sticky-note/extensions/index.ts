import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function resolveCanvasRevision(
  ctx: {
    executeTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{
      isError: boolean;
      result: { content: Array<{ text?: string }> };
    }>;
  },
  expectedRevision?: number,
): Promise<number> {
  if (Number.isSafeInteger(expectedRevision) && (expectedRevision as number) >= 0) {
    return expectedRevision as number;
  }
  const read = await ctx.executeTool("canvas_get", {});
  const readText = read.result.content
    .map((part) => ("text" in part && part.text ? part.text : ""))
    .join("");
  if (read.isError) {
    throw new Error(`读取画布失败：${readText}`);
  }
  const revision = Number(/"revision"\s*:\s*(\d+)/.exec(readText)?.[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("没有拿到画布版本号");
  }
  return revision;
}

export default function registerStickyNoteExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sticky_note_create",
    label: "新建便签",
    description:
      "在当前画布上创建一张便签卡片（sticky-note 节点）。当用户要求记录待办、贴便签或整理要点时使用。",
    parameters: Type.Object({
      title: Type.String({ description: "便签标题（4 到 12 个字概括要点）" }),
      text: Type.String({ description: "便签正文内容" }),
      expectedRevision: Type.Optional(
        Type.Number({ description: "画布期望版本号（未传时自动读取）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const revision = await resolveCanvasRevision(ctx, params.expectedRevision);
      const created = await ctx.executeTool("canvas_nodes_create", {
        expectedRevision: revision,
        nodes: [
          {
            type: "sticky-note",
            title: params.title,
            prompt: `📌 ${params.text}`,
          },
        ],
      });
      const createdText = created.result.content
        .map((part) => ("text" in part && part.text ? part.text : ""))
        .join("");
      if (created.isError) {
        throw new Error(`创建便签失败：${createdText}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `已创建便签「${params.title}」`,
          },
        ],
        details: {
          title: params.title,
          revision,
        },
      };
    },
  });

  pi.registerTool({
    name: "sticky_note_update",
    label: "修改便签",
    description: "按节点 ID 更新画布上已有便签的标题或正文内容。",
    parameters: Type.Object({
      nodeId: Type.String({ description: "要修改的便签节点 ID" }),
      title: Type.Optional(Type.String({ description: "新的便签标题" })),
      text: Type.Optional(Type.String({ description: "新的便签正文内容" })),
      expectedRevision: Type.Optional(
        Type.Number({ description: "画布期望版本号（未传时自动读取）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const revision = await resolveCanvasRevision(ctx, params.expectedRevision);
      const patch: Record<string, string> = {};
      if (typeof params.title === "string" && params.title.trim()) {
        patch.title = params.title.trim();
      }
      if (typeof params.text === "string") {
        patch.content = `📌 ${params.text}`;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error("至少需要传入 title 或 text 之一");
      }
      const updated = await ctx.executeTool("canvas_node_update", {
        nodeId: params.nodeId,
        expectedRevision: revision,
        patch,
      });
      const updatedText = updated.result.content
        .map((part) => ("text" in part && part.text ? part.text : ""))
        .join("");
      if (updated.isError) {
        throw new Error(`更新便签失败：${updatedText}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `已更新便签节点 ${params.nodeId}`,
          },
        ],
        details: {
          nodeId: params.nodeId,
          revision,
        },
      };
    },
  });
}
