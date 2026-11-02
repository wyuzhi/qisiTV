import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { useCanvasGenerationExecutor } from "../../src/pages/canvas/use-canvas-generation-executor";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { recordConfirmedCanvasCommit } from "../../src/services/canvas-operation-journal";
import { cacheResourceObjectUrl } from "../../src/services/resource-blob-cache";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "../../src/stores/use-config-store";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "../../src/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "../../src/types/canvas";
import { customerGenerationProject, type CustomerGenerationScenario } from "./customer-generation-scenarios";
import { CanvasNodeGenerationProgress } from "../../src/components/canvas/canvas-node-generation-progress";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { canvasNodeOperation } from "../../src/lib/operation-progress";
import { defaultModelCapabilityConfig } from "../../src/lib/model-capabilities";
import { useOperationProgress } from "../../src/stores/use-operation-progress";
import { configureApiRuntime } from "../../src/services/api/request";
import { CanvasNodePromptPanel } from "../../src/components/canvas/canvas-node-prompt-panel";
import { buildCanvasNodeMentionReferenceMap } from "../../src/lib/canvas/canvas-resource-references";
import { isolateCopiedNodeMetadata } from "../../src/lib/canvas/canvas-node-copy";
import { useCanvasNodeOperations } from "../../src/pages/canvas/use-canvas-node-operations";
import { CanvasGenerationHistoryPicker } from "../../src/components/canvas/canvas-generation-history-picker";
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";
const pageUi = createCanvasPageUiStore();

const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") || "five-images") as CustomerGenerationScenario;
if (scenario === "library-references" || params.has("reference-repair-ui")) configureApiRuntime(location.origin + "/api", "synthetic-desktop-token");
const project = (window as any).__customerProject || customerGenerationProject(scenario);
if (params.has("copied-submission")) {
    const target = project.nodes.find((node: CanvasNodeData) => node.id === "target")!;
    const source = { ...target, id: "original-pending", metadata: { ...target.metadata, status: "loading" as const, taskClientOperationId: "canvas:original", generationSubmissionState: "unknown" as const } };
    project.nodes.push(source);
    target.metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, target.id]]));
}
if (params.has("missing-submission-id") || params.has("known-task-only")) {
    const target = project.nodes.find((node: CanvasNodeData) => node.id === "target")!;
    Object.assign(target.metadata!, { status: "error", generationSubmissionState: "unknown", errorDetails: "页面刷新后本地生成已中断，请重新生成。" });
    if (params.has("known-task-only")) target.metadata!.taskId = "original-customer-task";
}
if (params.has("reference-repair-ui")) {
    project.nodes.push({ ...project.nodes[0], id: "unlinked", title: "未连接的场景图" });
    project.nodes.find((node: CanvasNodeData) => node.id === "target")!.metadata!.composerContent = "保留 @[node:image-1]，参考 @[node:unlinked] 和 @[asset:missing-library]。正文保持不变。";
}
const noop = () => {};
setActiveUserScope("synthetic-customer");
useUserStore.getState().setHydrated(true);
useUserStore.getState().setStorageMode("local");
const selectedModel = params.has("incompatible-model") ? "kling-v2.6" : "seedance-2.5";
const protocol = params.has("incompatible-model") ? "novita-video" : "newapi-channel-2";
const channel = createModelChannel({ id: "synthetic", name: "Synthetic", baseUrl: location.origin + "/upstream", apiKey: "synthetic-not-a-secret", interfaceType: protocol, models: [selectedModel], modelProfiles: [{ model: selectedModel, protocol }] });
if (params.has("long-prompt-limit")) {
    const capabilityConfig = defaultModelCapabilityConfig(protocol, selectedModel);
    capabilityConfig.video!.references.promptMaxChars = 8000;
    channel.modelProfiles = [{ model: selectedModel, protocol, capabilityConfig }];
    project.nodes.find(node => node.id === "target")!.metadata!.composerContent = "镜".repeat(8066);
}
const model = encodeChannelModel(channel.id, selectedModel);
const config = { ...defaultConfig, channels: [channel], model, videoModel: model, videoModels: [model], models: [model], videoSeconds: "5", size: "16:9" };
useConfigStore.getState().replaceConfig(config);
await recordConfirmedCanvasCommit(project);
useCanvasStore.setState({ projects: [project], hydrated: true });
const harness = (window as any).__customer = { settled: false, error: "", messages: [] as string[], controller: undefined as AbortController | undefined, nodes: project.nodes, blocked: [] as Promise<string>[], generate: noop, edit: noop, cancel: noop };
(harness as any).allowLongPrompt = () => {
    channel.modelProfiles![0].capabilityConfig!.video!.references.promptMaxChars = 0;
    useConfigStore.getState().replaceConfig({ ...config });
};
new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes) {
        if (node instanceof HTMLElement && (node.classList.contains("ant-message-notice") || node.querySelector(".ant-message-notice"))) harness.messages.push(node.textContent || "");
    }
}).observe(document.body, { childList: true, subtree: true });

