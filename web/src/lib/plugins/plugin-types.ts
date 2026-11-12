import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";

export const PLUGIN_API_VERSION = "qisitv.plugin/v1" as const;
export const PLUGIN_API_VERSION_V2 = "qisitv.plugin/v2" as const;
export const PLUGIN_API_VERSION_V3 = "qisitv.plugin/v3" as const;

export type EditorSlotKind =
    | "timeline-panel"
    | "preview-renderer"
    | "inspector"
    | "asset-ingest"
    | "subtitle-tool"
    | "transcription-provider"
    | "export-renderer"
    | "ai-assistant";

export type EditorSlotContribution = {
    slot: EditorSlotKind;
    priority?: number;
};

export type EditorPluginPermission = "timeline.read" | "timeline.command" | "export.run";

export type PluginContributionsV2 = PluginContributions & {
    editorSlots?: EditorSlotContribution[];
};

// 注意：必须把 permissions 一并 Omit 掉再完全替换，否则数组交叉类型会被归约为 v1 的 PluginPermission[]，v2 权限字面量无法赋值。
export type PluginManifestV2 = Omit<PluginManifest, "apiVersion" | "contributes" | "permissions"> & {
    // v3 keeps the v2 UI schema and adds backend provider expressions/streams.
    apiVersion: typeof PLUGIN_API_VERSION_V2 | typeof PLUGIN_API_VERSION_V3;
    permissions: Array<PluginPermission | EditorPluginPermission>;
    contributes: PluginContributionsV2;
};

export type PluginContributionKind = "provider" | "workflow" | "canvas-node";
export type PluginSurface = "node" | "fullscreen" | "hybrid" | "asset-source" | "settings";
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ProtocolScope = "admin.system-channel" | "user.custom-channel" | "canvas" | "creation" | "agent" | string;
export type PluginField = {
    name: string;
    type: "string" | "number" | "boolean" | "secret" | "url" | "select" | "json";
    label?: string;
    required?: boolean;
    default?: string | number | boolean;
    description?: string;
    values?: string[];
};
export type PluginParameter = {
    name: string;
    type: string;
    required?: boolean;
    description?: string;
    values?: string[];
    min?: number;
    max?: number;
    mapping?: string;
};
export type PluginProviderOperation = {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    contentType?: string;
    fields?: Record<string, string>;
};
export type PluginProviderContribution = {
    id: string;
    label: string;
    capabilities: ProtocolCapability[];
    scopes: ProtocolScope[];
    baseUrl?: string;
    auth?: { type: "bearer" | "api-key" | "custom"; field: string; header?: string };
    parameters?: PluginParameter[];
    create: PluginProviderOperation;
    poll?: PluginProviderOperation;
    cancel?: PluginProviderOperation;
    response: {
        taskIdPaths?: string[];
        statusPaths?: string[];
        messagePaths?: string[];
        textPaths?: string[];
        reasoningPaths?: string[];
        resultPaths?: string[];
        resultKind?: "image" | "video" | "audio";
        resultEphemeral?: boolean;
        /** 业务成功码；只有声明它的协议生效，命中的 errorPaths 值不算失败。 */
        successCodes?: Array<string | number>;
    };
};
export type PluginWorkflowContribution = {
    id: string;
    label: string;
    providerId: string;
    capability: ProtocolCapability;
    parameters: PluginParameter[];
    defaults?: Record<string, string | number | boolean>;
};
export type PluginCanvasNodeContribution = {
    id: string;
    label: string;
    defaultTitle: string;
    defaultSize: { width: number; height: number };
    schema: Record<string, unknown>;
    renderer?: "declarative" | "client";
    /** Optional input contract for nodes that consume one or more media kinds. */
    acceptsInputKind?: "image" | "video" | "audio" | "text" | Array<"image" | "video" | "audio" | "text">;
    /** Optional maximum number of direct inputs. */
    maxInputCount?: number;
    /** Analysis/sink nodes can hide the right-side output connection. */
    showOutputConnection?: boolean;
};
export type PluginContributions = {
    providers?: PluginProviderContribution[];
    workflows?: PluginWorkflowContribution[];
    canvasNodes?: PluginCanvasNodeContribution[];
};
export type PluginPermission =
    | "canvas.read"
    | "canvas.write"
    | "asset.read"
    | "asset.search"
    | "asset.import"
    | "asset.upload"
    | "generation.run"
    | "ai.text"
    | "media.read"
    | "usage.read"
    | "external.open"
    | "ui.slot"
    | "settings.write";

