import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { assistantProposalProgress, assistantProposalText } from "@/pages/canvas/canvas-assistant-copy";
import type { AssistantGenerationProposal, AssistantTurn } from "@/services/api/agent-assistant";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

const proposal: AssistantGenerationProposal = {
    proposalId:"gp-film",kind:"image",nodeIds:["frame"],model:"image",modelKey:"custom::image",
    production:{targets:[
        {nodeId:"frame",title:"首帧",kind:"image",modelKey:"custom::image",prompt:"晨光洒进花店",parameters:{size:"9:16",count:"1"},referenceNodeIds:[]},
        {nodeId:"speech",title:"中文旁白",kind:"audio",modelKey:"custom::speech",prompt:"把春天带回家。",parameters:{audioVoice:"female-tianmei",audioSpeed:"1",audioFormat:"mp3"},referenceNodeIds:[]},
    ]},source:{canvasId:"canvas",canvasRevision:1,modelConfigRevision:1},
};
test("confirmation shows the paid text, voice, aspect ratio and quantity",()=>{
    const text=assistantProposalText(proposal);
    for(const expected of ["晨光洒进花店","把春天带回家。","female-tianmei","9:16","1 个","预计费用","重新计费"]) expect(text).toContain(expected);
    const progress=assistantProposalProgress(proposal,[]);
    expect(progress.ready).toBe(false);
    expect(progress.text).toContain("0/2");
});
test("production confirmation estimates per-shot and total video price from catalog quotes",()=>{
    const config: AiConfig = {
        ...defaultConfig,
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            apiFormat: "openai",
            baseUrl: "https://beefapi.com",
            apiKey: "",
            models: ["minimax-h3-max-turbo", "gpt-image-1.5", "speech-2.8-hd"],
            modelProfiles: [{
                model: "minimax-h3-max-turbo",
                capability: "video",
                protocol: "newapi",
                videoPricing: {
                    currency: "CNY",
                    mode: "seconds",
                    rates: { "1080p": { output: 0.43, reference_video: 0 } },
                    reference_image: 0.215,
                    free_reference_images: 5,
                },
            }],
        }],
    };
    const fullProposal: AssistantGenerationProposal = {
        proposalId: "gp-h3",
        kind: "image",
        nodeIds: ["img-1", "img-2"],
        model: "gpt-image-1.5",
        modelKey: "beefapi::gpt-image-1.5",
        production: {
            targets: [
                { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", modelKey: "beefapi::gpt-image-1.5", prompt: "镜头1首帧", parameters: { size: "16:9", count: "1" }, referenceNodeIds: [] },
                { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头1视频", parameters: { size: "16:9", vquality: "1080p", seconds: "6", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "vid-2", title: "分镜2-5s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头2视频", parameters: { size: "16:9", vquality: "1080p", seconds: "5", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "tts-1", title: "旁白1", kind: "audio", modelKey: "beefapi::speech-2.8-hd", prompt: "旁白台词", parameters: { audioVoice: "male-qn-qingse", count: "1" }, referenceNodeIds: [] },
            ],
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
    };
    const text = assistantProposalText(fullProposal, [], true, config);
    expect(text).toContain("预计费用：视频 2 段（共 11 秒）约 ¥4.73；1 张图片、1 段配音按所选渠道单价结算");
    expect(text).toContain("预计费用：¥2.58（1080p ¥0.43/秒 × 6秒）");
    expect(text).toContain("预计费用：¥2.15（1080p ¥0.43/秒 × 5秒）");
});
test("proposal card reflects started progress when Pi confirms and admits tasks on canvas nodes",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-1",
        userText: "开始制作",
        selectedNodeIds: [],
        reply: "请确认方案",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-26",
        proposals: [proposal],
        proposalsInvalidated: true,
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[{
                id: "frame",
                type: "image",
                title: "首帧",
                x: 0,
                y: 0,
                width: 320,
                height: 180,
                metadata: {
                    status: "loading",
                    taskStatus: "running",
                    taskClientOperationId: "proposal:gp-film:frame",
                },
            }]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).not.toContain("已失效");
    expect(html).toContain("生成中，0/2 个结果已就绪。");
});
test("started production does not ask the user to manually continue the next step",()=>{
    const turn:AssistantTurn={turnId:"film",userText:"做短片",selectedNodeIds:[],reply:"",toolCalls:[],change:null,error:null,cancelled:false,createdAt:"2026-10-19",proposals:[proposal]};
    const html=renderToStaticMarkup(<CanvasAssistantTurnView turn={turn} handledProposals={new Set([proposal.proposalId])} nodes={[]}
        onLocate={()=>{}} onUndo={()=>{}} onRunProposal={()=>{}} onDismissProposal={()=>{}} onCheckResults={()=>{}} />);
    expect(html).not.toContain("填入检查要求");
    expect(html).not.toContain(">检查结果<");
    expect(html).toContain("0/2");
});
test("production proposal card collapses per-item target details by default while keeping overview and confirm action visible",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-collapsed",
        userText: "做一支花店短片",
        selectedNodeIds: [],
        reply: "已为你准备好花店短片方案。",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-28",
        proposals: [proposal],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).toContain("已为你准备好花店短片方案。");
    expect(html).toContain("整片制作方案：1 张图片、0 段视频、1 段配音");
    expect(html).toContain("<details class=\"canvas-assistant-proposal-details\"><summary>查看 2 项镜头与提示词明细</summary>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("确认并制作整片");
});
test("legacy proposal without turn reply shows proposal note inside the card without pretending to be a model reply",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-legacy-note",
        userText: "把首帧改成 9:16",
        selectedNodeIds: [],
        reply: "",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-28",
        proposals: [{ ...proposal, note: "已将首帧调整为竖屏 9:16。" }],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).not.toContain("canvas-assistant-reply");
    expect(html).toContain("canvas-assistant-proposal-note");
    expect(html).toContain("已将首帧调整为竖屏 9:16。");
});
test("assistantProposalProgress treats retrievable failed and fetching tasks as running until ready and bound",()=>{
    const withOutcome = (meta: Record<string, unknown>) => meta as NonNullable<Parameters<typeof assistantProposalProgress>[1][number]["metadata"]>;
    const inFlight = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "error",
                taskStatus: "failed",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "image_recovery_pending" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "loading",
                taskStatus: "succeeded",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "fetching", regenerate: "blocked", reason: "result_fetching" },
            }),
        },
    ]);
    expect(inFlight.ready).toBe(false);
    expect(inFlight.text).toBe("生成中，0/2 个结果已就绪。");

    const allReady = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:frame-1",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:speech-1",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
    ]);
    expect(allReady.ready).toBe(true);
    expect(allReady.text).toContain("2 个素材已保存");

    const settledWithFailure = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "error",
                taskStatus: "failed",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "no_result" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:speech-1",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
    ]);
    expect(settledWithFailure.ready).toBe(true);
    expect(settledWithFailure.text).toBe("1 个结果已就绪，1 个结果因任务失败或取消而未生成。");
});

