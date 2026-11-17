import { App as AntApp, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { CanvasHistoryStackFrame } from "../../src/components/canvas/canvas-node-history-stack";
import { CanvasNodeInfoModal } from "../../src/components/canvas/canvas-node-toolbar";
import { CanvasImageViewerModal } from "../../src/components/canvas/image-viewer/canvas-image-viewer-modal";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { canvasThemes } from "../../src/lib/canvas-theme";
import {
    activeImageHistoryIndex,
    executePrimaryImageHistorySwitch,
    removeCanvasImageHistoryItem,
    resolveCanvasNodeImageHistory,
    syncDiscoveredCanvasNodeHistory,
} from "../../src/lib/canvas/canvas-image-history";
import { applyNodeConfigPatch } from "../../src/lib/canvas/canvas-project-domain";
import { RESOURCE_BLOB_META_STORE_NAME, RESOURCE_BLOBS_STORE_NAME, localForageInstance } from "../../src/lib/localforage-storage";
import { deliveryPendingTaskOutcome } from "../../src/lib/task-outcome";
import { getActiveUserScope } from "../../src/lib/user-scope";
import type { Asset } from "../../src/stores/use-asset-store";
import { useActiveTheme, useCanvasThemeStore } from "../../src/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData, type CanvasNodeMetadata } from "../../src/types/canvas";

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
});

const initialAssets: Asset[] = [
    {
        id: "asset-v1",
        kind: "image",
        title: "v1",
        tags: [],
        createdAt: "2026-11-16T08:00:00.000Z",
        updatedAt: "2026-11-16T08:00:00.000Z",
        data: { dataUrl: "/img/v1.svg", storageKey: "resource:res-v1", width: 1600, height: 900 },
    },
    {
        id: "asset-v2",
        kind: "image",
        title: "v2",
        tags: [],
        createdAt: "2026-11-16T08:05:00.000Z",
        updatedAt: "2026-11-16T08:05:00.000Z",
        data: { dataUrl: "/img/v2.svg", storageKey: "resource:res-v2", width: 900, height: 1600 },
    },
    {
        id: "asset-v3",
        kind: "image",
        title: "v3",
        tags: [],
        createdAt: "2026-11-16T08:10:00.000Z",
        updatedAt: "2026-11-16T08:10:00.000Z",
        data: { dataUrl: "/img/v3.svg", storageKey: "resource:res-v3", width: 2100, height: 900 },
    },
];

const initialNode: CanvasNodeData = {
    id: "node-viewer-test",
    type: CanvasNodeType.Image,
    title: "测试分镜图",
    position: { x: 100, y: 100 },
    width: 420,
    height: 180,
    metadata: {
        status: "success",
        content: "/img/v3.svg",
        storageKey: "resource:res-v3",
        assetId: "asset-v3",
        naturalWidth: 2100,
        naturalHeight: 900,
        bytes: 61440,
        mimeType: "image/webp",
        model: "model-v3",
        size: "21:9",
        quality: "1K",
        prompt: "PROMPT V3 WIDE SHOT",
        taskId: "task-v3",
        taskCompletedAt: "2026-11-16T08:10:00.000Z",
        imageHistory: [
            {
                id: "task-v1:0",
                taskId: "task-v1",
                outputIndex: 0,
                storageKey: "resource:res-v1",
                content: "/img/v1.svg",
                assetId: "asset-v1",
                naturalWidth: 1600,
                naturalHeight: 900,
                bytes: 81920,
                mimeType: "image/png",
                model: "model-v1",
                size: "16:9",
                quality: "2K",
                prompt: "PROMPT V1 LANDSCAPE",
                createdAt: "2026-11-16T08:00:00.000Z",
            },
            {
                id: "task-v2:0",
                taskId: "task-v2",
                outputIndex: 0,
                storageKey: "resource:res-v2",
                content: "/img/v2.svg",
                assetId: "asset-v2",
                naturalWidth: 900,
                naturalHeight: 1600,
                bytes: 71680,
                mimeType: "image/png",
                model: "model-v2",
                size: "9:16",
                quality: "2K",
                prompt: "PROMPT V2 PORTRAIT",
                createdAt: "2026-11-16T08:05:00.000Z",
            },
            {
                id: "task-v3:0",
                taskId: "task-v3",
                outputIndex: 0,
                storageKey: "resource:res-v3",
                content: "/img/v3.svg",
                assetId: "asset-v3",
                naturalWidth: 2100,
                naturalHeight: 900,
                bytes: 61440,
                mimeType: "image/webp",
                model: "model-v3",
                size: "21:9",
                quality: "1K",
                prompt: "PROMPT V3 WIDE SHOT",
                createdAt: "2026-11-16T08:10:00.000Z",
            },
        ],
    },
};