export type PluginManifest = {
    apiVersion: typeof PLUGIN_API_VERSION;
    id: string;
    name: string;
    version: string;
    publishedAt?: string;
    updatedAt?: string;
    description: string;
    documentation?: string;
    author?: string;
    client?: string;
    surfaces?: PluginSurface[];
    permissions: PluginPermission[];
    trusted?: boolean;
    /** npm 插件安装内容的指纹，由后端给出；同版本重新安装后也会变。 */
    revision?: string;
    configuration?: { fields: PluginField[] };
    contributes: PluginContributions;
};

export type PluginStorage = {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
};

export type PluginTextContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type PluginTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | PluginTextContentPart[];
};

export type PluginTextTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type PluginTextToolChoice = "auto" | "required" | { type: "function"; name: string };

export type PluginTextToolCall = {
    name: string;
    arguments: string;
};

export type PluginTextResponse = {
    content: string;
    toolCalls: PluginTextToolCall[];
};

export type PluginTextRequest = {
    model?: string;
    messages: PluginTextMessage[];
    tools?: PluginTextTool[];
    toolChoice?: PluginTextToolChoice;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

export type PluginAiTextService = {
    requestToolResponse: (request: PluginTextRequest) => Promise<PluginTextResponse>;
};

export type PluginHostServices = {
    ai?: {
        text?: PluginAiTextService;
    };
    media?: {
        resolve: (reference: { url?: string; dataUrl?: string; kind?: string }, signal?: AbortSignal) => Promise<{ dataUrl: string; mimeType: string }>;
    };
    usage?: {
        list: (scope?: string) => Promise<ReadonlyArray<Record<string, unknown>>>;
    };
};

export type PluginHostContext = {
    manifest: PluginManifest | PluginManifestV2;
    permissions: ReadonlySet<PluginPermission | EditorPluginPermission>;
    storage: PluginStorage;
    config: Readonly<PluginInstallation["config"]>;
    services?: PluginHostServices;
};

export type PromptOptimizationMode = "expand" | "refine" | "style" | "model-adapt" | "reference";

export type PromptOptimizationInput = {
    prompt: string;
    mode: PromptOptimizationMode;
    generationMode: "image" | "video";
    targetModel?: string;
    targetProtocol?: string;
    optimizerModel?: string;
    context?: {
        texts?: Array<{ title: string; text: string }>;
        images?: Array<{ title: string; url: string }>;
    };
};

export type PromptOptimizationVariant = {
    label: string;
    prompt: string;
};

export type PromptOptimizationResult = {
    optimizedPrompt: string;
    negativePrompt: string;
    changes: string[];
    assumptions: string[];
    variants: PromptOptimizationVariant[];
    modelProfile?: { id: string; label: string };
};

export type PromptOptimizerProvider = {
    optimize: (input: PromptOptimizationInput, options?: { signal?: AbortSignal; onDelta?: (text: string) => void }) => Promise<PromptOptimizationResult>;
};

export type AssetSourceQuery = {
    keyword?: string;
    folderId?: string;
    tags?: string[];
    kind?: Asset["kind"];
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
};

export type ExternalAssetFolder = {
    id: string;
    name: string;
    parentId?: string;
};

export type ExternalAssetItem = {
    id: string;
    title: string;
    kind: Asset["kind"];
    thumbnailUrl?: string;
    fileUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    tags?: string[];
    folderId?: string;
    folderIds?: string[];
    folderPath?: string[];
    description?: string;
    metadata?: Record<string, unknown>;
};

export type ExternalAssetPickerReference = {
    sourceId: string;
    sourceName: string;
    item: ExternalAssetItem;
};

export type AssetSourceProvider = {
    listFolders?: (signal?: AbortSignal) => Promise<ExternalAssetFolder[]>;
    list?: (query: AssetSourceQuery) => Promise<ExternalAssetItem[]>;
    importAsset?: (item: ExternalAssetItem, signal?: AbortSignal) => Promise<Asset>;
    uploadAsset?: (asset: Asset, signal?: AbortSignal) => Promise<ExternalAssetItem>;
    uploadAssetToFolder?: (asset: Asset, folderId?: string, signal?: AbortSignal) => Promise<ExternalAssetItem>;
    uploadFile?: (file: File, folderId?: string, signal?: AbortSignal) => Promise<ExternalAssetItem>;
    createFolder?: (name: string, parentId?: string) => Promise<void>;
    openAsset?: (item: ExternalAssetItem) => Promise<void>;
};

export type PluginAgentAction = {
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** Pure planner: validate input and return operations, never perform side effects here. */
    buildOperations: (input: Record<string, unknown>, snapshot: import("@/lib/canvas/canvas-operation-contract").CanvasSnapshot) => import("@/lib/canvas/canvas-operation-contract").CanvasOperation[];
};

export type RegisteredPlugin = {
    agentActions?: PluginAgentAction[];
    /** Pure, bounded projection: never return embedded media or provider credentials. */
    readAgentNode?: (node: import("@/types/canvas").CanvasNodeData, snapshot: import("@/lib/canvas/canvas-operation-contract").CanvasSnapshot) => Record<string, unknown>;
    /** v1 或 v2 插件清单；v2 清单结构为 v1 超集（含 editorSlots 声明）。 */
    manifest: PluginManifest | PluginManifestV2;
    source?: "bundled" | "uploaded" | string;
    activate?: (context: PluginHostContext) => Promise<void> | void;
    deactivate?: (context: PluginHostContext) => Promise<void> | void;
    setup?: (host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void;
    createAssetSource?: (context: PluginHostContext) => AssetSourceProvider;
    createPromptOptimizer?: (context: PluginHostContext) => PromptOptimizerProvider;
    /** v2 插件由注册器从 manifest 提取的编辑器插槽声明（v1 插件无此字段）。 */
    editorSlots?: EditorSlotContribution[];
    /** v2 插件 UI 插槽的实际渲染函数由插件 activate() 阶段经 registerEditorSlot 提供。 */
};

export type PluginInstallation = {
    manifest: PluginManifest | PluginManifestV2;
    enabled: boolean;
    config: Record<string, string | number | boolean>;
    installedAt: string;
    updatedAt: string;
    lastError?: string;
};

// ── Section 5.2: 27 Frontend UI Extension Slots ──────────────────────────────

export type PluginCanvasNodeProps = {
    node: CanvasNodeData;
    nodeId: string;
    selected: boolean;
    theme: "light" | "dark";
    data: Record<string, unknown>;
    updateData: (patch: Record<string, unknown>) => void;
    updateContent: (content: string) => void;
};

export type PluginCanvasNodeSlotContribution = {
    type: string;
    label: string;
    defaultTitle?: string;
    icon?: ReactNode;
    defaultSize?: { width: number; height: number };
    ports?: { inputs?: string[]; outputs?: string[] };
    component?: ComponentType<PluginCanvasNodeProps>;
    schema?: Record<string, unknown>;
    category?: "creation" | "source" | "annotation" | "plugin";
    allowCreateFromMenu?: boolean;
    acceptsInputKind?: "image" | "video" | "audio" | "text" | Array<"image" | "video" | "audio" | "text">;
    maxInputCount?: number;
    showOutputConnection?: boolean;
};

export type PluginCanvasAddNodeMenuContext = {
    projectId?: string;
    canvasId?: string;
    position: { x: number; y: number };
    createNode: (input: {
        type: string;
        position?: { x: number; y: number };
        size?: { width: number; height: number };
        content?: string;
        metadata?: Record<string, unknown>;
    }) => Promise<string | null> | string | null;
};

export type PluginCanvasAddNodeMenuContribution = {
    id: string;
    label: string;
    description?: string;
    icon?: ReactNode;
    group?: string;
    keywords?: string[];
    order?: number;
    onSelect: (ctx: PluginCanvasAddNodeMenuContext) => void | Promise<void>;
};

export type CanvasToolContext = {
    projectId?: string;
    canvasId?: string;
    selectedNodeIds: string[];
    selectedNodes: CanvasNodeData[];
    hoveredNode?: CanvasNodeData | null;
};

export type CanvasToolDescriptor = {
    id: string;
    label: string;
    icon?: ReactNode;
    order?: number;
    shortcut?: string;
    when?: (ctx: CanvasToolContext) => boolean;
    onClick?: (ctx: CanvasToolContext) => void | Promise<void>;
    render?: ComponentType<CanvasToolContext>;
};

export type PluginCanvasContextMenuContext = {
    projectId?: string;
    canvasId?: string;
    target: "canvas" | "node" | "selection";
    node?: CanvasNodeData | null;
    selectedNodeIds: string[];
    selectedNodes: CanvasNodeData[];
    position: { x: number; y: number };
};

export type PluginCanvasContextMenuContribution = {
    id: string;
    label: string;
    icon?: ReactNode;
    shortcut?: string;
    order?: number;
    when?: (ctx: PluginCanvasContextMenuContext) => boolean;
    onSelect: (ctx: PluginCanvasContextMenuContext) => void | Promise<void>;
};

export type PluginCanvasNodePanelProps = {
    node: CanvasNodeData;
    updateNode: (patch: Partial<CanvasNodeData>) => void;
    updateMetadata: (patch: Record<string, unknown>) => void;
};

export type PluginCanvasNodePanelContribution = {
    id: string;
    title: string;
    nodeTypes?: string[];
    order?: number;
    component: ComponentType<PluginCanvasNodePanelProps>;
};

export type PluginCanvasSidePanelProps = {
    projectId?: string;
    canvasId?: string;
    selectedNodeIds: string[];
};

export type PluginCanvasSidePanelContribution = {
    id: string;
    title: string;
    icon?: ReactNode;
    order?: number;
    component: ComponentType<PluginCanvasSidePanelProps>;
};

export type PluginPromptActionProps = {
    nodeId: string;
    nodeType: "image" | "video" | "audio" | "text";
    prompt: string;
    setPrompt: (nextPrompt: string) => void;
    model?: string;
    aspectRatio?: string;
    referenceImages?: string[];
    disabled?: boolean;
};

export type PluginPromptActionContribution = {
    id: string;
    label: string;
    icon?: ReactNode;
    order?: number;
    nodeTypes?: Array<"image" | "video" | "audio" | "text">;
    onClick?: (ctx: PluginPromptActionProps) => void | Promise<void>;
    component?: ComponentType<PluginPromptActionProps>;
};

export type GenerationSubmitContext = {
    nodeId: string;
    nodeType: "image" | "video" | "audio";
    prompt: string;
    model?: string;
    params: Record<string, unknown>;
    referenceImages?: string[];
    metadata?: Record<string, unknown>;
};

/** A plugin may rewrite the prompt and attach metadata; model parameters stay as the user set them. */
export type GenerationSubmitPatch = {
    prompt?: string;
    metadata?: Record<string, unknown>;
};

export type PluginGenerationBeforeSubmitContribution = {
    id: string;
    order?: number;
    nodeTypes?: Array<"image" | "video" | "audio">;
    transform: (ctx: GenerationSubmitContext) => Promise<GenerationSubmitPatch | void> | GenerationSubmitPatch | void;
};

export type PluginAssistantToolCardProps = {
    toolName: string;
    status: string;
    input?: Record<string, unknown>;
    output?: unknown;
    error?: string;
};

export type PluginAssistantToolCardContribution = {
    toolName: string;
    component: ComponentType<PluginAssistantToolCardProps>;
};

export type PluginAssetSourceContribution = {
    id: string;
    name: string;
    description?: string;
    provider: AssetSourceProvider;
};

export type PluginAssetItemActionContext = {
    asset: Asset;
};

export type PluginAssetItemActionContribution = {
    id: string;
    label: string;
    icon?: ReactNode;
    order?: number;
    when?: (ctx: PluginAssetItemActionContext) => boolean;
    onSelect: (ctx: PluginAssetItemActionContext) => void | Promise<void>;
};

export type PluginEditorSlotContribution = {
    id: string;
    title: string;
    order?: number;
    render: (context: { projectId: string; currentTimeMs: number }) => ReactNode;
};

export type PluginAppPageProps = {
    pluginId: string;
    subpath: string;
};

export type PluginAppPageContribution = {
    path?: string;
    title: string;
    icon?: ReactNode;
    component: ComponentType<PluginAppPageProps>;
};

export type PluginAppSidebarContribution = {
    id: string;
    label: string;
    path: string;
    icon?: ReactNode;
    badge?: string;
    order?: number;
};

export type PluginAppCommandContribution = {
    id: string;
    title: string;
    subtitle?: string;
    keywords?: string[];
    shortcut?: string;
    icon?: ReactNode;
    handler: () => void | Promise<void>;
};

export type PluginAppSettingsProps = {
    pluginId: string;
    config: Record<string, string | number | boolean>;
    updateConfig: (patch: Record<string, string | number | boolean>) => Promise<void>;
};

export type PluginAppSettingsContribution = {
    title?: string;
    component: ComponentType<PluginAppSettingsProps>;
};

export type PluginProjectViewProps = {
    projectId: string;
};

export type PluginProjectViewContribution = {
    id: string;
    label: string;
    icon?: ReactNode;
    order?: number;
    component: ComponentType<PluginProjectViewProps>;
};

export type PluginCardProps = {
    name: string;
    description: string;
    sourceLabel: string;
    status: string;
    onOpen: MouseEventHandler<HTMLButtonElement>;
    openLabel?: string;
    actions: ReactNode;
    children?: ReactNode;
    "data-testid"?: string;
};

export type PluginCenterSectionProps = {
    Card: ComponentType<PluginCardProps>;
    Button: typeof import("antd").Button;
    DetailsModal: ComponentType<import("antd").ModalProps & { flush?: boolean; scrollBody?: boolean }>;
    Markdown: ComponentType<{ source: string; className?: string }>;
    RegistrySelect: typeof import("antd").Select;
    pluginId: string;
    installedPlugins?: RegisteredPlugin[];
    pluginStates?: Record<string, unknown>;
    reloadPlugins?: () => Promise<void> | void;
    requestInstallPlugin?: (req: PluginInstallConfirmRequest) => void;
};

export type PluginCenterSectionContribution = {
    id: string;
    label: string;
    description?: string;
    icon?: ReactNode;
    order?: number;
    component: ComponentType<PluginCenterSectionProps>;
    render?: ComponentType<PluginCenterSectionProps>;
};

export type PluginSlotMap = {
    "canvas.node": PluginCanvasNodeSlotContribution;
    "canvas.addNodeMenu": PluginCanvasAddNodeMenuContribution;
    "canvas.toolbar.main": CanvasToolDescriptor;
    "canvas.toolbar.selection": CanvasToolDescriptor;
    "canvas.toolbar.nodeHover": CanvasToolDescriptor;
    "canvas.contextMenu": PluginCanvasContextMenuContribution;
    "canvas.nodePanel": PluginCanvasNodePanelContribution;
    "canvas.sidePanel": PluginCanvasSidePanelContribution;
    "canvas.promptActions": PluginPromptActionContribution;
    "generation.beforeSubmit": PluginGenerationBeforeSubmitContribution;
    "assistant.toolCard": PluginAssistantToolCardContribution;
    "assets.source": PluginAssetSourceContribution;
    "assets.itemActions": PluginAssetItemActionContribution;
    "editor.leftSidebar.panels": PluginEditorSlotContribution;
    "editor.rightInspector.sections": PluginEditorSlotContribution;
    "editor.bottomDock.tabs": PluginEditorSlotContribution;
    "editor.previewOverlay": PluginEditorSlotContribution;
    "editor.timeline.trackHeaders": PluginEditorSlotContribution;
    "editor.timeline.clipOverlays": PluginEditorSlotContribution;
    "editor.toolbar.actions": PluginEditorSlotContribution;
    "editor.contextMenu.items": PluginEditorSlotContribution;
    "editor.timeline-panel": PluginEditorSlotContribution;
    "editor.preview-renderer": PluginEditorSlotContribution;
    "editor.inspector": PluginEditorSlotContribution;
    "editor.asset-ingest": PluginEditorSlotContribution;
    "editor.subtitle-tool": PluginEditorSlotContribution;
    "editor.transcription-provider": PluginEditorSlotContribution;
    "editor.export-renderer": PluginEditorSlotContribution;
    "editor.ai-assistant": PluginEditorSlotContribution;
    "app.page": PluginAppPageContribution;
    "app.sidebar": PluginAppSidebarContribution;
    "app.command": PluginAppCommandContribution;
    "app.settings": PluginAppSettingsContribution;
    "project.view": PluginProjectViewContribution;
    "pluginCenter.section": PluginCenterSectionContribution;
};

export type PluginSlotName = keyof PluginSlotMap;

// ── Section 5.3: 5 Frontend Plugin Events ────────────────────────────────────

export type PluginEventMap = {
    "generation.submitted": { nodeId: string; nodeType: string; model?: string; prompt: string; taskId?: string };
    "generation.completed": { nodeId: string; nodeType: string };
    "generation.failed": { nodeId: string; nodeType: string; error: string; taskId?: string };
    "assets.imported": { assets: Array<{ id: string; name: string; type: string; url: string }> };
    "assistant.turnCompleted": { canvasId?: string; sessionId?: string; turnId?: string; status: "completed" | "failed" | "cancelled" };
};

export type PluginEventName = keyof PluginEventMap;

// ── Section 5.1 / 2.3: Host SDK & Install Confirmation Types ─────────────────

/** What the host install confirmation needs; Go reads the real package before committing. */
export type PluginInstallConfirmRequest = {
    /** npm spec, local package directory, or the name of a sample shipped with BeefTV. */
    source: string;
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    /** npm registry chosen in the market: npmmirror or npmjs. */
    registry?: string;
    isUpdate?: boolean;
};

export type BeefTVPluginHost = {
    pluginId: string;
    manifest: PluginManifest | PluginManifestV2;
    React: typeof import("react");
    contribute: <K extends PluginSlotName>(slot: K, payload: PluginSlotMap[K]) => () => void;
    events: {
        on: <E extends PluginEventName>(event: E, handler: (payload: PluginEventMap[E]) => void) => () => void;
        emit: <E extends PluginEventName>(event: E, payload: PluginEventMap[E]) => void;
    };
    storage: PluginStorage;
    config: {
        getAll: () => Record<string, string | number | boolean>;
        get: <T extends string | number | boolean = string>(key: string, fallback?: T) => T | undefined;
        set: (patch: Record<string, string | number | boolean>) => Promise<void>;
    };
    ui: {
        notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
        navigate: (path: string) => void;
        /** Opens the host install confirmation; nothing installs without the user's confirmation. */
        requestInstallPlugin: (request: PluginInstallConfirmRequest) => void;
    };
    /** Business operations, the same set the CLI, MCP and assistant use. Writes go through here only. */
    ops: {
        call: <T = unknown>(op: string, params?: Record<string, unknown>) => Promise<T>;
    };
    context: {
        /** Canvas currently open in the workspace, from the route. */
        getCanvasId: () => string | undefined;
    };
    assets: {
        list: () => Asset[];
    };
    channels?: {
        list: () => Array<Record<string, unknown>>;
        upsert: (channel: Record<string, unknown>) => Promise<Record<string, unknown>>;
        fetchCatalog?: (params: { baseUrl: string; apiKey: string; apiFormat?: string }) => Promise<{ models: string[] }>;
    };
};
