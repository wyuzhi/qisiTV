export declare const PLUGIN_API_VERSION = "beeftv.plugin/v1";
export declare const PLUGIN_API_VERSION_V2 = "beeftv.plugin/v2";
export declare const PLUGIN_API_VERSION_V3 = "beeftv.plugin/v3";

export type PluginApiVersion =
  | typeof PLUGIN_API_VERSION
  | typeof PLUGIN_API_VERSION_V2
  | typeof PLUGIN_API_VERSION_V3;

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
  | "external.open";

export type EditorPluginPermission =
  | "timeline.read"
  | "timeline.command"
  | "export.run";

export type AnyPluginPermission = PluginPermission | EditorPluginPermission;

export type PluginSurface = "node" | "fullscreen" | "hybrid" | "asset-source" | "settings";
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ProtocolScope = "admin.system-channel" | "user.custom-channel" | "canvas" | "creation" | "agent" | string;
export type PluginRuntime = "declarative" | "client" | "sandbox" | "worker" | "trusted-backend";

export type PluginField = {
  name?: string;
  key?: string;
  type: "string" | "text" | "number" | "boolean" | "secret" | "url" | "select" | "json";
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  defaultValue?: string | number | boolean;
  description?: string;
  values?: string[];
  options?: Array<{ label: string; value: string }>;
};

export type PluginParameter = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  values?: string[];
  mapping?: string;
};

export type PluginProviderOperation = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  defaultPathPrefix?: string;
  contentType?: string;
  fields?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type PluginProviderContribution = {
  id: string;
  label: string;
  capabilities: ProtocolCapability[];
  scopes: ProtocolScope[];
  baseUrl?: string;
  requiresPublicMediaUrls?: boolean;
  auth?: { type: "bearer" | "api-key" | "custom"; field: string; header?: string };
  parameters?: PluginParameter[];
  variables?: Array<{ name: string; value: unknown }>;
  validations?: Array<{ assert: unknown; message: string }>;
  create: PluginProviderOperation;
  poll?: PluginProviderOperation;
  result?: PluginProviderOperation;
  cancel?: PluginProviderOperation;
  response: Record<string, unknown>;
};

export type PluginWorkflowContribution = {
  id: string;
  label: string;
  providerId: string;
  capability: ProtocolCapability;
  parameters: PluginParameter[];
  defaults?: Record<string, string | number | boolean>;
};

export type PluginCanvasNodeInputKind = "image" | "video" | "audio" | "text";

export type PluginCanvasNodeContribution = {
  id?: string;
  type?: string;
  label?: string;
  title?: string;
  defaultTitle?: string;
  description?: string;
  defaultSize?: { width: number; height: number };
  defaultWidth?: number;
  defaultHeight?: number;
  schema?: Record<string, unknown>;
  renderer?: "declarative" | "client" | "sandbox";
  acceptsInputKind?: PluginCanvasNodeInputKind | PluginCanvasNodeInputKind[];
  maxInputCount?: number;
  showOutputConnection?: boolean;
};

export type PluginTransformContribution = {
  id: string;
  input: "media" | "generation";
  output: "provider-request" | "media";
  runtime: PluginRuntime;
};

export type PluginContributions = {
  providers?: PluginProviderContribution[];
  workflows?: PluginWorkflowContribution[];
  canvasNodes?: PluginCanvasNodeContribution[];
  editorSlots?: EditorSlotContribution[];
  transforms?: PluginTransformContribution[];
  commands?: Array<{ id: string; label: string; shortcut?: string }>;
  assetSources?: string[];
  usageObservers?: string[];
  aiCapabilities?: string[];
  agents?: string[];
  importExport?: string[];
};

export type PluginManifest = {
  apiVersion?: PluginApiVersion;
  schemaVersion?: number;
  id?: string;
  name: string;
  version?: string;
  publishedAt?: string;
  updatedAt?: string;
  description: string;
  documentation?: string;
  author?: string;
  entry?: string;
  client?: string;
  surfaces?: PluginSurface[];
  permissions?: AnyPluginPermission[];
  trusted?: boolean;
  configuration?: { fields: PluginField[] };
  runtime?: { backend?: PluginRuntime; web?: PluginRuntime };
  canvasNodes?: PluginCanvasNodeContribution[];
  contributes?: PluginContributions;
};