declare global {
    interface Window {
        __viewerHarness?: {
            getNode: () => CanvasNodeData;
            getLastAppliedPatch: () => Partial<CanvasNodeMetadata> | null;
            getEvents: () => string[];
            getOpenedNodeInfoId: () => string | null;
            setEnsureMode: (mode: "ok" | "fail") => void;
            setNodeStatus: (mode: "normal" | "loading" | "retrievable") => void;
            setColorTheme: (theme: "dark" | "light") => void;
            setReadOnly: (value: boolean) => void;
            loadStandaloneProtectedSrc: (src: string) => void;
            loadProtectedPeekAndZeroSizeNode: () => void;
            loadFailedSingleShotNode: () => void;
            load50VersionColdNode: () => void;
            load50VersionNodeWithPrimedPreviews: () => Promise<void>;
            loadPrimedPreviewPermFailNode: (resId?: string) => Promise<void>;
            reopen: () => void;
        };
    }
}

const previewBlobStore = localForageInstance(RESOURCE_BLOBS_STORE_NAME);
const previewMetaStore = localForageInstance(RESOURCE_BLOB_META_STORE_NAME);

function HarnessApp() {
    const [node, setNode] = useState<CanvasNodeData>(initialNode);
    const nodeRef = useRef<CanvasNodeData>(initialNode);
    nodeRef.current = node;
    const assetsRef = useRef<Asset[]>([...initialAssets]);
    const ensureModeRef = useRef<"ok" | "fail">("ok");
    const eventsRef = useRef<string[]>([]);
    const [open, setOpen] = useState(true);
    const [readOnly, setReadOnlyState] = useState(false);
    const [standaloneSrc, setStandaloneSrc] = useState<string | null>(null);
    const [lastPatch, setLastPatch] = useState<Partial<CanvasNodeMetadata> | null>(null);
    const [openedNodeInfoId, setOpenedNodeInfoId] = useState<string | null>(null);
    const colorTheme = useActiveTheme();

    window.__viewerHarness = {
        getNode: () => nodeRef.current,
        getLastAppliedPatch: () => lastPatch,
        getEvents: () => [...eventsRef.current],
        getOpenedNodeInfoId: () => openedNodeInfoId,
        setEnsureMode: (mode) => {
            ensureModeRef.current = mode;
        },
        setColorTheme: (theme) => {
            useCanvasThemeStore.setState({ active: true, theme, followGlobal: false });
        },
        setReadOnly: (value) => {
            setReadOnlyState(value);
        },
        loadStandaloneProtectedSrc: (src) => {
            setStandaloneSrc(src);
            setOpen(true);
        },
        loadProtectedPeekAndZeroSizeNode: () => {
            setStandaloneSrc(null);
            const protectedNode: CanvasNodeData = {
                id: "node-protected-peek",
                type: CanvasNodeType.Image,
                title: "受保护资源节点",
                position: { x: 100, y: 100 },
                width: 420,
                height: 240,
                metadata: {
                    status: "success",
                    content: "/api/resources/res-prot-primary/file",
                    storageKey: "resource:res-prot-primary",
                    assetId: "asset-prot-primary",
                    imageHistoryResetAt: "2026-11-16T08:00:00.000Z",
                    imageHistory: [
                        {
                            id: "task-zero:0",
                            taskId: "task-zero",
                            outputIndex: 0,
                            storageKey: "resource:res-zero-size",
                            content: "/api/resources/res-zero-size/file",
                            assetId: "asset-zero",
                            prompt: "ZERO SIZE SECONDARY",
                            model: "model-zero",
                        },
                        {
                            id: "task-prot:0",
                            taskId: "task-prot",
                            outputIndex: 0,
                            storageKey: "resource:res-prot-primary",
                            content: "/api/resources/res-prot-primary/file",
                            assetId: "asset-prot-primary",
                            naturalWidth: 1600,
                            naturalHeight: 900,
                            bytes: 65536,
                            prompt: "PROTECTED PRIMARY SHOT",
                            model: "model-prot",
                        },
                    ],
                },
            };
            nodeRef.current = protectedNode;
            setNode(protectedNode);
            setOpen(true);
        },
        load50VersionColdNode: () => {
            setStandaloneSrc(null);
            const history50: CanvasImageHistoryItem[] = [];
            for (let i = 1; i <= 50; i += 1) {
                const resId = `res-cold-${String(i).padStart(2, "0")}`;
                history50.push({
                    id: `task-cold-${i}:0`,
                    taskId: `task-cold-${i}`,
                    outputIndex: 0,
                    storageKey: `resource:${resId}`,
                    content: `/api/resources/${resId}/file`,
                    assetId: `asset-cold-${i}`,
                    naturalWidth: 2048,
                    naturalHeight: 2048,
                    bytes: 524288,
                    mimeType: "image/png",
                    prompt: `COLD SHOT ${i}`,
                });
            }
            const lastItem = history50[49]!;
            const coldNode: CanvasNodeData = {
                id: "node-cold-50",
                type: CanvasNodeType.Image,
                title: "50版冷缓存测试节点",
                position: { x: 100, y: 100 },
                width: 320,
                height: 320,
                metadata: {
                    status: "success",
                    content: lastItem.content,
                    storageKey: lastItem.storageKey,
                    assetId: lastItem.assetId,
                    naturalWidth: 2048,
                    naturalHeight: 2048,
                    mimeType: "image/png",
                    prompt: lastItem.prompt,
                    taskId: lastItem.taskId,
                    imageHistoryResetAt: "2026-11-16T09:00:00.000Z",
                    imageHistory: history50,
                },
            };
            nodeRef.current = coldNode;
            setNode(coldNode);
            setOpen(true);
        },
        loadFailedSingleShotNode: () => {
            setStandaloneSrc(null);
            const singleFailed: CanvasNodeData = {
                id: "node-failed-single",
                type: CanvasNodeType.Image,
                title: "首轮重做失败节点",
                position: { x: 100, y: 100 },
                width: 420,
                height: 240,
                metadata: {
                    status: "error",
                    errorDetails: "生成失败",
                    imageHistoryResetAt: "2026-11-16T08:00:00.000Z",
                    imageHistory: [
                        {
                            id: "task-v1:0",
                            taskId: "task-v1",
                            outputIndex: 0,
                            storageKey: "resource:res-v1",
                            content: "/img/v1.svg",
                            assetId: "asset-v1",
                            naturalWidth: 1600,
                            naturalHeight: 900,
                            prompt: "SOLE SAVED SHOT V1",
                            model: "model-v1",
                        },
                    ],
                },
            };
            nodeRef.current = singleFailed;
            setNode(singleFailed);
            setOpen(true);
        },
        load50VersionNodeWithPrimedPreviews: async () => {
            setStandaloneSrc(null);
            const scope = getActiveUserScope();
            const thumbSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#0f766e"/></svg>`;
            const thumbBlob = new Blob([thumbSvg], { type: "image/svg+xml" });
            const history50: CanvasImageHistoryItem[] = [];
            const nextAssets: Asset[] = [...initialAssets];
            for (let i = 1; i <= 50; i += 1) {
                const resId = `res-perf-${String(i).padStart(2, "0")}`;
                const assetId = `asset-perf-${String(i).padStart(2, "0")}`;
                const version = "canvas-preview-v2-p3-128";
                const cacheKey = `${scope}:${resId}:${version}`;
                await previewBlobStore.setItem(cacheKey, thumbBlob);
                await previewMetaStore.setItem(cacheKey, {
                    key: cacheKey,
                    userScope: scope,
                    resourceId: resId,
                    version,
                    size: thumbBlob.size,
                    mimeType: thumbBlob.type,
                    lastAccessedAt: Date.now(),
                });
                nextAssets.push({
                    id: assetId,
                    kind: "image",
                    title: `perf-${i}`,
                    tags: [],
                    createdAt: "2026-11-16T09:00:00.000Z",
                    updatedAt: "2026-11-16T09:00:00.000Z",
                    data: { dataUrl: `/api/resources/${resId}/file`, storageKey: `resource:${resId}`, width: 2048, height: 2048 },
                });
                history50.push({
                    id: `task-perf-${i}:0`,
                    taskId: `task-perf-${i}`,
                    outputIndex: 0,
                    storageKey: `resource:${resId}`,
                    content: `/api/resources/${resId}/file`,
                    assetId,
                    naturalWidth: 2048,
                    naturalHeight: 2048,
                    bytes: 524288,
                    mimeType: "image/png",
                    model: "model-perf",
                    size: "1:1",
                    quality: "2K",
                    prompt: `PERF SHOT ${i}`,
                    createdAt: `2026-11-16T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
                });
            }
            assetsRef.current = nextAssets;
            const lastItem = history50[49]!;
            const perfNode: CanvasNodeData = {
                id: "node-perf-50",
                type: CanvasNodeType.Image,
                title: "50版性能测试节点",
                position: { x: 100, y: 100 },
                width: 320,
                height: 320,
                metadata: {
                    status: "success",
                    content: lastItem.content,
                    storageKey: lastItem.storageKey,
                    assetId: lastItem.assetId,
                    naturalWidth: 2048,
                    naturalHeight: 2048,
                    mimeType: "image/png",
                    prompt: lastItem.prompt,
                    taskId: lastItem.taskId,
                    imageHistoryResetAt: "2026-11-16T09:00:00.000Z",
                    imageHistory: history50,
                },
            };
            nodeRef.current = perfNode;
            setNode(perfNode);
            setOpen(true);
        },
        loadPrimedPreviewPermFailNode: async (resId = "res-perm-fail") => {
            setStandaloneSrc(null);
            const scope = getActiveUserScope();
            const thumbSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#b45309"/></svg>`;
            const thumbBlob = new Blob([thumbSvg], { type: "image/svg+xml" });
            const version = "canvas-preview-v2-p3-128";
            const cacheKey = `${scope}:${resId}:${version}`;
            await previewBlobStore.setItem(cacheKey, thumbBlob);
            await previewMetaStore.setItem(cacheKey, {
                key: cacheKey,
                userScope: scope,
                resourceId: resId,
                version,
                size: thumbBlob.size,
                mimeType: thumbBlob.type,
                lastAccessedAt: Date.now(),
            });
            const permFailNode: CanvasNodeData = {
                id: `node-perm-fail-preview-${resId}`,
                type: CanvasNodeType.Image,
                title: "原图失败测试节点",
                position: { x: 100, y: 100 },
                width: 320,
                height: 320,
                metadata: {
                    status: "success",
                    content: "/img/v1.svg",
                    storageKey: "resource:res-v1",
                    assetId: "asset-v1",
                    naturalWidth: 1600,
                    naturalHeight: 900,
                    prompt: "PRIMARY OK V1",
                    imageHistoryResetAt: "2026-11-16T09:10:00.000Z",
                    imageHistory: [
                        {
                            id: "task-perm-fail:0",
                            taskId: "task-perm-fail",
                            outputIndex: 0,
                            storageKey: `resource:${resId}`,
                            content: `/api/resources/${resId}/file`,
                            assetId: "asset-v2",
                            prompt: "PERM FAIL SHOT WITH PRIMED 128 PREVIEW",
                            model: "model-fail",
                        },
                        {
                            id: "task-ok-primary:0",
                            taskId: "task-ok-primary",
                            outputIndex: 0,
                            storageKey: "resource:res-v1",
                            content: "/img/v1.svg",
                            assetId: "asset-v1",
                            naturalWidth: 1600,
                            naturalHeight: 900,
                            prompt: "PRIMARY OK V1",
                            model: "model-v1",
                        },
                    ],
                },
            };
            nodeRef.current = permFailNode;
            setNode(permFailNode);
            setOpen(true);
        },
        reopen: () => setOpen(true),
        setNodeStatus: (mode) => {
            setNode((prev) => {
                let next: CanvasNodeData;
                if (mode === "loading") {
                    next = { ...prev, metadata: { ...prev.metadata, status: "loading" } };
                } else if (mode === "retrievable") {
                    next = {
                        ...prev,
                        metadata: {
                            ...prev.metadata,
                            status: "error",
                            taskStatus: "succeeded",
                            taskOutcome: deliveryPendingTaskOutcome(),
                        },
                    };
                } else {
                    next = {
                        ...prev,
                        metadata: {
                            ...prev.metadata,
                            status: "success",
                            taskOutcome: undefined,
                        },
                    };
                }
                nodeRef.current = next;
                return next;
            });
        },
    };

    const stackItems = resolveCanvasNodeImageHistory(node);
    const stackActiveIdx = activeImageHistoryIndex(node, stackItems);

    return (
        <QueryClientProvider client={queryClient}>
            <ConfigProvider theme={getAntThemeConfig(colorTheme)}>
                <AntApp>
                    <div className="app-user-overlays" />
                    <button type="button" id="outside-trigger" onClick={() => setOpen(true)}>
                        打开预览
                    </button>
                    <div style={{ width: 240, height: 160 }}>
                        <CanvasHistoryStackFrame items={stackItems} activeIndex={stackActiveIdx} theme={canvasThemes[colorTheme]}>
                            <div style={{ width: "100%", height: "100%", background: canvasThemes[colorTheme].node.panel }} />
                        </CanvasHistoryStackFrame>
                    </div>
                    <CanvasImageViewerModal
                        open={open}
                        src={standaloneSrc ?? (node.metadata?.content || "")}
                        alt={standaloneSrc ? "独立附件预览" : node.title}
                        node={standaloneSrc ? undefined : node}
                        projectId="proj-browser-test"
                        readOnly={readOnly}
                        onClose={() => setOpen(false)}
                        onOpenNodeInfo={(nodeId) => setOpenedNodeInfoId(nodeId)}
                        onSelectPrimary={(nodeId, item) =>
                            executePrimaryImageHistorySwitch({
                                nodeId,
                                targetItem: item,
                                getNodes: () => [nodeRef.current],
                                getAssets: () => assetsRef.current,
                                ensureAsset: async (candidateNode) => {
                                    eventsRef.current.push(`ensure:${candidateNode.metadata?.storageKey}:beforeSwap=${nodeRef.current.metadata?.storageKey}`);
                                    await new Promise((resolve) => window.setTimeout(resolve, 15));
                                    if (ensureModeRef.current === "fail") {
                                        return { confirmed: false };
                                    }
                                    const mintedId = "asset-v0-minted";
                                    assetsRef.current = [
                                        ...assetsRef.current,
                                        {
                                            id: mintedId,
                                            kind: "image",
                                            title: "v0",
                                            tags: [],
                                            createdAt: "2026-11-16T07:50:08.000Z",
                                            updatedAt: "2026-11-16T07:50:08.000Z",
                                            data: { dataUrl: "/img/v0.svg", storageKey: "resource:res-v0", width: 1200, height: 900 },
                                        },
                                    ];
                                    return { assetId: mintedId, confirmed: true };
                                },
                                commitNode: (_id, committedNode) => {
                                    eventsRef.current.push(`commit:${committedNode.metadata?.storageKey}:${committedNode.metadata?.assetId}`);
                                    nodeRef.current = committedNode;
                                    setNode(committedNode);
                                },
                                onAssetError: (msg) => {
                                    eventsRef.current.push(`error:${msg}`);
                                },
                                onSuccess: () => {
                                    eventsRef.current.push("success:已设为当前节点主图");
                                },
                            })
                        }
                        onRemoveHistoryItem={(_nodeId, itemId, discovered) => {
                            setNode((prev) => {
                                const next = removeCanvasImageHistoryItem(prev, itemId, assetsRef.current, discovered);
                                nodeRef.current = next;
                                return next;
                            });
                        }}
                        onSyncDiscoveredHistory={(_nodeId, discovered) => {
                            setNode((prev) => {
                                const next = syncDiscoveredCanvasNodeHistory(prev, discovered);
                                nodeRef.current = next;
                                return next;
                            });
                        }}
                        onApplyParameters={(_nodeId, patch) => {
                            setLastPatch(patch);
                            setNode((prev) => {
                                const next = applyNodeConfigPatch(prev, patch);
                                nodeRef.current = next;
                                return next;
                            });
                        }}
                    />
                    <CanvasNodeInfoModal
                        node={openedNodeInfoId ? node : null}
                        open={Boolean(openedNodeInfoId)}
                        readOnly={readOnly}
                        onClose={() => setOpenedNodeInfoId(null)}
                        onMetadataChange={readOnly ? undefined : (_nodeId, patch) => {
                            setNode((prev) => {
                                const next: CanvasNodeData = {
                                    ...prev,
                                    metadata: { ...prev.metadata, ...patch },
                                };
                                nodeRef.current = next;
                                return next;
                            });
                        }}
                    />
                </AntApp>
            </ConfigProvider>
        </QueryClientProvider>
    );
}

createRoot(document.getElementById("root")!).render(<HarnessApp />);