test("ordinary proposal with generation order targets renders collapsible order details", () => {
    const ordinaryWithOrder: AssistantGenerationProposal = {
        proposalId: "gp-order-1",
        orderId: "gp-order-1",
        kind: "image",
        nodeIds: ["shot-1"],
        model: "gpt-image-1.5",
        modelKey: "beefapi::gpt-image-1.5",
        pricing: "unknown",
        approvalMode: "ask",
        status: "pending",
        targets: [{
            nodeId: "shot-1",
            title: "镜头1",
            kind: "image",
            model: "gpt-image-1.5",
            modelKey: "beefapi::gpt-image-1.5",
            pricing: "unknown",
            prompt: "雨夜霓虹街角，主角回头",
            parameters: { size: "16:9", count: "1" },
            referenceNodeIds: [],
        }],
    };
    const turn: AssistantTurn = {
        turnId: "turn-order-1",
        userText: "生成镜头1的首帧",
        selectedNodeIds: ["shot-1"],
        reply: "已开出生成单，请确认。",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-11-01",
        proposals: [ordinaryWithOrder],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).toContain("<details class=\"canvas-assistant-proposal-details\"><summary>查看 1 项生成单明细</summary>");
    expect(html).toContain("雨夜霓虹街角，主角回头");
    expect(html).toContain("报价：未知（按所选渠道实际标准计费）");
});