export type PluginStorage = {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
};

export type PluginCanvasNodeProps<TPluginData = Record<string, unknown>> = {
  node: {
    id: string;
    type: string;
    title: string;
    position: { x: number; y: number };
    size?: { width: number; height: number };
    metadata?: {
      content?: string;
      prompt?: string;
      pluginId?: string;
      pluginNodeId?: string;
      pluginData?: TPluginData;
      [key: string]: unknown;
    };
  };
  theme: {
    mode?: "light" | "dark";
    node: {
      bg: string;
      border: string;
      text: string;
      placeholder: string;
      [key: string]: string;
    };
    [key: string]: unknown;
  };
  host?: BeefTVPluginHost;
  updateNodeData?: (patch: Partial<TPluginData>) => void | Promise<void>;
  onContentChange?: (nodeId: string, content: string) => void;
};

export type PluginInstallConfirmRequest = {
  name: string;
  packageName: string;
  version?: string;
  description?: string;
  author?: string;
  source: string;
  sourceLabel?: string;
  registry?: string;
  permissions?: AnyPluginPermission[];
  trusted?: boolean;
};

export type CanvasNodeSlotContribution = PluginCanvasNodeContribution & {
  render?: (props: PluginCanvasNodeProps) => unknown;
  component?: (props: PluginCanvasNodeProps) => unknown;
};

export type CanvasAddNodeMenuSlotContribution = {
  id: string;
  label: string;
  title?: string;
  description?: string;
  icon?: unknown;
  badge?: string;
  nodeType?: string;
  section?: "node" | "workflow" | "project" | "resource";
  defaultOrder?: number;
  onSelect?: (context: Record<string, unknown>) => void;
  run?: (context: Record<string, unknown>) => void;
};

export type CanvasToolbarSlotContribution = {
  id: string;
  label: string | ((ctx: Record<string, unknown>) => string);
  title?: string;
  icon?: unknown;
  category?: string;
  defaultVisible?: boolean;
  defaultOrder?: number;
  applicable?: (ctx: Record<string, unknown>) => boolean;
  disabled?: (ctx: Record<string, unknown>) => boolean;
  active?: (ctx: Record<string, unknown>) => boolean;
  onClick?: (ctx: Record<string, unknown>) => void;
  run?: (ctx: Record<string, unknown>) => void;
};

export type CanvasContextMenuSlotContribution = {
  id: string;
  label: string;
  icon?: unknown;
  target?: "canvas" | "node" | "both";
  order?: number;
  applicable?: (ctx: { node?: Record<string, unknown>; position?: { x: number; y: number } }) => boolean;
  onSelect?: (ctx: { node?: Record<string, unknown>; position?: { x: number; y: number } }) => void;
  run?: (ctx: { node?: Record<string, unknown>; position?: { x: number; y: number } }) => void;
};

export type CanvasNodePanelSlotContribution = {
  id: string;
  title: string;
  label?: string;
  nodeTypes?: string[];
  order?: number;
  render: (props: { node: Record<string, unknown>; pluginId: string }) => unknown;
};

export type CanvasPromptActionsSlotContribution = {
  id: string;
  label: string;
  icon?: unknown;
  order?: number;
  onClick?: (ctx: {
    prompt: string;
    setPrompt: (nextPrompt: string) => void;
    node?: Record<string, unknown>;
    generationMode?: "image" | "video" | "audio";
  }) => void | Promise<void>;
  render?: (props: {
    prompt: string;
    setPrompt: (nextPrompt: string) => void;
    node?: Record<string, unknown>;
    generationMode?: "image" | "video" | "audio";
  }) => unknown;
};

export type CanvasSidePanelSlotContribution = {
  id: string;
  label: string;
  title?: string;
  icon?: unknown;
  order?: number;
  render: (props: { canvasId?: string; projectId?: string; pluginId: string }) => unknown;
};

export type GenerationBeforeSubmitPatch = {
  prompt?: string;
  parameters?: Record<string, unknown>;
  reason?: string;
};

