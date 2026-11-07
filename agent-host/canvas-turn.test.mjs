// 一轮对话的变更摘要、付费生成提议与供应商定义：确定性用例，不需要模型也不需要真实会话。
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, CompactionEntry, defineDoc } from "@earendil-works/pi-durable";

import { collectTurnEffects, extendWriteChain, modelTurnCompletion, newTurnAccumulator, rebaseOntoWriteChain, providerRegistration, providerUnavailableReason,
  resetTurnAccumulator, sessionTitle, turnChange, turnContextPrefix, unflushedSessionHistory } from "./canvas-turn.mjs";
import { createDurableSessionStore, HOST_STATE_CHECKPOINT_DELTAS } from "./durable-session-owner.mjs";
import { createDurableTurnProjection } from "./durable-turn-projection.mjs";
import { SYSTEM_PROMPT } from "./system-prompt.mjs";

describe("本轮画布变更", () => {
    test("真实素材绑定回执保留改动节点与撤销操作身份", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 7);
        collectTurnEffects(turn, "canvas.node.bind_asset", { revision: 8, nodeId: "reference", referenceBound: true }, "bind-op");
        expect(turnChange(turn)).toEqual({ revisionBefore: 7, revisionAfter: 8,
            createdNodeIds: [], updatedNodeIds: ["reference"], createdEdgeIds: [], operationIds: ["bind-op"] });
    });
    test("参数配置保留真实节点与操作回执供查看和撤销", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 7);
        collectTurnEffects(turn, "canvas.node.configure", { revision: 8, nodeId: "video-draft" }, "configure-op");
        expect(turnChange(turn)).toEqual({ revisionBefore: 7, revisionAfter: 8,
            createdNodeIds: [], updatedNodeIds: ["video-draft"], createdEdgeIds: [], operationIds: ["configure-op"] });
    });
    test("从成功的工具结果累计新建节点、改动节点与新建连线", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 7);

        collectTurnEffects(turn, "canvas.nodes.create", { revision: 8, created: [{ id: "a" }, { id: "b" }] });
        collectTurnEffects(turn, "canvas.node.update", { revision: 9, nodeId: "a" });
        collectTurnEffects(turn, "canvas.edge.create", { revision: 10, created: true, edgeId: "e1" });

        expect(turnChange(turn)).toEqual({
            revisionBefore: 7, revisionAfter: 10,
            createdNodeIds: ["a", "b"], updatedNodeIds: ["a"], createdEdgeIds: ["e1"],
        });
    });

    test("分镜行写入记脚本节点，绑定改写的产出连线进入变更摘要", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 3);
        collectTurnEffects(turn, "canvas.script.rows.append", { canvasId: "c1", revision: 4, nodeId: "script", created: [{ id: "shot-1", shotNumber: 1 }] }, "append-op");
        collectTurnEffects(turn, "canvas.script.row.update", { canvasId: "c1", revision: 5, nodeId: "script",
            createdEdgeIds: ["edge-img", "edge-vid"], deletedEdgeIds: ["edge-old"] }, "bind-op");
        collectTurnEffects(turn, "canvas.script.row.update", { canvasId: "c1", revision: 6, nodeId: "script",
            createdEdgeIds: [], deletedEdgeIds: ["edge-vid"], syncedNodeIds: ["img-1"] }, "unbind-op");
        expect(turnChange(turn)).toEqual({ revisionBefore: 3, revisionAfter: 6,
            createdNodeIds: [], updatedNodeIds: ["script", "img-1"], createdEdgeIds: ["edge-img", "edge-vid"],
            deletedEdgeIds: ["edge-old", "edge-vid"], operationIds: ["append-op", "bind-op", "unbind-op"] });
    });

    test("alsoChanged 回执把连带改动的节点计入本轮改动", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 3);
        collectTurnEffects(turn, "canvas.script.row.update", { canvasId: "c1", revision: 4, nodeId: "script",
            syncedNodeIds: ["img-1"], alsoChanged: [{ nodeId: "img-1", title: "首帧", fields: ["composerContent"] }] }, "sync-op");
        collectTurnEffects(turn, "canvas.task.bind", { canvasId: "c1", revision: 5, nodeId: "vid-1",
            alsoChanged: [{ nodeId: "batch-root", fields: ["assetId"] }] }, "bind-op");
        expect(turnChange(turn)).toEqual({ revisionBefore: 3, revisionAfter: 5,
            createdNodeIds: [], updatedNodeIds: ["script", "img-1", "vid-1", "batch-root"], createdEdgeIds: [],
            operationIds: ["sync-op", "bind-op"] });
    });

    test("未落盘的当前会话按空历史读取，别的会话仍然缺失", () => {
        expect(unflushedSessionHistory("s1", "s1")).toEqual({ sessionId: "s1", turns: [] });
        expect(unflushedSessionHistory("", "s1")).toEqual({ sessionId: null, turns: [] });
        expect(unflushedSessionHistory("old", "s1")).toBeNull();
    });

    test("推进版本的写入带上操作回执，重复版本不重复记", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        collectTurnEffects(turn, "canvas.nodes.create", { revision: 5, created: [{ id: "a" }] }, "op-1");
        collectTurnEffects(turn, "canvas.node.update", { revision: 5, nodeId: "a" }, "op-stale");
        collectTurnEffects(turn, "canvas.node.update", { revision: 6, nodeId: "a" }, "op-2");
        expect(turnChange(turn).operationIds).toEqual(["op-1", "op-2"]);
    });

    test("重复连线幂等返回时不算新建连线", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 3);

        collectTurnEffects(turn, "canvas.edge.create", { revision: 3, created: false, duplicate: true, edgeId: "e1" });

        expect(turn.createdEdgeIds).toEqual([]);
        expect(turnChange(turn)).toBeNull();
    });

    test("连续修改同一节点只计一个对象，保留每次真实写入回执", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 45);
        collectTurnEffects(turn, "canvas.node.update", { revision: 46, nodeId: "video" }, "first-edit");
        collectTurnEffects(turn, "canvas.node.update", { revision: 47, nodeId: "video" }, "second-edit");
        collectTurnEffects(turn, "canvas.node.update", { revision: 48, nodeId: "image" }, "third-edit");
        expect(turnChange(turn)).toEqual({
            revisionBefore: 45, revisionAfter: 48,
            createdNodeIds: [], updatedNodeIds: ["video", "image"], createdEdgeIds: [],
            operationIds: ["first-edit", "second-edit", "third-edit"],
        });
    });

    test("本轮写入链：连续写入延长链头，断开时重新起链，换轮清空", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 9);
        expect(turn.writeChains).toEqual([]);
        expect(rebaseOntoWriteChain(turn, "a", 9)).toBe(9);
        extendWriteChain(turn, "a", 9, 10);
        extendWriteChain(turn, "a", 10, 11);
        expect(turn.writeChains).toEqual([{ canvasId: "a", start: 9, head: 11 }]);
        expect(rebaseOntoWriteChain(turn, "a", 9)).toBe(11);
        expect(rebaseOntoWriteChain(turn, "a", 10)).toBe(11);
        expect(rebaseOntoWriteChain(turn, "a", 11)).toBe(11);
        expect(rebaseOntoWriteChain(turn, "a", 8)).toBe(8);
        expect(rebaseOntoWriteChain(turn, "a", 12)).toBe(12);
        expect(rebaseOntoWriteChain(turn, "a", "9")).toBe("9");
        expect(rebaseOntoWriteChain(turn, "a", 9.5)).toBe(9.5);
        expect(rebaseOntoWriteChain(turn, "b", 9)).toBe(9);
        extendWriteChain(turn, "a", 11, 11); // 幂等返回没有推进版本
        expect(turn.writeChains[0].head).toBe(11);
        extendWriteChain(turn, "a", 13, 14); // 中间有别人的写入
        expect(turn.writeChains).toEqual([{ canvasId: "a", start: 13, head: 14 }]);
        expect(rebaseOntoWriteChain(turn, "a", 11)).toBe(11);
        resetTurnAccumulator(turn, 14);
        expect(turn.writeChains).toEqual([]);
        expect(turn.writeRequests).toEqual([]);
        expect(newTurnAccumulator()).toMatchObject({ writeChains: [], writeRequests: [] });
    });

    test("只读了画布的一轮没有变更摘要", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 5);

        collectTurnEffects(turn, "canvas.get", { canvasId: "c1", canvas: { revision: 5 } });

        expect(turnChange(turn)).toBeNull();
    });

    test("重置会清空上一轮的节点、连线与提议", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 1);
        collectTurnEffects(turn, "canvas.nodes.create", { revision: 2, created: [{ id: "a" }] });
        collectTurnEffects(turn, "canvas.generation.propose", { proposalId: "gp-1", kind: "image", nodeIds: ["a"], model: "gpt-image-2" });

        resetTurnAccumulator(turn, 2);

        expect(turn.createdNodeIds).toEqual([]);
        expect(turn.proposals).toEqual([]);
        expect(turnChange(turn)).toBeNull();
    });
});