function Harness() {
    const [nodes, setNodesState] = useState<CanvasNodeData[]>(project.nodes);
    const [activeNodeId, setActiveNodeId] = useState("target");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [connections, setConnectionsState] = useState<CanvasConnection[]>(project.connections);
    const target = nodes.find(node => node.id === activeNodeId)!;
    (harness as any).activeNodeId = activeNodeId;
    (harness as any).connections = connections;
    const preparation = useOperationProgress(state => canvasNodeOperation(state.entries, project.id, target.id, target.metadata?.taskId));
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef(project.connections);
    connectionsRef.current = connections;
    const selectedNodeIdsRef = useRef(new Set(["target"]));
    const setConnections = useCallback<Dispatch<SetStateAction<CanvasConnection[]>>>(update => setConnectionsState(current => {
        const next = typeof update === "function" ? update(current) : update;
        connectionsRef.current = next;
        useCanvasStore.getState().updateProject(project.id, { connections: next });
        return next;
    }), []);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>(update => setNodesState(current => {
        const next = typeof update === "function" ? update(current) : update;
        nodesRef.current = next;
        harness.nodes = next;
        useCanvasStore.getState().updateProject(project.id, { nodes: next });
        return next;
    }), []);
    useEffect(() => pageUi.subscribe((state, previous) => {
        if (state.dialogNodeId && state.dialogNodeId !== previous.dialogNodeId) setActiveNodeId(state.dialogNodeId);
    }), []);
    const nodeOperations = useCanvasNodeOperations({ pageUi, projectId: project.id, defaultDrawingEngine: "excalidraw", nodesRef, connectionsRef, selectedNodeIdsRef,
        getCanvasCenter: () => ({ x: 400, y: 300 }), setNodes, setConnections, onNodesDeleted: noop });
    const generation = useCanvasGeneration({ projectId: project.id, domainProjectId: "synthetic-domain", projectLoaded: params.has("recover"), nodes, nodesRef, setNodes });
    const generate = useCanvasGenerationExecutor({ pageUi, projectId: project.id, domainProjectId: "synthetic-domain", addedSkills: [], assets: [], nodesRef, connectionsRef, setNodes, setConnections: noop,
        setRunningNodeId: generation.setRunningNodeId, startGenerationRequest: generation.startGenerationRequest, finishGenerationRequest: generation.finishGenerationRequest, bindGenerationTask: generation.bindGenerationTask, applyGenerationTaskResult: generation.applyGenerationTaskResult });
    harness.generate = async () => {
        harness.settled = false;
        harness.controller = new AbortController();
        const prompt = nodesRef.current.find(node => node.id === activeNodeId)!.metadata!.composerContent!;
        try { await generate(activeNodeId, "video", prompt, { controller: harness.controller }); }
        catch (error) { harness.error = error instanceof Error ? error.message : String(error); }
        finally { harness.settled = true; }
    };
    harness.edit = () => setNodes(current => current.map(node => node.id === "target" ? { ...node, title: "准备期间改过的标题", metadata: { ...node.metadata, composerContent: "准备期间修改的新提示词" } } : node));
    (harness as any).replaceOutput = () => setNodes(current => current.map(node => node.id === "target" ? { ...node, metadata: { ...node.metadata, content: "/api/resources/newer-result/file", storageKey: "resource:newer-result", assetId: "newer-asset", durationMs: 7000 } } : node));
    harness.cancel = () => harness.controller?.abort();
    return <>
        {params.has("reference-repair-ui") || params.has("submission-recovery-ui") ? <CanvasNodePromptPanel
            projectId={project.id} node={target} referenceNodes={nodes} isRunning={Boolean(generation.runningNodeId)}
            referenceConnections={connections}
            mentionReferences={buildCanvasNodeMentionReferenceMap(nodes, connections).get(target.id)}
            onAddReference={(referenceNodeId, reference) => reference.active || reference.assetId ? reference : undefined}
            onPromptChange={(id, composerContent) => setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, composerContent } } : node))}
            onConfigChange={(id, patch) => setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node))}
            onGenerate={() => void harness.generate()}
            onOpenGenerationHistory={() => setHistoryOpen(true)}
            onCreateGenerationReplacement={nodeOperations.createGenerationReplacement}
            onLocateReferenceNode={(id) => { (harness as any).locatedNodeId = id; }}
        /> : null}
        <CanvasGenerationHistoryPicker open={historyOpen} projectId={project.id} onClose={() => setHistoryOpen(false)} onSelect={() => {}} />
        <button onClick={() => void harness.generate()}>生成视频</button>
        <button onClick={() => harness.edit()}>准备期间修改画布</button>
        <button onClick={() => harness.cancel()}>取消准备</button>
        {preparation ? <section aria-label="视频节点"><CanvasNodeGenerationProgress node={target} theme={canvasThemes.dark} operation={preparation} /></section> : null}
        <output data-testid="stage">{nodes.find(node => node.id === "target")?.metadata?.taskStage || "尚未提交"}</output>
        <pre data-testid="snapshot">{JSON.stringify(nodes)}</pre>
    </>;
}
if (params.has("block-cache")) {
    // Queue 16 requests and hold the actual shared scheduler's download slots.
    harness.blocked = Array.from({ length: 16 }, (_, index) => cacheResourceObjectUrl(`resource:blocker-${index}`).catch(() => ""));
}
createRoot(document.getElementById("root")!).render(<App><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider></App>);
