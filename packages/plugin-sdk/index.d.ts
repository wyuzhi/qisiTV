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

/** One settings field. The settings form shows it; read the saved value with `host.config.get(name)`. */
export type PluginField = {
  name: string;
  type: "string" | "number" | "boolean" | "secret" | "url" | "select" | "json";
  label?: string;
  required?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  description?: string;
  /** Choices for `type: "select"`. */
  values?: string[];
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

/** How BeefTV sends the key. `none` is for services without one; users can leave the key empty. */
export type PluginProviderAuth = {
  type: "none" | "bearer" | "header" | "api-key" | "query" | "basic";
  /** Which key to send: `apiKey` or `secretKey`. */
  field?: string;
  secretField?: string;
  header?: string;
  prefix?: string;
  query?: string;
  username?: string;
};

type PluginProviderBase = {
  id: string;
  label: string;
  capabilities: ProtocolCapability[];
  scopes: ProtocolScope[];
  baseUrl?: string;
  requiresPublicMediaUrls?: boolean;
  auth?: PluginProviderAuth;
  parameters?: PluginParameter[];
};

/** A generation service described as HTTP requests; BeefTV sends them. */
export type PluginHttpProviderContribution = PluginProviderBase & {
  variables?: Array<{ name: string; value: unknown }>;
  validations?: Array<{ assert: unknown; message: string }>;
  create: PluginProviderOperation;
  poll?: PluginProviderOperation;
  result?: PluginProviderOperation;
  cancel?: PluginProviderOperation;
  response: Record<string, unknown>;
};

/**
 * A generation service implemented in JavaScript. `module` is a `.js` or `.mjs` path inside
 * the package to a file that exports `submit` and `query` (see `ProviderModule`).
 * Only image, video and audio are supported.
 */
export type PluginModuleProviderContribution = Omit<PluginProviderBase, "capabilities"> & {
  capabilities: Array<Exclude<ProtocolCapability, "text">>;
  module: string;
};

export type PluginProviderContribution = PluginHttpProviderContribution | PluginModuleProviderContribution;

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
  /** Node type; unique within the plugin. */
  id: string;
  /** Name in the add-node menu. */
  label: string;
  /** Title of a newly added node. */
  defaultTitle: string;
  description?: string;
  defaultSize?: { width: number; height: number };
  schema?: Record<string, unknown>;
  fields?: PluginField[];
  /** `"client"` draws the node with the `canvas.node` slot from the plugin's client code. */
  renderer?: "declarative" | "client";
  acceptsInputKind?: PluginCanvasNodeInputKind | PluginCanvasNodeInputKind[];
  maxInputCount?: number;
  showOutputConnection?: boolean;
};

export type PluginContributions = {
  providers?: PluginProviderContribution[];
  workflows?: PluginWorkflowContribution[];
  canvasNodes?: PluginCanvasNodeContribution[];
};

/**
 * The `beeftv` block of package.json. The plugin ID, version, description and author come
 * from package.json's own `name`, `version`, `description` and `author`. Assistant skills
 * and extensions go in package.json's `pi` block. BeefTV refuses to install a package whose
 * `beeftv` block has keys other than these and says how to fix each one.
 */
export type PluginManifest = {
  /** Name shown in BeefTV; defaults to package.json's `name`. */
  name?: string;
  /** Browser entry, a relative path such as `./client/index.js`. */
  client?: string;
  surfaces?: PluginSurface[];
  permissions?: AnyPluginPermission[];
  configuration?: { fields: PluginField[] };
  contributes?: PluginContributions;
};

export type MediaReference = {
  id?: string;
  url?: string;
  dataUrl?: string;
  kind?: string;
  role?: string;
  mimeType?: string;
  name?: string;
  order?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
};

/** What BeefTV passes to `submit` and `query`. Provider-specific values are in `extra`. */
export type GenerationRequest = {
  capability?: ProtocolCapability;
  model: string;
  prompt?: string;
  instructions?: string;
  messages?: Array<{ role: string; content: unknown }>;
  inputs?: MediaReference[];
  images?: MediaReference[];
  videos?: MediaReference[];
  audios?: MediaReference[];
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  imageCount?: number;
  operation?: string;
  output?: Record<string, unknown>;
  providerOptions?: Record<string, Record<string, unknown>>;
  /** `extra.idempotencyKey` stays the same if BeefTV has to submit the same task again. */
  extra?: Record<string, unknown>;
};

export type GenerationResult = {
  images?: MediaReference[];
  videos?: MediaReference[];
  audios?: MediaReference[];
  text?: string;
  usage?: Record<string, unknown>;
};