export type GenerationBeforeSubmitSlotContribution = {
  id: string;
  label: string;
  order?: number;
  transform: (input: {
    nodeId?: string;
    kind: "image" | "video" | "audio";
    model?: string;
    prompt: string;
    parameters?: Record<string, unknown>;
  }) => GenerationBeforeSubmitPatch | null | undefined | Promise<GenerationBeforeSubmitPatch | null | undefined>;
};

export type EditorSlotRenderContribution = {
  id?: string;
  label?: string;
  title?: string;
  priority?: number;
  render: (context: { pluginId: string; slot?: string }) => unknown;
};

export type AssetsSourceSlotContribution = {
  id: string;
  label: string;
  description?: string;
  icon?: unknown;
  listFolders?: (signal?: AbortSignal) => Promise<Array<{ id: string; name: string; parentId?: string }>>;
  list?: (query: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  importAsset?: (item: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  render?: (props: { pluginId: string }) => unknown;
};

export type AssetsItemActionsSlotContribution = {
  id: string;
  label: string;
  icon?: unknown;
  order?: number;
  applicable?: (asset: Record<string, unknown>) => boolean;
  onSelect: (asset: Record<string, unknown>) => void | Promise<void>;
};

export type AppPageSlotContribution = {
  id: string;
  path?: string;
  title: string;
  label?: string;
  render: (props: { pluginId: string; path?: string }) => unknown;
};

export type AppSidebarSlotContribution = {
  id: string;
  label: string;
  path: string;
  icon?: unknown;
  order?: number;
};

export type AppCommandSlotContribution = {
  id: string;
  label: string;
  shortcut?: string;
  keywords?: string[];
  onSelect?: () => void | Promise<void>;
  run?: () => void | Promise<void>;
};

export type AppSettingsSlotContribution = {
  id: string;
  title?: string;
  label?: string;
  render: (props: {
    pluginId: string;
    config: Record<string, string | number | boolean>;
    onChange: (nextConfig: Record<string, string | number | boolean>) => void | Promise<void>;
  }) => unknown;
};

export type PluginCenterSectionSlotContribution = {
  id: string;
  label: string;
  description?: string;
  icon?: unknown;
  order?: number;
  render: (props: {
    pluginId: string;
    requestInstallPlugin?: (req: PluginInstallConfirmRequest) => void | Promise<void>;
    refreshPlugins?: () => Promise<void>;
  }) => unknown;
};

export type ProjectViewSlotContribution = {
  id: string;
  label: string;
  title?: string;
  icon?: unknown;
  order?: number;
  render: (props: { projectId: string; pluginId: string }) => unknown;
};

export type AssistantToolCardSlotContribution = {
  id?: string;
  toolName: string;
  label?: string;
  render: (props: {
    toolName: string;
    args?: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    status?: "running" | "completed" | "error";
  }) => unknown;
};

export interface BeefTVSlotMap {
  "canvas.node": CanvasNodeSlotContribution;
  "canvas.addNodeMenu": CanvasAddNodeMenuSlotContribution;
  "canvas.toolbar.main": CanvasToolbarSlotContribution;
  "canvas.toolbar.selection": CanvasToolbarSlotContribution;
  "canvas.toolbar.nodeHover": CanvasToolbarSlotContribution;
  "canvas.contextMenu": CanvasContextMenuSlotContribution;
  "canvas.nodePanel": CanvasNodePanelSlotContribution;
  "canvas.promptActions": CanvasPromptActionsSlotContribution;
  "canvas.sidePanel": CanvasSidePanelSlotContribution;
  "generation.beforeSubmit": GenerationBeforeSubmitSlotContribution;
  "editor.timeline-panel": EditorSlotRenderContribution;
  "editor.preview-renderer": EditorSlotRenderContribution;
  "editor.inspector": EditorSlotRenderContribution;
  "editor.asset-ingest": EditorSlotRenderContribution;
  "editor.subtitle-tool": EditorSlotRenderContribution;
  "editor.transcription-provider": EditorSlotRenderContribution;
  "editor.export-renderer": EditorSlotRenderContribution;
  "editor.ai-assistant": EditorSlotRenderContribution;
  "assets.source": AssetsSourceSlotContribution;
  "assets.itemActions": AssetsItemActionsSlotContribution;
  "app.page": AppPageSlotContribution;
  "app.sidebar": AppSidebarSlotContribution;
  "app.command": AppCommandSlotContribution;
  "app.settings": AppSettingsSlotContribution;
  "pluginCenter.section": PluginCenterSectionSlotContribution;
  "project.view": ProjectViewSlotContribution;
  "assistant.toolCard": AssistantToolCardSlotContribution;
}

export type BeefTVSlotName = keyof BeefTVSlotMap;

export interface BeefTVEventMap {
  "canvas.opened": { canvasId: string; projectId?: string; revision?: number };
  "canvas.changed": { canvasId: string; revision: number; nodeCount?: number; edgeCount?: number };
  "canvas.selectionChanged": { canvasId?: string; selectedNodeIds: string[] };
  "generation.submitted": { canvasId?: string; nodeIds: string[]; taskIds?: string[]; kind?: "image" | "video" | "audio" };
  "generation.completed": { canvasId?: string; nodeId?: string; taskId: string; kind?: "image" | "video" | "audio" };
  "generation.failed": { canvasId?: string; nodeId?: string; taskId?: string; reason?: string; message?: string };
  "assets.imported": { assetIds: string[]; source?: string };
  "assistant.turnCompleted": { canvasId?: string; turnId: string; status?: string };
}

export type BeefTVEventName = keyof BeefTVEventMap;

export interface BeefTVPluginHost {
  readonly pluginId: string;
  readonly apiVersion: PluginApiVersion;
  readonly React: typeof import("react");
  contribute<K extends BeefTVSlotName>(slot: K, payload: BeefTVSlotMap[K]): () => void;
  ops: {
    call<TResult = unknown>(
      operation: string,
      params: Record<string, unknown>,
      options?: { opId?: string; signal?: AbortSignal }
    ): Promise<{
      op: string;
      opId?: string;
      replayed: boolean;
      result: TResult;
      revision?: number;
    }>;
  };
  events: {
    on<K extends BeefTVEventName>(
      event: K,
      handler: (payload: BeefTVEventMap[K]) => void
    ): () => void;
    emit?<K extends BeefTVEventName>(event: K, payload: BeefTVEventMap[K]): void;
  };
  ui: {
    React: typeof import("react");
    theme: {
      mode: "light" | "dark";
      tokens?: Record<string, string | number>;
    };
    notify: (message: string, type?: "info" | "success" | "warning" | "error") => void;
    requestInstallPlugin?: (req: PluginInstallConfirmRequest) => void | Promise<void>;
    [key: string]: unknown;
  };
  storage: PluginStorage;
  config: {
    get<T = string | number | boolean>(key: string, defaultValue?: T): T | undefined;
    all(): Readonly<Record<string, string | number | boolean>>;
  };
  context: {
    getCanvasId(): string | undefined;
    getCanvasRevision(): number | undefined;
    getSelectedNodeIds(): string[];
    getProjectId(): string | undefined;
    getThemeMode(): "light" | "dark";
  };
}

export type PiToolExecutionResult = {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  isError: boolean;
  result: {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    structuredContent?: unknown;
  };
  durationMs?: number;
};

export interface PiToolContext {
  cwd: string;
  hasUI: boolean;
  mode: string;
  signal?: AbortSignal;
  executeTool(name: string, args: Record<string, unknown>): Promise<PiToolExecutionResult>;
}

export interface PiToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  prepareArguments?: (args: unknown) => TParams;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: PiToolContext
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
}

export interface PiExtensionAPI {
  registerTool<TParams = Record<string, unknown>>(definition: PiToolDefinition<TParams>): void;
}

export declare const BEEFTV_SLOTS: readonly BeefTVSlotName[];
export declare const BEEFTV_EVENTS: readonly BeefTVEventName[];

export declare function definePlugin(
  activate: (host: BeefTVPluginHost) => void | (() => void) | Promise<void | (() => void)>
): (host: BeefTVPluginHost) => void | (() => void) | Promise<void | (() => void)>;

export declare function definePiExtension(
  register: (pi: PiExtensionAPI) => void | Promise<void>
): (pi: PiExtensionAPI) => void | Promise<void>;

export default definePlugin;