describe("付费生成提议", () => {
    test("服务端来源版本透传，不从当前状态补造，也不透传额外字段", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        collectTurnEffects(turn, "canvas.generation.propose", {
            proposalId: "gp-source", kind: "image", nodeIds: ["n1"], model: "m", modelKey: "c::m",
            source: { canvasId: "canvas", canvasRevision: 7, modelConfigRevision: 3, privateField: "omit" },
        });
        expect(turn.proposals[0].source).toEqual({ canvasId: "canvas", canvasRevision: 7, modelConfigRevision: 3 });
        expect(turnChange(turn)).toBeNull();
    });
    test("普通提议带上逐项明细和预计费用，确认卡才能显示费用", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        const targets = [{ nodeId: "n1", title: "镜头1", kind: "image", modelKey: "beeftv::gpt-image-2", prompt: "雨夜", parameters: { count: "1" },
            estimate: { amount: 0.35, basis: "1K 低质量 ¥0.35/张 × 1 张", text: "预计 ¥0.35（1K 低质量 ¥0.35/张 × 1 张）" } }];
        const estimate = { amount: 0.35, priced: 1, unknown: 0, text: "预计费用：¥0.35" };
        collectTurnEffects(turn, "canvas.generation.propose", { proposalId: "gp-cost", kind: "image", nodeIds: ["n1"], model: "gpt-image-2", modelKey: "beeftv::gpt-image-2", targets, estimate });
        expect(turn.proposals[0].targets).toEqual(targets);
        expect(turn.proposals[0].estimate).toEqual(estimate);
    });
    test("提议只被记录，不进变更摘要（它不写画布、不扣费）", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);

        collectTurnEffects(turn, "canvas.generation.propose", {
            proposalId: "gp-1", kind: "video", nodeIds: ["n1", "n2"],
            model: "wan3.0-video", modelKey: "beeftv::wan3.0-video", note: "两段镜头",
        });

        expect(turnChange(turn)).toBeNull();
        expect(turn.proposals).toEqual([{ proposalId: "gp-1", kind: "video", nodeIds: ["n1", "n2"],
            model: "wan3.0-video", modelKey: "beeftv::wan3.0-video", note: "两段镜头" }]);
    });

    test("技能脚本提议在需确认与本对话始终允许自动完成时均记入 turn.scriptProposals 且按 proposalId 去重", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        const pendingProposal = { proposalId: "sp-1", status: "pending", scriptPath: "scripts/a.js" };
        const autoProposal = { proposalId: "sp-2", status: "completed", scriptPath: "scripts/b.js", result: { exitCode: 0, stdout: "ok" } };
        collectTurnEffects(turn, "skill.script.run", { status: "requires_confirmation", proposal: pendingProposal }, "op-sp-1");
        collectTurnEffects(turn, "skill.script.run", { status: "completed", proposal: autoProposal }, "op-sp-2");
        collectTurnEffects(turn, "skill.script.run", { status: "completed", proposal: { ...autoProposal, note: "replayed" } }, "op-sp-2");
        expect(turn.scriptProposals).toEqual([pendingProposal, { ...autoProposal, note: "replayed" }]);
        expect(turnChange(turn)).toBeNull();
    });

    test("系统提示词必须禁止宣称已生成，并指向提议工具", () => {
        expect(SYSTEM_PROMPT).toContain("canvas_generation_propose");
        expect(SYSTEM_PROMPT).toContain("只有用户实际确认过的制作方案才能付费生成");
        expect(SYSTEM_PROMPT).toContain("canvas_generation_submit");
    });

    test("系统提示词用 content 改可编辑提示词，未改字段不要提交", () => {
        expect(SYSTEM_PROMPT).toContain("改可编辑提示词或文本正文用 content");
        expect(SYSTEM_PROMPT).toContain("未改的字段不要提交");
        expect(SYSTEM_PROMPT).not.toMatch(/用 prompt/);
    });
});