export type GenerationTaskState = {
  taskId?: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "cancelled";
  /** Required once `status` is `"succeeded"`. BeefTV downloads the media URLs into the workspace. */
  result?: GenerationResult;
  /** Shown to the user when the task failed. */
  message?: string;
};

export type ProviderModuleContext = {
  /** The channel the user picked: its base URL and API key. */
  config: { baseUrl?: string; apiKey?: string };
  /** Aborted when BeefTV stops this call, for example when the user cancels the task. */
  signal: AbortSignal;
  /** Writes a line to the BeefTV backend log. Do not log keys. */
  log(message: string): void;
};

/** One entry of `ProviderModule.models`. `capability` may be left out when the provider has only one. */
export type ProviderModel = {
  id: string;
  displayName?: string;
  capability?: Exclude<ProtocolCapability, "text">;
};

/**
 * The file a `module` provider points to. It runs in a Node process next to the BeefTV
 * backend, so it can use fetch and Node built-ins.
 *
 * - `submit` starts a task and returns its `taskId`, or the final result when the service
 *   answers at once. If `submit` throws, BeefTV cannot tell whether the task was created
 *   and does not retry.
 * - `query` is called until the task finishes, including after BeefTV restarts. If it throws,
 *   BeefTV tries again later; three throws in a row fail the task with the last error's message.
 * - `models` is optional. When the user adds this service under model services and clicks
 *   "读取模型", BeefTV calls it with the address and key they entered. Without it, users
 *   type model IDs by hand.
 *
 * BeefTV does not ask the service to cancel a task; cancelling only stops BeefTV waiting.
 */
export type ProviderModule = {
  submit(request: GenerationRequest, ctx: ProviderModuleContext): GenerationTaskState | Promise<GenerationTaskState>;
  query(taskId: string, request: GenerationRequest, ctx: ProviderModuleContext): GenerationTaskState | Promise<GenerationTaskState>;
  models?(ctx: ProviderModuleContext): ProviderModel[] | Promise<ProviderModel[]>;
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
  /** npm spec, local package directory, or the name of a sample shipped with BeefTV. */
  source: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  /** "https://registry.npmmirror.com" (default) or "https://registry.npmjs.org". */
  registry?: string;
  isUpdate?: boolean;
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

/** Rewrite the prompt or attach metadata; model parameters stay as the user set them. */
export type GenerationBeforeSubmitPatch = {
  prompt?: string;
  metadata?: Record<string, unknown>;
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
  "generation.submitted": { nodeId: string; nodeType: string; model?: string; prompt: string; taskId?: string };
  "generation.completed": { nodeId: string; nodeType: string };
  "generation.failed": { nodeId: string; nodeType: string; error: string; taskId?: string };
  "assets.imported": { assets: Array<{ id: string; name: string; type: string; url: string }> };
  "assistant.turnCompleted": { canvasId?: string; sessionId?: string; turnId?: string; status: "completed" | "failed" | "cancelled" };
}

export type BeefTVEventName = keyof BeefTVEventMap;

export interface BeefTVPluginHost {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** The host's React; plugins must not bundle their own copy. */
  readonly React: typeof import("react");
  contribute<K extends BeefTVSlotName>(slot: K, payload: BeefTVSlotMap[K]): () => void;
  events: {
    on<K extends BeefTVEventName>(event: K, handler: (payload: BeefTVEventMap[K]) => void): () => void;
    emit<K extends BeefTVEventName>(event: K, payload: BeefTVEventMap[K]): void;
  };
  storage: PluginStorage;
  config: {
    getAll(): Record<string, string | number | boolean>;
    get<T extends string | number | boolean = string>(key: string, fallback?: T): T | undefined;
    set(patch: Record<string, string | number | boolean>): Promise<void>;
  };
  ui: {
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
    navigate(path: string): void;
    /** Opens the host install confirmation; nothing installs without the user's confirmation. */
    requestInstallPlugin(request: PluginInstallConfirmRequest): void;
  };
  /** Business operations, the same set the CLI, MCP and assistant use; resolves to the operation result. */
  ops: {
    call<T = unknown>(op: string, params?: Record<string, unknown>): Promise<T>;
  };
  context: {
    /** Canvas currently open in the workspace. Read its revision with the canvas.get operation. */
    getCanvasId(): string | undefined;
  };
  assets: {
    list(): unknown[];
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

export declare function defineProvider<T extends ProviderModule>(module: T): T;

export declare function definePiExtension(
  register: (pi: PiExtensionAPI) => void | Promise<void>
): (pi: PiExtensionAPI) => void | Promise<void>;

export default definePlugin;
