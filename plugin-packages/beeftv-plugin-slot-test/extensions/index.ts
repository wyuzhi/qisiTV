import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function registerSlotTestExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "slot_test_ping",
    label: "插槽测试探针",
    description:
      "回显测试问候消息，并可选择在当前画布创建一个 slot-test-node 插槽测试节点。",
    parameters: Type.Object({
      message: Type.String({ description: "要回显的测试消息" }),
      createNode: Type.Optional(
        Type.Boolean({ description: "是否顺便在画布上创建一个插槽测试节点" }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "画布期望版本号（若未传则自动读取）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let createdNodeInfo = "";
      if (params.createNode) {
        let revision = params.expectedRevision;
        if (!Number.isSafeInteger(revision)) {
          const read = await ctx.executeTool("canvas_get", {});
          const readText = read.result.content
            .map((part) => ("text" in part ? part.text : ""))
            .join("");
          if (read.isError) {
            throw new Error(`读取画布失败：${readText}`);
          }
          revision = Number(/"revision"\s*:\s*(\d+)/.exec(readText)?.[1]);
        }
        if (!Number.isSafeInteger(revision)) {
          throw new Error("无法确定当前画布 revision");
        }
        const created = await ctx.executeTool("canvas_nodes_create", {
          expectedRevision: revision,
          nodes: [
            {
              type: "slot-test-node",
              title: "插槽测试节点",
              prompt: params.message,
            },
          ],
        });
        const createdText = created.result.content
          .map((part) => ("text" in part ? part.text : ""))
          .join("");
        if (created.isError) {
          throw new Error(`创建插槽测试节点失败：${createdText}`);
        }
        createdNodeInfo = "，并已在画布创建 slot-test-node 节点";
      }

      return {
        content: [
          {
            type: "text",
            text: `插槽测试响应：${params.message}${createdNodeInfo}`,
          },
        ],
        details: {
          echo: params.message,
          createdNode: Boolean(params.createNode),
        },
      };
    },
  });
}