describe("会话标题", () => {
    test("用第一条用户原文，截到 40 字", () => {
        expect(sessionTitle([{ userText: "  加两个分镜  " }, { userText: "再来一个" }])).toBe("加两个分镜");
        expect(sessionTitle([{ userText: "一".repeat(60) }])).toBe("一".repeat(40));
        expect(sessionTitle([])).toBe("");
    });

    test("跳过没有正文的轮次（例如被取消的那一轮）", () => {
        expect(sessionTitle([{ userText: "" }, { userText: "真正的第一句" }])).toBe("真正的第一句");
    });
});

describe("供应商定义", () => {
    test("协议不受支持或缺少模型/地址/密钥时给出机器可读原因", () => {
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "k", api: "openai-completions" })).toBe("");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x", apiKey: "k", api: "anthropic-messages" })).toBe("");
        expect(providerUnavailableReason({ modelId: "", baseUrl: "https://x/v1", apiKey: "k", api: "openai-completions" })).toBe("model_not_configured");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "", api: "openai-completions" })).toBe("model_not_configured");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "k", api: "newapi-channel-1" })).toBe("model_protocol_unsupported");
    });

    test("密钥以环境变量引用登记，内置目录模型继承能力与网关缓存兼容配置", () => {
        const registration = providerRegistration({ api: "anthropic-messages", baseUrl: "https://enterprise.example.com",
            modelId: "claude-fable-5", maxTokens: 4096, contextWindow: 200000 });

        expect(registration.apiKey).toBe("$BEEFTV_AGENT_API_KEY");
        expect(registration.api).toBe("anthropic-messages");
        expect(registration.baseUrl).toBe("https://enterprise.example.com");
        expect(registration.models[0]).toMatchObject({ id: "claude-fable-5", name: "claude-fable-5", reasoning: true,
            input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000, maxTokens: 4096 });
        const deepseek = providerRegistration({ api: "openai-completions", baseUrl: "https://relay.example.com/v1",
            modelId: "deepseek-v4.1-flash", maxTokens: 16384, contextWindow: 200000 }).models[0];
        expect(deepseek.reasoning).toBe(true);
        expect(deepseek.compat).toMatchObject({
            thinkingFormat: "deepseek",
            requiresReasoningContentOnAssistantMessages: true,
            promptCacheKeyMode: "enabled",
        });
        for (const api of ["openai-completions", "openai-responses"]) {
            const unknown = providerRegistration({ api, baseUrl: "https://relay.example.com/v1", modelId: "m", maxTokens: 16384, contextWindow: 200000 }).models[0];
            expect(unknown.reasoning).toBe(false);
            if (api === "openai-completions") {
                expect(unknown.compat).toEqual({ promptCacheKeyMode: "enabled" });
            }
        }
    });

    test("宿主模型目录只包含登记的后端供应商，不内置默认 OpenAI 供应商", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "beeftv-models-only-"));
        try {
            const runtime = await ModelRuntime.create({
                authPath: path.join(directory, "auth.json"),
                modelsPath: null,
                refreshOnCreate: false,
            });
            runtime.registerProvider("beeftv", providerRegistration({
                api: "anthropic-messages",
                baseUrl: "https://enterprise.example.com",
                modelId: "claude-opus-5-5",
                maxTokens: 4096,
                contextWindow: 200000,
            }));
            const models = createModels();
            models.setProvider(runtime.getProvider("beeftv"));
            expect(models.getProviders().map((p) => p.id)).toEqual(["beeftv"]);
            expect(models.getModel("openai", "gpt-5")).toBeUndefined();
            expect(models.getModel("beeftv", "claude-opus-5-5")?.api).toBe("anthropic-messages");
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("缺少模型或密钥时宿主仍然监听，只在 /health 里说明原因", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "beeftv-health-nokey-"));
        const reservation = createServer();
        await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
        const child = spawn(process.execPath, [serverPath], {
            env: {
                ...process.env,
                BEEFTV_AGENT_DATA_DIR: directory,
                BEEFTV_AGENT_HOST_TOKEN: "test-host-token",
                BEEFTV_AGENT_PORT: String(port),
                BEEFTV_AGENT_MODEL: "deepseek-v4.1-flash",
                BEEFTV_AGENT_API: "openai-completions",
                BEEFTV_AGENT_BASE_URL: "http://127.0.0.1:9/v1",
                BEEFTV_AGENT_API_KEY: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            let health = null;
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
                    if (res.ok) {
                        health = await res.json();
                        break;
                    }
                } catch { /* wait for listen */ }
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
            expect(health).toMatchObject({ ok: false, reason: "model_not_configured" });
        } finally {
            child.kill("SIGTERM");
            await new Promise((resolve) => child.once("close", resolve));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe("回合上下文", () => {
    test("重置时带上后端签发的 turnId；未给时清空，不沿用上一轮", () => {
        const turn = newTurnAccumulator();
        resetTurnAccumulator(turn, 3, "aabbcc");
        expect(turn.turnId).toBe("aabbcc");
        resetTurnAccumulator(turn, 4);
        expect(turn.turnId).toBe("");
    });

    test("引用只作为模型可见上下文，素材与额外画布分别标注", () => {
        expect(turnContextPrefix({ canvasId: "c1" })).toBe("[当前画布 c1｜可修改当前画布，其他画布只读]");
        expect(turnContextPrefix({ canvasId: "c1", selectedNodeIds: ["n1", "n2"] }))
            .toBe("[当前画布 c1｜可修改当前画布，其他画布只读｜选中对象: n1, n2]");
        expect(turnContextPrefix({ canvasId: "c1", references: [
            { kind: "asset", id: "a1" }, { kind: "canvas", id: "c2" }, { kind: "asset", id: "a2" }, { kind: "unknown", id: "x" },
        ] })).toBe("[当前画布 c1｜可修改当前画布，其他画布只读｜已引用素材: a1, a2｜已引用画布（只读）: c2]");
    });
});

describe('会话亲和性透传与升级恢复', () => {
  test('OpenAI 兼容请求携带 prompt_cache_key===entry.sessionId，Anthropic 请求携带 metadata.user_id===entry.sessionId 且保留 cache_control', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-affinity-'));
    const openaiPayloads = [];
    const anthropicPayloads = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (pathname.endsWith('/messages')) {
        anthropicPayloads.push(body);
        res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n\n');
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + '\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      openaiPayloads.push(body);
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-affinity';
    try {
      for (const [api, modelId, baseUrl] of [
        ['openai-completions', 'deepseek-v4.1-flash', `http://127.0.0.1:${port}/v1`],
        ['anthropic-messages', 'claude-opus-5-5', `http://127.0.0.1:${port}`],
      ]) {
        const runtime = await ModelRuntime.create({ authPath: path.join(directory, `${api}-auth.json`), modelsPath: null, refreshOnCreate: false });
        runtime.registerProvider('beeftv', providerRegistration({ api, baseUrl, modelId, maxTokens: 4096, contextWindow: 200000 }));
        const models = createModels();
        models.setProvider(runtime.getProvider('beeftv'));
        const store = createDurableSessionStore({
          sessionRoot: path.join(directory, `${api}-sessions`),
          workspaceRoot: path.join(directory, `${api}-workspace`),
          getModels: () => models,
          getModelRef: () => ({ provider: 'beeftv', modelId }),
          buildTools: () => [],
          authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
          settings: { retry: { maxRetries: 0 } },
        });
        try {
          const entry = await store.ensureSession('c1');
          const sub = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: 'hello', userText: 'hello', revisionBefore: 1 });
          await store.wait(entry, sub);
          if (api === 'openai-completions') {
            expect(openaiPayloads[0]?.prompt_cache_key).toBe(entry.sessionId);
          } else {
            expect(anthropicPayloads[0]?.metadata).toEqual({ user_id: entry.sessionId });
            expect(JSON.stringify(anthropicPayloads[0])).toContain('cache_control');
          }
        } finally {
          await store.disposeAll();
        }
      }
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('升级前未固定渠道亲和性的已有 Claude 会话恢复时降级旧 thinking 签名，新回合条目保留签名', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-legacy-claude-'));
    const anthropicPayloads = [];
    let callCount = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      anthropicPayloads.push(body);
      callCount += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const writeSse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      writeSse('message_start', {
        type: 'message_start',
        message: { id: `msg_${callCount}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
      });
      if (callCount === 1) {
        writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '旧会话未固定渠道的思考。' } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-unpinned-old-channel' } });
        writeSse('content_block_stop', { type: 'content_block_stop', index: 0 });
        writeSse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '第一轮答复' } });
        writeSse('content_block_stop', { type: 'content_block_stop', index: 1 });
        writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      if (callCount === 2) {
        writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '升级后固定渠道的思考。' } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-pinned-new-channel' } });
        writeSse('content_block_stop', { type: 'content_block_stop', index: 0 });
        writeSse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_new_1', name: 'plan_update', input: {} } });
        writeSse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ explanation: '计划', steps: [{ step: '步骤一', status: 'completed' }] }) } });
        writeSse('content_block_stop', { type: 'content_block_stop', index: 1 });
        writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第二轮答复' } });
      writeSse('content_block_stop', { type: 'content_block_stop', index: 0 });
      writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-legacy-claude';
    const hostStateDoc = defineDoc({
      kind: 'beeftv.host',
      version: 1,
      scope: 'session',
      initial: () => ({}),
      checkpointWhen: (value, _ops, { deltasSinceBase }) => value.active === null || deltasSinceBase >= HOST_STATE_CHECKPOINT_DELTAS,
    });
    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'anthropic-messages',
        baseUrl: `http://127.0.0.1:${port}`,
        modelId: 'claude-opus-5-5',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));
      const storeOptions = {
        sessionRoot: path.join(directory, 'sessions'),
        workspaceRoot: path.join(directory, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'claude-opus-5-5' }),
        buildTools: () => [],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
      };
      const store1 = createDurableSessionStore(storeOptions);
      let sessionId;
      try {
        const entry = await store1.ensureSession('c1');
        sessionId = entry.sessionId;
        const sub1 = await store1.submit(entry, { turnId: 't1', requestId: 'r1', content: '第一句', userText: '第一句', revisionBefore: 1 });
        await store1.wait(entry, sub1);
        // 模拟升级前持久化的会话状态（没有 affinityMinEntryId）
        await entry.harness.commit(async (tx) => {
          const doc = await tx.doc(hostStateDoc);
          delete doc.affinityMinEntryId;
        }, BACKGROUND_CONTEXT);
      } finally {
        await store1.disposeAll();
      }

      // 升级后重新打开同一 Durable 会话并继续对话
      const store2 = createDurableSessionStore(storeOptions);
      try {
        const reopened = await store2.ensureSession('c1', sessionId);
        const migratedState = await reopened.harness.snapshot(hostStateDoc, BACKGROUND_CONTEXT);
        expect(migratedState.affinityMinEntryId).toBeGreaterThan(1);
        const sub2 = await store2.submit(reopened, { turnId: 't2', requestId: 'r2', content: '第二句', userText: '第二句', revisionBefore: 1 });
        await store2.wait(reopened, sub2);
        // 第 3 次请求包含升级前第 1 轮历史 + 升级后第 2 轮刚刚产生的带签名 thinking 条目
        const finalPayload = anthropicPayloads[2];
        expect(finalPayload.metadata).toEqual({ user_id: sessionId });
        expect(JSON.stringify(finalPayload)).not.toContain('sig-unpinned-old-channel');
        expect(JSON.stringify(finalPayload)).toContain('旧会话未固定渠道的思考。');
        expect(JSON.stringify(finalPayload)).toContain('sig-pinned-new-channel');
      } finally {
        await store2.disposeAll();
      }
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('长轮次超过默认 100 条观察窗口时，恢复快照会补读前半段正文与思考；宿主状态在轮次结束或达到增量阈值时写完整快照', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-long-watch-'));
    const server = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '尾段正文。' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-long-watch';
    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'deepseek-v4.1-flash',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));
      const sessionRoot = path.join(directory, 'sessions');
      const store = createDurableSessionStore({
        sessionRoot,
        workspaceRoot: path.join(directory, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'deepseek-v4.1-flash' }),
        buildTools: () => [],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
      });
      let sqliteFile;
      try {
        const entry = await store.ensureSession('c1');
        const uuid = entry.sessionId.slice('durable:'.length);
        sqliteFile = fs.readdirSync(sessionRoot, { recursive: true })
          .map((rel) => path.join(sessionRoot, String(rel)))
          .find((full) => full.endsWith(`${uuid}.sqlite`));
        const sub = await store.submit(entry, { turnId: 't-long', requestId: 'r-long', content: '开始长轮次', userText: '开始长轮次', revisionBefore: 1 });
        // 在本轮已完成后再向同一对话追加 110 条条目（首条带早期的正文与思考，随后超过 100 条默认窗口上限），
        // 再通过 wait(entry, sub) 重新挂载观察器，验证初始 snapshot 补齐了窗口外的早期条目。
        await store.wait(entry, sub);
        const status = await sub.status(BACKGROUND_CONTEXT);
        await entry.root.commit(async (tx) => {
          await tx.appendEntry(AssistantEntry, entry.root.id, {
            model: [{
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '最早期思考片段' },
                { type: 'text', text: '最早期正文片段。' },
              ],
              api: 'openai-completions',
              provider: 'beeftv',
              model: 'deepseek-v4.1-flash',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'toolUse',
              timestamp: Date.now(),
            }],
          });
          for (let i = 0; i < 110; i += 1) {
            await tx.appendEntry(entry.root.id, { kind: 'beeftv.progress', data: { step: i } });
          }
        }, BACKGROUND_CONTEXT);
        // 确认直接 watch({ from: status.entry + 1 }) 会因为超过 100 条而截断并产生 before
        const rawWatch = await entry.root.watch(BACKGROUND_CONTEXT, { from: status.entry + 1 });
        expect(rawWatch.value.before).toBeGreaterThanOrEqual(status.entry + 1);
        await rawWatch.stop();

        const projection = createDurableTurnProjection();
        const events = [];
        await store.wait(entry, sub, {
          onEvent: async (event) => {
            events.push(event);
            projection.accept(event);
          },
        });
        const snapshotEvent = events.find((e) => e.type === 'snapshot');
        expect(snapshotEvent.entries.length).toBeGreaterThan(105);
        expect(projection.text).toContain('最早期正文片段。');
        expect(projection.reasoning.map((r) => r.text)).toContain('最早期思考片段');
      } finally {
        await store.disposeAll();
      }

      // 检查 SQLite 中 beeftv.host 文档的快照基线（轮次结束 active===null 时写 base 并裁掉历史 delta）
      const db = new DatabaseSync(sqliteFile, { readOnly: true });
      try {
        const docRow = db.prepare('SELECT id FROM documents WHERE kind = ?').get(JSON.stringify('beeftv.host'));
        expect(docRow).toBeDefined();
        const revisions = db.prepare('SELECT seq, kind FROM document_revisions WHERE document_id = ? ORDER BY seq ASC').all(docRow.id);
        expect(revisions).toHaveLength(1);
        expect(revisions[0].kind).toBe('base');
      } finally {
        db.close();
      }
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('本轮中途发生压缩时，实时流、重连快照与终态历史均保留压缩前后的完整回复与思考', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-midturn-compaction-'));
    let requestCount = 0;
    const server = createServer(async (_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requestCount === 1) {
        res.write('data: ' + JSON.stringify({
          id: 'c-step1',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_content: '压缩前思考。',
              content: '压缩前回复 A。',
              tool_calls: [{ index: 0, id: 'call_mid_1', type: 'function', function: { name: 'canvas_probe', arguments: '{}' } }],
            },
            finish_reason: null,
          }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          id: 'c-step1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }) + '\n\n');
      } else {
        res.write('data: ' + JSON.stringify({
          id: 'c-step2',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_content: '压缩后思考。',
              content: '压缩后回复 B。',
            },
            finish_reason: null,
          }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          id: 'c-step2',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-midturn-compaction';
    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'deepseek-v4.1-flash',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));
      let sessionEntry;
      const store = createDurableSessionStore({
        sessionRoot: path.join(directory, 'sessions'),
        workspaceRoot: path.join(directory, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'deepseek-v4.1-flash' }),
        buildTools: () => [{
          name: 'canvas_probe',
          label: 'Probe',
          description: 'probe canvas',
          parameters: { type: 'object', properties: {} },
          async execute() {
            // 在工具执行期间向当前对话写入一条官方 CompactionEntry（其 model 角色为 user，且 head 指向压缩点之后），
            // 模拟「回复 A → 压缩 → 回复 B」的跨压缩轮次。
            await sessionEntry.root.commit(async (tx) => {
              const latestId = await tx.latestEntryId(sessionEntry.root.id);
              await tx.appendEntry(CompactionEntry, sessionEntry.root.id, {
                head: latestId,
                model: [{
                  role: 'user',
                  content: [{ type: 'text', text: '<summary>早先步骤摘要</summary>' }],
                  timestamp: Date.now(),
                }],
                data: { reason: 'threshold', beforeTokens: 1000 },
              });
            }, BACKGROUND_CONTEXT);
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        }],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
      });
      try {
        sessionEntry = await store.ensureSession('c1');
        const sub = await store.submit(sessionEntry, {
          turnId: 't-compact',
          requestId: 'r-compact',
          content: '执行跨压缩回合',
          userText: '执行跨压缩回合',
          revisionBefore: 1,
        });
        const liveProjection = createDurableTurnProjection();
        const record = await store.wait(sessionEntry, sub, {
          onEvent: async (event) => {
            liveProjection.accept(event);
          },
        });
        expect(liveProjection.text).toBe('压缩前回复 A。\n\n压缩后回复 B。');
        expect(liveProjection.reasoning.map((r) => r.text)).toEqual(['压缩前思考。', '压缩后思考。']);
        expect(record.reply).toBe('压缩前回复 A。\n\n压缩后回复 B。');
        expect(record.reasoning.map((r) => r.text)).toEqual(['压缩前思考。', '压缩后思考。']);

        const history = await store.history('c1', sessionEntry.sessionId);
        expect(history.turns).toHaveLength(1);
        expect(history.turns[0].reply).toBe('压缩前回复 A。\n\n压缩后回复 B。');
        expect(history.turns[0].reasoning.map((r) => r.text)).toEqual(['压缩前思考。', '压缩后思考。']);

        // 重新挂载观察器获取恢复快照，确认快照不混入 CompactionEntry 且还原完整的前后段正文与思考
        const reconnectProjection = createDurableTurnProjection();
        const reconnectEvents = [];
        await store.wait(sessionEntry, sub, {
          onEvent: async (event) => {
            reconnectEvents.push(event);
            reconnectProjection.accept(event);
          },
        });
        const snapshotEvent = reconnectEvents.find((e) => e.type === 'snapshot');
        expect(snapshotEvent.entries.some((e) => e.kind === CompactionEntry.kind)).toBe(false);
        expect(reconnectProjection.text).toBe('压缩前回复 A。\n\n压缩后回复 B。');
        expect(reconnectProjection.reasoning.map((r) => r.text)).toEqual(['压缩前思考。', '压缩后思考。']);
      } finally {
        await store.disposeAll();
      }
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('模型终态投影', () => {
  test('用户停止不变成模型失败，超时保留独立原因', () => {
    const message = { content: [{ type: 'text', text: '已完成的部分' }], stopReason: 'aborted' };
    expect(modelTurnCompletion(message, 'AbortError', null, { cancelled: true }))
      .toEqual({ reply: '已完成的部分', error: null, errorReason: null });
    expect(modelTurnCompletion(message, 'AbortError', null, { cancelled: true, timedOut: true }).errorReason)
      .toBe('turn_timeout');
    expect(modelTurnCompletion(message, 'AbortError', { reason: 'turn_request_budget_exhausted', message: '预算耗尽' }, { cancelled: true }).errorReason)
      .toBe('turn_request_budget_exhausted');
  });
  test('SDK 正常 resolve 但终态为 error 仍然报告失败', () => {
    const result = modelTurnCompletion({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider failed' });
    expect(result.error).toBe('provider failed');
    expect(result.errorReason).toBe('model_request_failed');
  });
  test('预算拒绝的稳定原因优先于 SDK 重试包装', () => {
    const result = modelTurnCompletion(null, 'Connection error', { reason: 'turn_request_budget_exhausted', message: '单轮预算耗尽' });
    expect(result.errorReason).toBe('turn_request_budget_exhausted');
    expect(result.error).toBe('单轮预算耗尽');
  });
  test('只使用本轮终态，不引用历史助手回复', () => {
    expect(modelTurnCompletion(null).reply).toBe('');
    expect(modelTurnCompletion({ content: [{ type: 'text', text: '当前回复' }], stopReason: 'stop' })).toEqual({ reply: '当前回复', error: null, errorReason: null });
  });
  test('思考块不进入回复，正文里的标记原样保留', () => {
    const result = modelTurnCompletion({
      content: [
        { type: 'thinking', thinking: 'internal draft' },
        { type: 'text', text: '<thinking>draft</thinking>可见答复' },
      ],
      stopReason: 'stop',
    });
    expect(result).toEqual({ reply: '<thinking>draft</thinking>可见答复', error: null, errorReason: null });
  });
});
